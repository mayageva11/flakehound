import { createHash } from 'node:crypto';
import { normalizeTrace } from './normalize.js';
import type { NormalizedTrace } from './normalize.js';
import { JaccardSimilarity } from './similarity.js';
import type { SimilarityMetric } from './similarity.js';

export interface FailureOccurrence {
  testId: string;
  /** ISO 8601 — used for firstSeen/lastSeen. */
  timestamp: string;
  /** Raw stack trace (or error message when no trace is available). */
  trace: string;
}

export interface FailureCluster {
  /** Stable content-derived id (hash of the representative trace). */
  id: string;
  /** Canonical normalized trace of the cluster's first (sorted) member. */
  representativeTrace: string;
  /** Sorted unique testIds affected by this cluster. */
  tests: string[];
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
}

export interface ClusterConfig {
  /** Fixed, defensible threshold — deliberately not adaptive. */
  similarityThreshold: number;
  metric: SimilarityMetric;
}

export const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  similarityThreshold: 0.7,
  metric: new JaccardSimilarity(),
};

/**
 * Deterministic greedy threshold clustering.
 *
 * Why greedy over hierarchical: greedy assignment yields deterministic
 * output and ~O(n) average cost — the identical-trace hash short-circuit
 * collapses the common case (same bug, different line numbers → identical
 * canonical string) before any pairwise comparison, so the greedy pass runs
 * over unique traces only. The cost is order-sensitivity, mitigated by
 * pre-sorting failures on (canonical, timestamp, testId) so shuffled input
 * always produces byte-identical clusters. Hierarchical (e.g. average-link)
 * clustering would be somewhat more accurate at cluster boundaries but is
 * O(n²), and non-deterministic without careful tie-breaking; for a CI tool,
 * predictable + fast wins.
 */
export function clusterFailures(
  failures: FailureOccurrence[],
  overrides: Partial<ClusterConfig> = {},
): FailureCluster[] {
  const config: ClusterConfig = { ...DEFAULT_CLUSTER_CONFIG, ...overrides };

  const entries = failures.map((occurrence) => ({
    occurrence,
    normalized: normalizeTrace(occurrence.trace),
  }));
  // Determinism is mandatory: sort before clustering so input order never
  // affects the result.
  entries.sort(
    (a, b) =>
      a.normalized.canonical.localeCompare(b.normalized.canonical) ||
      a.occurrence.timestamp.localeCompare(b.occurrence.timestamp) ||
      a.occurrence.testId.localeCompare(b.occurrence.testId),
  );

  // Short-circuit: identical canonical strings always co-cluster, and the
  // greedy pass below only ever compares unique traces.
  const byCanonical = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = byCanonical.get(entry.normalized.canonical);
    if (group === undefined) byCanonical.set(entry.normalized.canonical, [entry]);
    else group.push(entry);
  }

  interface ProtoCluster {
    representative: NormalizedTrace;
    members: typeof entries;
  }
  const clusters: ProtoCluster[] = [];
  for (const group of byCanonical.values()) {
    const tokens = group[0]!.normalized.tokens;
    const home = clusters.find(
      (cluster) =>
        config.metric.compare(cluster.representative.tokens, tokens) >=
        config.similarityThreshold,
    );
    if (home !== undefined) home.members.push(...group);
    else clusters.push({ representative: group[0]!.normalized, members: [...group] });
  }

  return clusters.map((cluster) => toFailureCluster(cluster.representative, cluster.members));
}

function toFailureCluster(
  representative: NormalizedTrace,
  members: { occurrence: FailureOccurrence }[],
): FailureCluster {
  const tests = [...new Set(members.map((m) => m.occurrence.testId))].sort();
  const timestamps = members.map((m) => m.occurrence.timestamp).sort();
  return {
    id: clusterId(representative.canonical),
    representativeTrace: representative.canonical,
    tests,
    firstSeen: timestamps[0]!,
    lastSeen: timestamps[timestamps.length - 1]!,
    occurrences: members.length,
  };
}

/** Content-derived id: stable across runs as long as the representative is. */
function clusterId(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}
