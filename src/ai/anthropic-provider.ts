import type { FailureCluster } from '../cluster/index.js';
import { buildPrompt, hypothesisSchema } from './prompt.js';
import type { AiConfig, ClusterHypothesis, HypothesisProvider } from './types.js';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

/**
 * The slice of the Anthropic client this provider uses — injectable so tests
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

/**
 * Hypotheses from the Claude API via structured outputs. This is the original
 * behavior, unchanged: same request params, same schema validation, same
 * per-cluster graceful degradation (any failure → undefined, one warn).
 */
export class AnthropicProvider implements HypothesisProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly client: HypothesisClient,
    private readonly config: AiConfig,
    private readonly warn: (message: string) => void,
  ) {}

  async interpret(cluster: FailureCluster): Promise<ClusterHypothesis | undefined> {
    try {
      // claude-sonnet-5 runs adaptive-thinking-only and rejects non-default
      // sampling parameters — send only model, max_tokens, messages, and the
      // structured-output format.
      const response = await this.client.messages.parse({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        messages: [{ role: 'user', content: buildPrompt(cluster) }],
        output_config: { format: zodOutputFormat(hypothesisSchema) },
      });
      const parsed = hypothesisSchema.safeParse(response.parsed_output);
      if (!parsed.success) {
        this.warn(
          `flakehound: AI interpretation for cluster ${cluster.id} returned an off-schema response — continuing without a hypothesis`,
        );
        return undefined;
      }
      return parsed.data;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.warn(
        `flakehound: AI interpretation failed for cluster ${cluster.id}: ${detail} — continuing without a hypothesis`,
      );
      return undefined;
    }
  }
}
