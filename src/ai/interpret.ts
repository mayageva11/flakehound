import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { FailureCluster } from '../cluster/index.js';
import { DEFAULT_AI_CONFIG, HYPOTHESIS_CATEGORIES } from './types.js';
import type { AiConfig, ClusterHypothesis, InterpretedCluster } from './types.js';

const hypothesisSchema = z.object({
  category: z.enum(HYPOTHESIS_CATEGORIES),
  explanation: z
    .string()
    .min(1)
    .describe('One concise line explaining the most likely root cause.'),
});

/**
 * The slice of the Anthropic client this layer uses — injectable so tests
 * run fully mocked, with zero network access.
 */
export interface HypothesisClient {
  messages: {
    parse(params: {
      model: string;
      max_tokens: number;
      messages: { role: 'user'; content: string }[];
      output_config: { format: unknown };
    }): Promise<{ parsed_output: unknown }>;
  };
}

export interface InterpretOptions {
  config?: Partial<AiConfig>;
  /**
   * API key; defaults to ANTHROPIC_API_KEY from the environment.
   * Pass null to force "no key" (used by tests to pin the skip path).
   */
  apiKey?: string | null;
  client?: HypothesisClient;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

/**
 * Optionally annotate clusters with a one-line root-cause hypothesis.
 *
 * Thin, optional, at the edge: runs only when config.ai.enabled AND an API
 * key is present. Every failure (network, rate limit, malformed output) is
 * caught per-cluster — that cluster ships without a hypothesis and the run
 * continues. This function never throws, never reorders or mutates
 * clusters, and has no influence on scoring, clustering, ids, or exit
 * codes.
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

  const apiKey =
    options.apiKey === null
      ? undefined
      : (options.apiKey ?? process.env['ANTHROPIC_API_KEY']);
  if (apiKey === undefined) {
    info('flakehound: AI interpretation skipped — ANTHROPIC_API_KEY is not set');
    return clusters.map((cluster) => ({ ...cluster }));
  }

  // The structural HypothesisClient interface is narrower than the SDK
  // client's parse signature; the cast bridges the two.
  const client =
    options.client ?? (new Anthropic({ apiKey }) as unknown as HypothesisClient);

  const hypotheses = await mapWithConcurrency(clusters, config.concurrency, (cluster) =>
    interpretOne(client, cluster, config, warn),
  );

  return clusters.map((cluster, index) => {
    const hypothesis = hypotheses[index];
    return hypothesis !== undefined ? { ...cluster, hypothesis } : { ...cluster };
  });
}

async function interpretOne(
  client: HypothesisClient,
  cluster: FailureCluster,
  config: AiConfig,
  warn: (message: string) => void,
): Promise<ClusterHypothesis | undefined> {
  try {
    // claude-sonnet-5 runs adaptive-thinking-only and rejects non-default
    // sampling parameters — send only model, max_tokens, messages, and the
    // structured-output format.
    const response = await client.messages.parse({
      model: config.model,
      max_tokens: config.maxTokens,
      messages: [{ role: 'user', content: buildPrompt(cluster) }],
      output_config: { format: zodOutputFormat(hypothesisSchema) },
    });
    const parsed = hypothesisSchema.safeParse(response.parsed_output);
    if (!parsed.success) {
      warn(
        `flakehound: AI interpretation for cluster ${cluster.id} returned an off-schema response — continuing without a hypothesis`,
      );
      return undefined;
    }
    return parsed.data;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    warn(
      `flakehound: AI interpretation failed for cluster ${cluster.id}: ${detail} — continuing without a hypothesis`,
    );
    return undefined;
  }
}

function buildPrompt(cluster: FailureCluster): string {
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
