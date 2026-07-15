import Anthropic from '@anthropic-ai/sdk';
import type { FailureCluster } from '../cluster/index.js';
import { AnthropicProvider } from './anthropic-provider.js';
import type { HypothesisClient } from './anthropic-provider.js';
import { OllamaProvider } from './ollama-provider.js';
import type { FetchLike } from './ollama-provider.js';
import { DEFAULT_AI_CONFIG } from './types.js';
import type { AiConfig, HypothesisProvider, InterpretedCluster } from './types.js';

export type { HypothesisClient } from './anthropic-provider.js';

export interface InterpretOptions {
  config?: Partial<AiConfig>;
  /**
   * API key; defaults to ANTHROPIC_API_KEY from the environment.
   * Pass null to force "no key" (used by tests to pin the skip path).
   */
  apiKey?: string | null;
  /**
   * An Anthropic client. Injecting one is an explicit "use Anthropic" choice: it
   * selects the Anthropic provider and skips the Ollama reachability probe (so
   * existing behavior and tests are unaffected, even where Ollama is running).
   */
  client?: HypothesisClient;
  /** An explicit provider instance — highest precedence (embedders, tests). */
  provider?: HypothesisProvider;
  /** Injectable fetch for the Ollama provider/probe; defaults to global fetch. */
  fetch?: FetchLike;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

/**
 * Choose the hypothesis provider from config + environment. Documented chain:
 *   0. options.provider ....... explicit instance wins
 *   1. options.client ......... explicit Anthropic wiring (honors the key gate)
 *   2. config.provider = 'ollama' | 'anthropic' ... use it directly
 *   3. config.provider = 'auto' (default):
 *        local Ollama reachable → Ollama
 *        else ANTHROPIC_API_KEY set → Anthropic
 *        else → undefined (skip, one quiet info line)
 * Returns undefined when no provider is available; never throws.
 */
export async function resolveProvider(
  config: AiConfig,
  options: InterpretOptions = {},
): Promise<HypothesisProvider | undefined> {
  const warn = options.warn ?? ((message: string) => console.error(message));
  const info = options.info ?? ((message: string) => console.error(message));

  if (options.provider !== undefined) return options.provider;

  const apiKey =
    options.apiKey === null ? undefined : (options.apiKey ?? process.env['ANTHROPIC_API_KEY']);
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);

  // Injected Anthropic client = explicit Anthropic wiring; no Ollama probe.
  if (options.client !== undefined) {
    return anthropicOrSkip(options.client, config, apiKey, warn, info);
  }

  switch (config.provider) {
    case 'ollama':
      info(`flakehound: interpreting clusters with the local Ollama model (${config.ollama.model})`);
      return new OllamaProvider(config.ollama, fetchImpl, warn);
    case 'anthropic':
      return anthropicOrSkip(undefined, config, apiKey, warn, info);
    case 'auto':
    default:
      if (await OllamaProvider.isReachable(config.ollama, fetchImpl)) {
        info(
          `flakehound: local Ollama reachable — interpreting clusters with ${config.ollama.model} (no API cost)`,
        );
        return new OllamaProvider(config.ollama, fetchImpl, warn);
      }
      return anthropicOrSkip(undefined, config, apiKey, warn, info);
  }
}

function anthropicOrSkip(
  client: HypothesisClient | undefined,
  config: AiConfig,
  apiKey: string | undefined,
  warn: (message: string) => void,
  info: (message: string) => void,
): HypothesisProvider | undefined {
  if (apiKey === undefined) {
    info('flakehound: AI interpretation skipped — ANTHROPIC_API_KEY is not set');
    return undefined;
  }
  try {
    const resolved = client ?? (new Anthropic({ apiKey }) as unknown as HypothesisClient);
    return new AnthropicProvider(resolved, config, warn);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    info(
      `flakehound: could not initialize the Anthropic provider (${detail}) — continuing without AI interpretation`,
    );
    return undefined;
  }
}

/**
 * Optionally annotate clusters with a one-line root-cause hypothesis.
 *
 * Thin, optional, at the edge: runs only when config.ai.enabled AND a provider
 * is available. Every failure is caught per-cluster — that cluster ships without
 * a hypothesis and the run continues. This function never throws, never reorders
 * or mutates clusters, and has no influence on scoring, clustering, ids, or exit
 * codes — regardless of which provider produced (or failed to produce) a
 * hypothesis.
 */
export async function interpretClusters(
  clusters: FailureCluster[],
  options: InterpretOptions = {},
): Promise<InterpretedCluster[]> {
  const config: AiConfig = { ...DEFAULT_AI_CONFIG, ...options.config };
  const warn = options.warn ?? ((message: string) => console.error(message));
  const info = options.info ?? ((message: string) => console.error(message));

  if (!config.enabled) {
    return clusters.map((cluster) => ({ ...cluster }));
  }

  const provider = await resolveProvider(config, { ...options, warn, info });
  if (provider === undefined) {
    return clusters.map((cluster) => ({ ...cluster }));
  }

  const hypotheses = await mapWithConcurrency(clusters, config.concurrency, (cluster) =>
    provider.interpret(cluster),
  );

  return clusters.map((cluster, index) => {
    const hypothesis = hypotheses[index];
    return hypothesis !== undefined ? { ...cluster, hypothesis } : { ...cluster };
  });
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
