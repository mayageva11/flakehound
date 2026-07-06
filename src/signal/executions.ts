import type { TestRun } from '../ingest/types.js';

export type Verdict = 'pass' | 'fail' | 'skip';

/**
 * One CI run of a single test: all attempts (original + retries) that share a
 * runId. The unit the Signal layer reasons over.
 */
export interface Execution {
  key: string;
  timestamp: string;
  commitSha?: string;
  /** Final outcome of the run: retried tests that eventually passed → 'pass'. */
  verdict: Verdict;
  passCount: number;
  failCount: number;
  /**
   * Intra-run flips, counted as min(passCount, failCount) — an
   * order-independent lower bound, so results don't depend on attempt
   * ordering surviving ingestion.
   */
  retryFlips: number;
  /** Attempt-to-attempt comparisons available within this run. */
  retryOpportunities: number;
}

/**
 * Group one test's runs into executions and sort chronologically
 * (timestamp, then key) so downstream analysis is deterministic
 * regardless of input order.
 */
export function groupExecutions(runs: TestRun[]): Execution[] {
  const byKey = new Map<string, TestRun[]>();
  for (const run of runs) {
    const key = run.runId ?? `${run.commitSha ?? ''}|${run.timestamp}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [run]);
    } else {
      bucket.push(run);
    }
  }

  const executions = [...byKey.entries()].map(([key, attempts]) => toExecution(key, attempts));
  executions.sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.key.localeCompare(b.key),
  );
  return executions;
}

function toExecution(key: string, attempts: TestRun[]): Execution {
  let passCount = 0;
  let failCount = 0;
  for (const attempt of attempts) {
    if (attempt.status === 'pass') passCount += 1;
    else if (attempt.status === 'fail') failCount += 1;
  }

  const verdict: Verdict = passCount > 0 ? 'pass' : failCount > 0 ? 'fail' : 'skip';
  const commitSha = attempts.find((a) => a.commitSha !== undefined)?.commitSha;
  const first = attempts[0];

  return {
    key,
    timestamp: first?.timestamp ?? '',
    ...(commitSha !== undefined ? { commitSha } : {}),
    verdict,
    passCount,
    failCount,
    retryFlips: Math.min(passCount, failCount),
    retryOpportunities: Math.max(0, passCount + failCount - 1),
  };
}
