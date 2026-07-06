import type { FailureCluster } from '../cluster/index.js';
import { buildPrompt, hypothesisSchema } from './prompt.js';
import { HYPOTHESIS_CATEGORIES } from './types.js';
import type { ClusterHypothesis, HypothesisProvider, OllamaConfig } from './types.js';

/**
 * The minimal `fetch` surface this provider needs — injectable so tests run with
 * zero network access, exactly like the Anthropic provider's client injection.
 * `globalThis.fetch` (Node ≥20) is structurally compatible.
 */
export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponse>;
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Short probe budget: reachability must never make a run feel like it hung. */
const REACHABILITY_TIMEOUT_MS = 1500;
/** A single interpretation is bounded so a wedged local model can't hang the run. */
const CHAT_TIMEOUT_MS = 30_000;

/**
 * Hypotheses from a local Ollama model (default llama3.2) over its HTTP API.
 *
 * Small local models return malformed or off-schema JSON far more often than a
 * hosted model, so graceful degradation is the whole game here: every failure
 * path — non-OK response, malformed JSON, schema mismatch, network error,
 * timeout — resolves to `undefined` (no hypothesis) with a single warn, and
 * never throws. Requests use `format: 'json'` to bias the model toward valid
 * JSON, but the response is still validated against the shared schema.
 */
export class OllamaProvider implements HypothesisProvider {
  readonly name = 'ollama';

  constructor(
    private readonly config: OllamaConfig,
    private readonly fetchImpl: FetchLike,
    private readonly warn: (message: string) => void,
  ) {}

  /** True if the Ollama HTTP API answers within the probe budget. Never throws. */
  static async isReachable(config: OllamaConfig, fetchImpl: FetchLike): Promise<boolean> {
    try {
      const response = await fetchImpl(`${trimSlash(config.baseUrl)}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async interpret(cluster: FailureCluster): Promise<ClusterHypothesis | undefined> {
    try {
      const response = await this.fetchImpl(`${trimSlash(this.config.baseUrl)}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: buildOllamaPrompt(cluster) }],
          stream: false,
          format: 'json',
        }),
        signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.warn(
          `flakehound: Ollama interpretation for cluster ${cluster.id} returned HTTP ${response.status} — continuing without a hypothesis`,
        );
        return undefined;
      }

      const payload = (await response.json()) as { message?: { content?: unknown } };
      const content = payload.message?.content;
      if (typeof content !== 'string') {
        this.warn(
          `flakehound: Ollama interpretation for cluster ${cluster.id} returned no message content — continuing without a hypothesis`,
        );
        return undefined;
      }

      // Small models frequently emit malformed JSON — JSON.parse can throw here,
      // which the surrounding try/catch turns into a clean degradation.
      const parsed = hypothesisSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        this.warn(
          `flakehound: Ollama interpretation for cluster ${cluster.id} returned an off-schema response — continuing without a hypothesis`,
        );
        return undefined;
      }
      return parsed.data;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.warn(
        `flakehound: Ollama interpretation failed for cluster ${cluster.id}: ${detail} — continuing without a hypothesis`,
      );
      return undefined;
    }
  }
}

/** The shared prompt plus an explicit JSON-shape instruction small models need. */
function buildOllamaPrompt(cluster: FailureCluster): string {
  return [
    buildPrompt(cluster),
    '',
    'Respond with ONLY a single JSON object — no prose, no markdown, no code fence — of exactly this shape:',
    `{"category": "<one of: ${HYPOTHESIS_CATEGORIES.join(', ')}>", "explanation": "<one concise sentence>"}`,
  ].join('\n');
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
