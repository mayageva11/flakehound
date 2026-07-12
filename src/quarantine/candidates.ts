import type { FlakehoundReport } from '../report/types.js';
import type { TestSignal } from '../signal/types.js';
import type { QuarantineConfig, QuarantineEntry, QuarantineState } from './types.js';

/**
 * Unset scoreThreshold mirrors the signal layer's own flaky threshold, so the
 * two never drift apart when a user tunes signal.flakinessThreshold. Setting
 * quarantine.scoreThreshold higher makes quarantining stricter than detection.
 */
export function resolveScoreThreshold(
  quarantine: QuarantineConfig,
  signalFlakinessThreshold: number,
): number {
  return quarantine.scoreThreshold ?? signalFlakinessThreshold;
}

/**
 * Tests to quarantine now: classified flaky with high confidence at or above
 * the threshold, not already quarantined, and not on the critical list.
 * Pure and deterministic — output sorted by testId.
 */
export function selectQuarantineCandidates(
  report: FlakehoundReport,
  state: QuarantineState,
  quarantine: QuarantineConfig,
  signalFlakinessThreshold: number,
): TestSignal[] {
  const alreadyQuarantined = new Set(state.quarantined.map((entry) => entry.testId));
  const critical = new Set(quarantine.criticalTests);
  const threshold = resolveScoreThreshold(quarantine, signalFlakinessThreshold);

  return report.signals
    .filter(
      (signal) =>
        signal.classification === 'flaky' &&
        signal.confidence === 'high' &&
        signal.flakinessScore >= threshold &&
        !alreadyQuarantined.has(signal.testId) &&
        !critical.has(signal.testId),
    )
    .sort((a, b) => (a.testId < b.testId ? -1 : 1));
}

/**
 * A quarantined test is releasable when its trailing post-quarantine history
 * is `stableRunsToRelease` consecutive clean passes (verdict 'pass', zero
 * retry flips). Skips and failures break the streak; runs from before the
 * quarantine never count. Derived purely from the report so quarantine runs
 * stay idempotent regardless of how often they execute between analyses.
 */
export function isReleasable(
  signal: TestSignal,
  entry: QuarantineEntry,
  stableRunsToRelease: number,
): boolean {
  const quarantinedAt = Date.parse(entry.quarantinedAt);
  const after = signal.history.filter((run) => Date.parse(run.timestamp) > quarantinedAt);

  let streak = 0;
  for (let i = after.length - 1; i >= 0; i--) {
    const run = after[i]!;
    if (run.verdict !== 'pass' || run.retryFlips !== 0) break;
    streak++;
  }
  return streak >= stableRunsToRelease;
}

/** Quarantined tests whose signal shows they have stabilized. Sorted by testId. */
export function selectReleaseCandidates(
  report: FlakehoundReport,
  state: QuarantineState,
  quarantine: QuarantineConfig,
): QuarantineEntry[] {
  const signalsById = new Map(report.signals.map((signal) => [signal.testId, signal]));
  return state.quarantined
    .filter((entry) => {
      const signal = signalsById.get(entry.testId);
      return signal !== undefined && isReleasable(signal, entry, quarantine.stableRunsToRelease);
    })
    .sort((a, b) => (a.testId < b.testId ? -1 : 1));
}
