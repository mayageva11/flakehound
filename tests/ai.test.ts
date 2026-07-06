import { describe, expect, it, vi } from 'vitest';
import { interpretClusters } from '../src/ai/interpret.js';
import type { HypothesisClient } from '../src/ai/interpret.js';
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

const dbCluster: FailureCluster = {
  id: 'ccc333ddd444',
  representativeTrace: 'ConnectionError: could not connect to postgres:<N> at Pool.acquire',
  tests: ['api > test_db_connection'],
  firstSeen: '2026-07-02T10:00:00.000Z',
  lastSeen: '2026-07-02T10:00:00.000Z',
  occurrences: 1,
};

type ParseParams = Parameters<HypothesisClient['messages']['parse']>[0];

function mockClient(impl: (params: ParseParams) => Promise<{ parsed_output: unknown }>) {
  const parse = vi.fn(impl);
  const client: HypothesisClient = { messages: { parse } };
  return { client, parse };
}

const validOutput = (category: string, explanation: string) => ({
  parsed_output: { category, explanation },
});

describe('interpretClusters — happy path', () => {
  it('attaches a typed hypothesis from valid structured output', async () => {
    const { client, parse } = mockClient((params) =>
      Promise.resolve(
        params.messages[0]!.content.includes('TimeoutError')
          ? validOutput('timeout', 'Payment page wait exceeds the configured timeout under load.')
          : validOutput('network', 'Postgres is unreachable from the CI runner.'),
      ),
    );

    const result = await interpretClusters([timeoutCluster, dbCluster], {
      client,
      apiKey: 'test-key',
    });

    expect(parse).toHaveBeenCalledTimes(2);
    expect(result[0]!.hypothesis).toEqual({
      category: 'timeout',
      explanation: 'Payment page wait exceeds the configured timeout under load.',
    });
    expect(result[1]!.hypothesis?.category).toBe('network');
  });

  it('sends only model, max_tokens, messages, and the output format — no sampling params', async () => {
    const { client, parse } = mockClient(() => Promise.resolve(validOutput('timeout', 'x')));

    await interpretClusters([timeoutCluster], { client, apiKey: 'test-key' });

    const params = parse.mock.calls[0]![0];
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.max_tokens).toBe(1024);
    expect(params.output_config.format).toBeDefined();
    expect(Object.keys(params).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'output_config',
    ]);
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('thinking');
  });

  it('prompts with the normalized representative trace and affected test names', async () => {
    const { client, parse } = mockClient(() => Promise.resolve(validOutput('timeout', 'x')));

    await interpretClusters([timeoutCluster], { client, apiKey: 'test-key' });

    const prompt = parse.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain(timeoutCluster.representativeTrace);
    expect(prompt).toContain('checkout > completes payment');
    expect(prompt).toContain('normalized');
  });
});

describe('interpretClusters — graceful degradation', () => {
  it('API error → hypothesis: undefined for that cluster only; run continues', async () => {
    const { client } = mockClient((params) =>
      params.messages[0]!.content.includes('TimeoutError')
        ? Promise.reject(new Error('529 overloaded'))
        : Promise.resolve(validOutput('network', 'Postgres is unreachable.')),
    );
    const warn = vi.fn();

    const result = await interpretClusters([timeoutCluster, dbCluster], {
      client,
      apiKey: 'test-key',
      warn,
    });

    expect(result[0]!.hypothesis).toBeUndefined();
    expect(result[1]!.hypothesis?.category).toBe('network'); // unaffected
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(timeoutCluster.id);
    expect(warn.mock.calls[0]![0]).toContain('529 overloaded');
  });

  it('off-schema response → caught, degrades to undefined, no throw', async () => {
    const { client } = mockClient(() =>
      Promise.resolve(validOutput('gremlins', 'not a real category')),
    );
    const warn = vi.fn();

    const result = await interpretClusters([timeoutCluster], {
      client,
      apiKey: 'test-key',
      warn,
    });

    expect(result[0]!.hypothesis).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('off-schema');
  });

  it('never rejects even when every call fails', async () => {
    const { client } = mockClient(() => Promise.reject(new Error('ECONNREFUSED')));

    await expect(
      interpretClusters([timeoutCluster, dbCluster], {
        client,
        apiKey: 'test-key',
        warn: () => {},
      }),
    ).resolves.toHaveLength(2);
  });
});

describe('interpretClusters — gating (zero client invocations)', () => {
  it('config.ai.enabled = false → the client is never called', async () => {
    const { client, parse } = mockClient(() => Promise.resolve(validOutput('timeout', 'x')));

    const result = await interpretClusters([timeoutCluster, dbCluster], {
      client,
      apiKey: 'test-key',
      config: { enabled: false },
    });

    expect(parse).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0]!.hypothesis).toBeUndefined();
  });

  it('missing API key → the client is never called; one quiet info line', async () => {
    const { client, parse } = mockClient(() => Promise.resolve(validOutput('timeout', 'x')));
    const info = vi.fn();

    const result = await interpretClusters([timeoutCluster], {
      client,
      apiKey: null, // force "no key" regardless of the test machine's env
      info,
    });

    expect(parse).not.toHaveBeenCalled();
    expect(result[0]!.hypothesis).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toContain('ANTHROPIC_API_KEY');
  });
});

describe('interpretClusters — the non-AI path is unchanged', () => {
  it('report minus hypotheses is byte-identical whether AI ran or not', async () => {
    const clusters = [timeoutCluster, dbCluster];
    const { client } = mockClient(() => Promise.resolve(validOutput('timeout', 'x')));

    const withAi = await interpretClusters(clusters, { client, apiKey: 'test-key' });
    const withoutAi = await interpretClusters(clusters, { config: { enabled: false } });

    const stripped = withAi.map(({ hypothesis: _hypothesis, ...rest }) => rest);
    expect(JSON.stringify(stripped)).toBe(JSON.stringify(withoutAi));
    expect(JSON.stringify(withoutAi)).toBe(JSON.stringify(clusters));
  });

  it('does not mutate or reorder the input clusters', async () => {
    const clusters = [timeoutCluster, dbCluster];
    const snapshot = JSON.stringify(clusters);
    const { client } = mockClient(() => Promise.resolve(validOutput('assertion', 'x')));

    const result = await interpretClusters(clusters, { client, apiKey: 'test-key' });

    expect(JSON.stringify(clusters)).toBe(snapshot);
    expect(result.map((c) => c.id)).toEqual(clusters.map((c) => c.id));
  });
});
