import type { FailureCluster } from '../cluster/index.js';

export const HYPOTHESIS_CATEGORIES = [
  'race-condition',
  'timeout',
  'network',
  'environment',
  'assertion',
] as const;

export type HypothesisCategory = (typeof HYPOTHESIS_CATEGORIES)[number];

export interface ClusterHypothesis {
  category: HypothesisCategory;
  /** One concise line. */
  explanation: string;
}

/** A cluster optionally annotated by the AI layer. AI interprets; it is never the source of truth. */
export interface InterpretedCluster extends FailureCluster {
  hypothesis?: ClusterHypothesis;
}

export interface AiConfig {
  /** Master toggle; the CLI --no-ai flag forces this to false. */
  enabled: boolean;
  model: string;
  maxTokens: number;
  /** Low cap so a large cluster set doesn't hammer the API. */
  concurrency: number;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: true,
  model: 'claude-sonnet-5',
  maxTokens: 1024,
  concurrency: 2,
};
