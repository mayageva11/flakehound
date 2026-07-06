import { describe, expect, it, vi } from 'vitest';
import { interpretClusters, resolveProvider } from '../src/ai/interpret.js';
import { OllamaProvider } from '../src/ai/ollama-provider.js';
import type { FetchLike, FetchResponse } from '../src/ai/ollama-provider.js';
import { DEFAULT_AI_CONFIG } from '../src/ai/types.js';
import type { AiConfig, HypothesisProvider } from '../src/ai/index.js';
import type { FailureCluster } from '../src/cluster/index.js';

const timeoutCluster: FailureCluster = {
  id: 'aaa111bbb222',
  representativeTrace:
    'TimeoutError: Timeout <DURATION> exceeded. at CheckoutPage.pay (checkout-page.ts:<N>:<N>)',
  tests: ['checkout > completes payment'],
  firstSeen: '2026-07-01T10:00:00.000Z',
  lastSeen: '2026-07-05T10:00:00.000Z',
  occurrences: 3,
};

const ollamaCfg = DEFAULT_AI_CONFIG.ollama;

/** A fetch that returns one Ollama /api/chat body (message.content = `content`). */
function chatFetch(content: unknown, ok = true, status = 200): FetchLike {
  return async () =>
    ({
      ok,
      status,
      json: async () => (content === undefined ? {} : { message: { content } }),
    }) as FetchResponse;
}

/** A fetch whose /api/tags probe succeeds (reachable) but records the call. */
function reachableFetch(): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => ({ models: [] }) }) as FetchResponse;
}

/** A fetch that always throws — models an unreachable endpoint. */
const unreachableFetch: FetchLike = async () => {
  throw new Error('ECONNREFUSED');
};

describe('OllamaProvider.interpret — happy path', () => {
  it('parses valid structured JSON into a typed hypothesis', async () => {
    const fetchImpl = chatFetch(
      JSON.stringify({ category: 'timeout', explanation: 'The pay button never renders in time.' }),
    );
    const provider = new OllamaProvider(ollamaCfg, fetchImpl, () => {});
    const result = await provider.interpret(timeoutCluster);
    expect(result).toEqual({
      category: 'timeout',
      explanation: 'The pay button never renders in time.',
    });
  });
});

describe('OllamaProvider.interpret — graceful degradation (never throws)', () => {
  it('malformed JSON → undefined, one warn', async () => {
    const warn = vi.fn();
    const provider = new OllamaProvider(ollamaCfg, chatFetch('{ not valid json'), warn);
    expect(await provider.interpret(timeoutCluster)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(timeoutCluster.id);
  });

  it('off-schema JSON (bad category) → undefined, one warn mentioning off-schema', async () => {
    const warn = vi.fn();
    const provider = new OllamaProvider(
      ollamaCfg,
      chatFetch(JSON.stringify({ category: 'gremlins', explanation: 'x' })),
      warn,
    );
    expect(await provider.interpret(timeoutCluster)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('off-schema');
  });

  it('non-OK HTTP status → undefined, one warn', async () => {
    const warn = vi.fn();
    const provider = new OllamaProvider(ollamaCfg, chatFetch('{}', false, 500), warn);
    expect(await provider.interpret(timeoutCluster)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('500');
  });

  it('missing message content → undefined, one warn', async () => {
    const warn = vi.fn();
    const provider = new OllamaProvider(ollamaCfg, chatFetch(undefined), warn);
    expect(await provider.interpret(timeoutCluster)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('network error mid-request → undefined, never throws', async () => {
    const warn = vi.fn();
    const provider = new OllamaProvider(ollamaCfg, unreachableFetch, warn);
    await expect(provider.interpret(timeoutCluster)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('OllamaProvider.isReachable', () => {
  it('true when the endpoint answers OK', async () => {
    expect(await OllamaProvider.isReachable(ollamaCfg, reachableFetch())).toBe(true);
  });
  it('false when the endpoint errors — never throws', async () => {
    expect(await OllamaProvider.isReachable(ollamaCfg, unreachableFetch)).toBe(false);
  });
});

describe('resolveProvider — the documented selection chain', () => {
  const cfg = (over: Partial<AiConfig> = {}): AiConfig => ({ ...DEFAULT_AI_CONFIG, ...over });

  it('auto + Ollama reachable → Ollama (even when a key is set)', async () => {
    const provider = await resolveProvider(cfg(), {
      fetch: reachableFetch(),
      apiKey: 'sk-test',
      info: () => {},
    });
    expect(provider?.name).toBe('ollama');
  });

  it('auto + Ollama unreachable + API key → Anthropic', async () => {
    const provider = await resolveProvider(cfg(), {
      fetch: unreachableFetch,
      apiKey: 'sk-test',
      info: () => {},
    });
    expect(provider?.name).toBe('anthropic');
  });

  it('auto + Ollama unreachable + no key → skip (undefined), one info line', async () => {
    const info = vi.fn();
    const provider = await resolveProvider(cfg(), {
      fetch: unreachableFetch,
      apiKey: null,
      info,
    });
    expect(provider).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("provider: 'ollama' forces Ollama without probing", async () => {
    const fetchImpl = vi.fn(unreachableFetch);
    const provider = await resolveProvider(cfg({ provider: 'ollama' }), {
      fetch: fetchImpl,
      info: () => {},
    });
    expect(provider?.name).toBe('ollama');
    expect(fetchImpl).not.toHaveBeenCalled(); // no reachability probe
  });

  it("provider: 'anthropic' + key → Anthropic (no Ollama probe)", async () => {
    const fetchImpl = vi.fn(reachableFetch());
    const provider = await resolveProvider(cfg({ provider: 'anthropic' }), {
      fetch: fetchImpl,
      apiKey: 'sk-test',
      info: () => {},
    });
    expect(provider?.name).toBe('anthropic');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an explicit options.provider wins over everything', async () => {
    const fake: HypothesisProvider = { name: 'fake', interpret: async () => undefined };
    const provider = await resolveProvider(cfg(), { provider: fake, fetch: reachableFetch() });
    expect(provider).toBe(fake);
  });
});

describe('interpretClusters — provider-agnostic orchestration', () => {
  it('attaches hypotheses from the Ollama provider (auto, reachable)', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith('/api/tags')
        ? ({ ok: true, status: 200, json: async () => ({}) } as FetchResponse)
        : ({
            ok: true,
            status: 200,
            json: async () => ({
              message: { content: JSON.stringify({ category: 'timeout', explanation: 'slow boot' }) },
            }),
          } as FetchResponse);

    const [cluster] = await interpretClusters([timeoutCluster], { fetch: fetchImpl, info: () => {} });
    expect(cluster!.hypothesis).toEqual({ category: 'timeout', explanation: 'slow boot' });
  });

  it('--no-ai (enabled:false) never selects a provider', async () => {
    const fake: HypothesisProvider = { name: 'fake', interpret: vi.fn(async () => undefined) };
    const [cluster] = await interpretClusters([timeoutCluster], {
      provider: fake,
      config: { enabled: false },
    });
    expect(cluster!.hypothesis).toBeUndefined();
    expect(fake.interpret).not.toHaveBeenCalled();
  });
});
