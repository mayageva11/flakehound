import type { Execution } from './executions.js';
import type { SignalConfig } from './types.js';

export type CrossRunBasis = 'same-commit' | 'time-ordered' | 'none';

export interface FlakinessResult {
  /** Weighted transitions / opportunities, capped at 1. */
  score: number;
  retryFlips: number;
  crossRunFlips: number;
  /**
   * How cross-run flips were measured. 'same-commit' is the spec's core
   * definition; 'time-ordered' is the low-confidence fallback used when
   * commitSha metadata is unavailable.
   */
  basis: CrossRunBasis;
}

/**
 * Flakiness = weighted transition frequency, NOT naive fail rate.
 * A test failing 100% of the time scores 0 here (no flips) — that's the
 * regression classifier's territory, kept mutually exclusive upstream.
 */
export function scoreFlakiness(executions: Execution[], config: SignalConfig): FlakinessResult {
  const scorable = executions.filter((e) => e.verdict !== 'skip');

  let retryFlips = 0;
  let retryOpportunities = 0;
  for (const execution of scorable) {
    retryFlips += execution.retryFlips;
    retryOpportunities += execution.retryOpportunities;
  }

  const cross = countCrossRunFlips(scorable);

  const opportunities = retryOpportunities + cross.opportunities;
  const weighted =
    retryFlips * config.retryFlipWeight + cross.flips * config.crossRunFlipWeight;
  const score = opportunities === 0 ? 0 : Math.min(1, weighted / opportunities);

  return { score, retryFlips, crossRunFlips: cross.flips, basis: cross.basis };
}

function countCrossRunFlips(scorable: Execution[]): {
  flips: number;
  opportunities: number;
  basis: CrossRunBasis;
} {
  const withSha = scorable.filter((e) => e.commitSha !== undefined);

  // Core definition: verdict flips between runs on the same commit.
  if (withSha.length >= 2) {
    const byCommit = new Map<string, Execution[]>();
    for (const execution of withSha) {
      const sha = execution.commitSha as string;
      const group = byCommit.get(sha);
      if (group === undefined) byCommit.set(sha, [execution]);
      else group.push(execution);
    }
    let flips = 0;
    let opportunities = 0;
    for (const group of byCommit.values()) {
      const counted = countTransitions(group);
      flips += counted.flips;
      opportunities += counted.opportunities;
    }
    return { flips, opportunities, basis: 'same-commit' };
  }

  // Fallback: chronological transitions across all runs. Conflates
  // "code changed" with "flaky", hence low confidence downstream.
  if (scorable.length >= 2) {
    const counted = countTransitions(scorable);
    return { ...counted, basis: 'time-ordered' };
  }

  return { flips: 0, opportunities: 0, basis: 'none' };
}

function countTransitions(chronological: Execution[]): { flips: number; opportunities: number } {
  let flips = 0;
  for (let i = 1; i < chronological.length; i += 1) {
    if (chronological[i]!.verdict !== chronological[i - 1]!.verdict) flips += 1;
  }
  return { flips, opportunities: Math.max(0, chronological.length - 1) };
}
