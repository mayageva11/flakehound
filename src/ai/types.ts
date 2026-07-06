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

/**
 * A source of one-line root-cause hypotheses. The layer is pluggable behind this
 * one method: the deterministic core never knows which provider produced a
 * hypothesis, and a provider can never do more than fill `cluster.hypothesis`.
 * `interpret` must never throw — an unavailable or misbehaving provider returns
 * `undefined` (no hypothesis) so the run always completes.
 */
export interface HypothesisProvider {
  /** Stable identifier, e.g. 'anthropic' | 'ollama'. */
  name: string;
  interpret(cluster: FailureCluster): Promise<ClusterHypothesis | undefined>;
}

/** Which hypothesis source to use; 'auto' runs the reachability→key→skip chain. */
export type ProviderName = 'auto' | 'anthropic' | 'ollama';

export interface OllamaConfig {
  /** Base URL of the local Ollama HTTP API. */
  baseUrl: string;
  /** Model tag, e.g. 'llama3.2'. */
  model: string;
}

export interface AiConfig {
  /** Master toggle; the CLI --no-ai flag forces this to false. */
  enabled: boolean;
  /** Hypothesis source selection. */
  provider: ProviderName;
  /** Anthropic model (used by the Anthropic provider). */
  model: string;
  maxTokens: number;
  /** Low cap so a large cluster set doesn't hammer the provider. */
  concurrency: number;
  /** Local Ollama settings (used by the Ollama provider). */
  ollama: OllamaConfig;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: true,
  provider: 'auto',
  model: 'claude-sonnet-5',
  maxTokens: 1024,
  concurrency: 2,
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
  },
};
