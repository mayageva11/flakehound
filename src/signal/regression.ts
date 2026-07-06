import type { Execution } from './executions.js';
import type { SignalConfig } from './types.js';

export type RegressionResult =
  | { kind: 'regression'; brokenSinceSha: string; failingStreak: number }
  | { kind: 'needs-metadata'; failingStreak: number }
  | { kind: 'none' };

/**
 * A regression is a test failing in 100% of runs since a specific commit,
 * having passed before it. Runs FIRST and is mutually exclusive with flaky:
 * a same-commit pass↔fail flip inside the failing window disqualifies the
 * regression and falls through to the flakiness scorer instead.
 */
export function classifyRegression(
  executions: Execution[],
  config: SignalConfig,
): RegressionResult {
  const scorable = executions.filter((e) => e.verdict !== 'skip');

  let streakStart = scorable.length;
  while (streakStart > 0 && scorable[streakStart - 1]!.verdict === 'fail') {
    streakStart -= 1;
  }
  const streak = scorable.slice(streakStart);
  if (streak.length < config.minRegressionStreak) return { kind: 'none' };

  const before = scorable.slice(0, streakStart);
  const passedBefore = before.some((e) => e.verdict === 'pass');
  if (!passedBefore) return { kind: 'none' };

  // The classifier requires commitSha on the failing streak: without it we
  // can't pin the breaking commit — downgrade, never throw.
  if (streak.some((e) => e.commitSha === undefined)) {
    return { kind: 'needs-metadata', failingStreak: streak.length };
  }

  // A commit that has both passing and failing runs is a same-commit flip —
  // flaky territory, not a regression.
  const passingShas = new Set(
    scorable.filter((e) => e.verdict === 'pass' && e.commitSha !== undefined).map(
      (e) => e.commitSha as string,
    ),
  );
  if (streak.some((e) => passingShas.has(e.commitSha as string))) {
    return { kind: 'none' };
  }

  return {
    kind: 'regression',
    brokenSinceSha: streak[0]!.commitSha as string,
    failingStreak: streak.length,
  };
}
