import { describe, expect, it, vi } from 'vitest';
import {
  buildIssueBody,
  buildIssueTitle,
  closeQuarantineIssue,
  createQuarantineIssue,
  openQuarantinePr,
  parseRepoFromRemoteUrl,
  parseRepoSlug,
} from '../src/quarantine/github.js';
import type { IssueClient } from '../src/quarantine/github.js';
import type { InterpretedCluster } from '../src/ai/types.js';
import type { QuarantineEntry } from '../src/quarantine/types.js';
import type { TestSignal } from '../src/signal/types.js';
import { FlakehoundError } from '../src/util/errors.js';

const signal: TestSignal = {
  testId: 'shop.spec.ts > checkout > pays with saved card',
  flakinessScore: 0.42,
  classification: 'flaky',
  confidence: 'high',
  reason: '3 retry flips across 12 runs',
  history: [],
};

const entry: QuarantineEntry = {
  testId: signal.testId,
  file: 'e2e/shop.spec.ts',
  quarantinedAt: '2026-07-12T00:00:00.000Z',
  flakinessScore: 0.42,
  confidence: 'high',
  clusterId: 'abc123def456',
};

const cluster: InterpretedCluster = {
  id: 'abc123def456',
  representativeTrace: 'TimeoutError: waiting for getByText(Paid)\n  at shop.spec.ts:12',
  tests: [signal.testId],
  firstSeen: '2026-06-01T00:00:00.000Z',
  lastSeen: '2026-07-10T00:00:00.000Z',
  occurrences: 9,
  hypothesis: { category: 'timeout', explanation: 'payment webhook slower than the 5s wait' },
};

function mockClient(overrides: Partial<Record<string, unknown>> = {}): {
  client: IssueClient;
  create: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  pullsCreate: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => ({
    data: { number: 12, html_url: 'https://github.com/o/r/issues/12' },
  }));
  const createComment = vi.fn(async () => ({}));
  const update = vi.fn(async () => ({}));
  const pullsCreate = vi.fn(async () => ({
    data: { html_url: 'https://github.com/o/r/pull/34' },
  }));
  const client = {
    rest: {
      issues: { create, createComment, update, ...overrides },
      pulls: { create: pullsCreate },
    },
  } as unknown as IssueClient;
  return { client, create, createComment, update, pullsCreate };
}

const repo = { owner: 'o', repo: 'r' };

describe('repo parsing', () => {
  it('parses an owner/repo slug', () => {
    expect(parseRepoSlug('mayageva11/flakehound')).toEqual({
      owner: 'mayageva11',
      repo: 'flakehound',
    });
    expect(parseRepoSlug('not a slug')).toBeUndefined();
    expect(parseRepoSlug('too/many/parts')).toBeUndefined();
  });

  it('parses ssh and https remote urls, with and without .git', () => {
    expect(parseRepoFromRemoteUrl('git@github.com:o/r.git')).toEqual(repo);
    expect(parseRepoFromRemoteUrl('git@github.com:o/r')).toEqual(repo);
    expect(parseRepoFromRemoteUrl('https://github.com/o/r.git')).toEqual(repo);
    expect(parseRepoFromRemoteUrl('https://github.com/o/r')).toEqual(repo);
    expect(parseRepoFromRemoteUrl('ssh://git@github.com/o/r.git')).toEqual(repo);
    expect(parseRepoFromRemoteUrl('not-a-remote')).toBeUndefined();
  });
});

describe('issue content', () => {
  it('builds a title from the testId', () => {
    expect(buildIssueTitle(signal)).toBe(
      "flakehound: quarantined flaky test 'shop.spec.ts > checkout > pays with saved card'",
    );
  });

  it('includes evidence, cluster trace, and the AI hypothesis when present', () => {
    const body = buildIssueBody(signal, entry, cluster, 10);
    expect(body).toContain('`shop.spec.ts > checkout > pays with saved card`');
    expect(body).toContain('`e2e/shop.spec.ts`');
    expect(body).toContain('**Flakiness score:** 0.42 · **Confidence:** high');
    expect(body).toContain('**Why flaky:** 3 retry flips across 12 runs');
    expect(body).toContain('### Failure cluster `abc123def456` (9 occurrences)');
    expect(body).toContain('**AI hypothesis:** timeout — payment webhook slower than the 5s wait');
    expect(body).toContain('TimeoutError: waiting for getByText(Paid)');
    expect(body).toContain('after 10 consecutive clean passes');
  });

  it('omits the cluster section and hypothesis line when absent', () => {
    const body = buildIssueBody({ ...signal, reason: undefined } as TestSignal, entry, undefined, 5);
    expect(body).not.toContain('Failure cluster');
    expect(body).not.toContain('AI hypothesis');
    expect(body).not.toContain('Why flaky');
  });
});

describe('issue lifecycle', () => {
  it('creates an issue and returns its reference', async () => {
    const { client, create } = mockClient();
    const warn = vi.fn();
    const ref = await createQuarantineIssue(client, repo, signal, entry, cluster, 10, warn);

    expect(ref).toEqual({ number: 12, url: 'https://github.com/o/r/issues/12' });
    expect(warn).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        title: buildIssueTitle(signal),
        labels: ['flaky-test', 'flakehound'],
      }),
    );
  });

  it('degrades to no issue on API failure', async () => {
    const { client } = mockClient({ create: vi.fn(async () => Promise.reject(new Error('403'))) });
    const warn = vi.fn();
    const ref = await createQuarantineIssue(client, repo, signal, entry, cluster, 10, warn);

    expect(ref).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('403');
  });

  it('closes an issue with a release comment', async () => {
    const { client, createComment, update } = mockClient();
    const warn = vi.fn();
    await closeQuarantineIssue(client, repo, { number: 12, url: 'u' }, signal.testId, warn);

    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 12, body: expect.stringContaining('released') }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 12, state: 'closed' }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns but does not throw when closing fails', async () => {
    const { client } = mockClient({ update: vi.fn(async () => Promise.reject(new Error('500'))) });
    const warn = vi.fn();
    await expect(
      closeQuarantineIssue(client, repo, { number: 12, url: 'u' }, signal.testId, warn),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('openQuarantinePr', () => {
  it('opens a PR and returns its url', async () => {
    const { client, pullsCreate } = mockClient();
    const url = await openQuarantinePr(client, repo, {
      title: 'flakehound: quarantine 2 flaky tests, release 1 stable test',
      head: 'flakehound/quarantine-2026-07-12',
      base: 'main',
      body: 'details',
    });
    expect(url).toBe('https://github.com/o/r/pull/34');
    expect(pullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ head: 'flakehound/quarantine-2026-07-12', base: 'main' }),
    );
  });

  it('throws FlakehoundError when PR creation fails (branch already pushed)', async () => {
    const { client } = mockClient();
    (client.rest.pulls.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('422 validation failed'),
    );
    await expect(
      openQuarantinePr(client, repo, { title: 't', head: 'h', base: 'main', body: 'b' }),
    ).rejects.toThrow(FlakehoundError);
  });
});
