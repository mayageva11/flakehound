import type { TestRun } from '../ingest/types.js';
import { groupExecutions } from './executions.js';
import { scoreFlakiness } from './flakiness.js';
import { classifyRegression } from './regression.js';
import { DEFAULT_SIGNAL_CONFIG } from './types.js';
import type { Confidence, SignalConfig, TestSignal } from './types.js';

export { groupExecutions } from './executions.js';
export type { Execution, Verdict } from './executions.js';
export { scoreFlakiness } from './flakiness.js';
export type { CrossRunBasis, FlakinessResult } from './flakiness.js';
export { classifyRegression } from './regression.js';
export type { RegressionResult } from './regression.js';
export { DEFAULT_SIGNAL_CONFIG } from './types.js';
export type { Classification, Confidence, HistoryEntry, SignalConfig, TestSignal } from './types.js';

/**
 * Compute per-test signals from the full run history.
 * Decision order per test (mutually exclusive):
 *   1. insufficient-data   — fewer than minRuns scorable executions
 *   2. regression          — via classifyRegression (runs BEFORE flakiness)
 *   3. insufficient-metadata — looks like a regression but commitSha missing
 *   4. flaky               — retry flips, or score ≥ threshold
 *   5. stable
 */
export function computeSignals(
  runs: TestRun[],
  configOverrides: Partial<SignalConfig> = {},
): TestSignal[] {
  const config: SignalConfig = { ...DEFAULT_SIGNAL_CONFIG, ...configOverrides };

  const byTest = new Map<string, TestRun[]>();
  for (const run of runs) {
    const bucket = byTest.get(run.testId);
    if (bucket === undefined) byTest.set(run.testId, [run]);
    else bucket.push(run);
  }

  return [...byTest.keys()].sort().map((testId) => {
    return analyzeTest(testId, byTest.get(testId) as TestRun[], config);
  });
}

function analyzeTest(testId: string, runs: TestRun[], config: SignalConfig): TestSignal {
  const executions = groupExecutions(runs);
  const scorable = executions.filter((e) => e.verdict !== 'skip');
  const flakiness = scoreFlakiness(executions, config);
  // The evidence behind the classification, published so reports can SHOW the
  // flips. Executions are already chronologically sorted by groupExecutions.
  const history = executions.map((e) => ({
    timestamp: e.timestamp,
    ...(e.commitSha !== undefined ? { commitSha: e.commitSha } : {}),
    verdict: e.verdict,
    retryFlips: e.retryFlips,
  }));

  if (scorable.length < config.minRuns) {
    return {
      testId,
      flakinessScore: flakiness.score,
      classification: 'insufficient-data',
      confidence: 'low',
      reason: `only ${scorable.length} scorable run(s) in the history window; ${config.minRuns} required to classify`,
      history,
    };
  }

  const regression = classifyRegression(executions, config);
  if (regression.kind === 'regression') {
    return {
      testId,
      flakinessScore: 0,
      classification: 'regression',
      confidence: 'high',
      reason: `failing in 100% of the last ${regression.failingStreak} run(s) since commit ${regression.brokenSinceSha}; passed before it`,
      brokenSinceSha: regression.brokenSinceSha,
      history,
    };
  }
  if (regression.kind === 'needs-metadata') {
    return {
      testId,
      flakinessScore: flakiness.score,
      classification: 'insufficient-metadata',
      confidence: 'low',
      reason: `failing in the last ${regression.failingStreak} consecutive run(s) after passing, but commitSha is unavailable — cannot pin the breaking commit; add sidecar metadata to enable regression detection`,
      history,
    };
  }

  const isFlaky = flakiness.retryFlips > 0 || flakiness.score >= config.flakinessThreshold;
  if (isFlaky) {
    const confidence: Confidence =
      flakiness.retryFlips > 0 ? 'high' : flakiness.basis === 'same-commit' ? 'medium' : 'low';
    const signals: string[] = [];
    if (flakiness.retryFlips > 0) {
      signals.push(`${flakiness.retryFlips} retry flip(s) within a single run`);
    }
    if (flakiness.crossRunFlips > 0) {
      signals.push(
        flakiness.basis === 'same-commit'
          ? `${flakiness.crossRunFlips} pass↔fail transition(s) on the same commit`
          : `${flakiness.crossRunFlips} pass↔fail transition(s) in time order (no commitSha available)`,
      );
    }
    return {
      testId,
      flakinessScore: flakiness.score,
      classification: 'flaky',
      confidence,
      reason: signals.join('; '),
      history,
    };
  }

  const alwaysFailing = scorable.length > 0 && scorable.every((e) => e.verdict === 'fail');
  return {
    testId,
    flakinessScore: flakiness.score,
    classification: 'stable',
    confidence: flakiness.basis === 'same-commit' ? 'high' : 'low',
    ...(alwaysFailing
      ? {
          reason:
            'failing in 100% of observed runs with no passing run in the history window — cannot determine a breaking commit; widen the window or check the test',
        }
      : {}),
    history,
  };
}
