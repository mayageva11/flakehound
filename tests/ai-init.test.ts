import { describe, expect, it, vi } from 'vitest';

// A provider that throws when constructed (e.g. the SDK rejects the key shape)
// must degrade to "no AI", never crash the run — the documented guarantee.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      throw new Error('bad API key');
    }
  },
}));

import { interpretClusters } from '../src/ai/interpret.js';
import type { FailureCluster } from '../src/cluster/index.js';

const cluster: FailureCluster = {
  id: 'aaa111bbb222',
  representativeTrace: 'TimeoutError: Timeout <DURATION> exceeded.',
  tests: ['checkout > completes payment'],
  firstSeen: '2026-07-01T10:00:00.000Z',
  lastSeen: '2026-07-05T10:00:00.000Z',
  occurrences: 3,
};

describe('interpretClusters — provider init failure', () => {
  it('degrades to no hypotheses when the Anthropic client throws on construction', async () => {
    const info = vi.fn();
    const result = await interpretClusters([cluster], {
      config: { provider: 'anthropic' },
      apiKey: 'test-key',
      info,
      warn: () => {},
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.hypothesis).toBeUndefined();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('could not initialize the Anthropic provider'),
    );
  });
});
