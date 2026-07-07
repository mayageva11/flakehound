import type { TestRun } from '../ingest/types.js';
import { clusterFailures } from './cluster.js';
import type { ClusterConfig, FailureCluster } from './cluster.js';

export { normalizeTrace, NORMALIZATION_RULES } from './normalize.js';
export type { NormalizationRule, NormalizedTrace } from './normalize.js';
export { JaccardSimilarity, WeightedJaccardSimilarity } from './similarity.js';
export type { SimilarityMetric, TokenSet, WeightedTokens } from './similarity.js';
export { clusterFailures, DEFAULT_CLUSTER_CONFIG } from './cluster.js';
export type { ClusterConfig, FailureCluster, FailureOccurrence } from './cluster.js';

/**
 * Adapter from the ingestion model: cluster the failed runs' traces.
 * Failures with no stack trace and no error message carry nothing to
 * cluster on and are skipped (they still count in the Signal layer).
 */
export function clusterTestRuns(
  runs: TestRun[],
  overrides: Partial<ClusterConfig> = {},
): FailureCluster[] {
  const failures = runs
    .filter((run) => run.status === 'fail')
    .map((run) => ({
      testId: run.testId,
      timestamp: run.timestamp,
      trace: run.stackTrace ?? run.errorMessage ?? '',
    }))
    .filter((failure) => failure.trace !== '');
  return clusterFailures(failures, overrides);
}
