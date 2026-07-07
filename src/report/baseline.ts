import { readFile } from 'node:fs/promises';
import { normalizeTrace, WeightedJaccardSimilarity } from '../cluster/index.js';
import type { FailureCluster } from '../cluster/index.js';
import type { TestSignal } from '../signal/types.js';
import type { FlakehoundReport, GateResult } from './types.js';

/**
 * CI-gate diff. A regression is "new" when absent from the baseline.
 * No baseline → fail-safe: ALL current regressions are new (the gate must
 * never silently pass on a real regression just because history is missing).
 * Known regressions never silently expire — they stay in the report until
 * they actually stop failing (then they surface as resolved).
 *
 * Cluster novelty (newClusters/knownClusters) rides along informationally —
 * it never affects the exit code.
 */
export function diffAgainstBaseline(
  signals: TestSignal[],
  baseline: FlakehoundReport | undefined,
  clusters: FailureCluster[] = [],
  clusterOptions: ClusterDiffOptions = {},
): GateResult {
  const current = regressionIds(signals);
  const clusterDiff = diffClusters(clusters, baseline, clusterOptions);
  if (baseline === undefined) {
    return {
      baselineUsed: false,
      newRegressions: [...current].sort(),
      knownRegressions: [],
      resolvedRegressions: [],
      ...clusterDiff,
    };
  }

  const prior = regressionIds(baseline.signals);
  return {
    baselineUsed: true,
    newRegressions: [...current].filter((id) => !prior.has(id)).sort(),
    knownRegressions: [...current].filter((id) => prior.has(id)).sort(),
    resolvedRegressions: [...prior].filter((id) => !current.has(id)).sort(),
    ...clusterDiff,
  };
}

export interface ClusterDiffOptions {
  /** Similarity at or above which a drifted representative still matches. */
  similarityThreshold?: number;
}

/**
 * Which failure clusters are NEW since the baseline — "a new unique bug".
 * A current cluster is known when its content-derived id appears in the
 * baseline, or when its representative trace is ≥ threshold similar to a
 * baseline representative (ids are hashes of the representative, so a cluster
 * whose representative drifted — e.g. a new earliest member after pruning —
 * keeps its identity through the similarity match instead of re-alerting).
 * No baseline → fail-safe-consistent: every cluster is new.
 */
export function diffClusters(
  clusters: FailureCluster[],
  baseline: FlakehoundReport | undefined,
  options: ClusterDiffOptions = {},
): { newClusters: string[]; knownClusters: string[] } {
  const threshold = options.similarityThreshold ?? 0.7;
  const baselineClusters = baseline?.clusters;
  if (baselineClusters === undefined || !Array.isArray(baselineClusters)) {
    return { newClusters: clusters.map((c) => c.id).sort(), knownClusters: [] };
  }

  const priorIds = new Set(baselineClusters.map((c) => c.id));
  const metric = new WeightedJaccardSimilarity();
  const priorTraces = baselineClusters.map((c) => normalizeTrace(c.representativeTrace));

  const known: string[] = [];
  const fresh: string[] = [];
  for (const cluster of clusters) {
    const matched =
      priorIds.has(cluster.id) ||
      priorTraces.some(
        (prior) => metric.compare(normalizeTrace(cluster.representativeTrace), prior) >= threshold,
      );
    (matched ? known : fresh).push(cluster.id);
  }
  return { newClusters: fresh.sort(), knownClusters: known.sort() };
}

function regressionIds(signals: TestSignal[]): Set<string> {
  return new Set(
    signals.filter((s) => s.classification === 'regression').map((s) => s.testId),
  );
}

/**
 * Read a previous report to use as the baseline. An unreadable or
 * unrecognizable baseline degrades to undefined (→ fail-safe diff above)
 * with a warning — it never crashes the run.
 */
export async function loadBaseline(
  filePath: string,
  warn: (message: string) => void,
): Promise<FlakehoundReport | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    warn(
      `flakehound: could not read baseline ${filePath} (${detail}) — failing safe: all regressions count as new`,
    );
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { signals?: unknown }).signals)
  ) {
    warn(
      `flakehound: baseline ${filePath} is not a flakehound report — failing safe: all regressions count as new`,
    );
    return undefined;
  }
  return parsed as FlakehoundReport;
}
