import { readFile } from 'node:fs/promises';
import type { TestSignal } from '../signal/types.js';
import type { FlakehoundReport, GateResult } from './types.js';

/**
 * CI-gate diff. A regression is "new" when absent from the baseline.
 * No baseline → fail-safe: ALL current regressions are new (the gate must
 * never silently pass on a real regression just because history is missing).
 * Known regressions never silently expire — they stay in the report until
 * they actually stop failing (then they surface as resolved).
 */
export function diffAgainstBaseline(
  signals: TestSignal[],
  baseline: FlakehoundReport | undefined,
): GateResult {
  const current = regressionIds(signals);
  if (baseline === undefined) {
    return {
      baselineUsed: false,
      newRegressions: [...current].sort(),
      knownRegressions: [],
      resolvedRegressions: [],
    };
  }

  const prior = regressionIds(baseline.signals);
  return {
    baselineUsed: true,
    newRegressions: [...current].filter((id) => !prior.has(id)).sort(),
    knownRegressions: [...current].filter((id) => prior.has(id)).sort(),
    resolvedRegressions: [...prior].filter((id) => !current.has(id)).sort(),
  };
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
