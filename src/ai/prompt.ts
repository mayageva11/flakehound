import { z } from 'zod';
import type { FailureCluster } from '../cluster/index.js';
import { HYPOTHESIS_CATEGORIES } from './types.js';

/**
 * The one schema every provider validates against. Whatever the source — the
 * Claude API or a local Ollama model — a hypothesis is only accepted if it
 * matches this exactly; anything else degrades to no hypothesis.
 */
export const hypothesisSchema = z.object({
  category: z.enum(HYPOTHESIS_CATEGORIES),
  explanation: z.string().min(1).describe('One concise line explaining the most likely root cause.'),
});

/** The shared, provider-neutral prompt for a single cluster. */
export function buildPrompt(cluster: FailureCluster): string {
  const tests = cluster.tests.map((testId) => `- ${testId}`).join('\n');
  return [
    'You are analyzing a cluster of CI test failures that share the same underlying cause.',
    '',
    'Representative failure trace (normalized: volatile tokens like line numbers, addresses, and durations are replaced with placeholders):',
    cluster.representativeTrace,
    '',
    `Affected tests (${cluster.tests.length}):`,
    tests,
    '',
    `Observed ${cluster.occurrences} time(s) between ${cluster.firstSeen} and ${cluster.lastSeen}.`,
    '',
    'Classify the most likely root cause into one category and give a one-line explanation.',
  ].join('\n');
}
