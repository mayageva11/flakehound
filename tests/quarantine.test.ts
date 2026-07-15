import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueClient } from '../src/quarantine/github.js';
import type { GitRunner } from '../src/quarantine/git.js';
import { runQuarantine } from '../src/quarantine/run.js';
import { QUARANTINE_TAG } from '../src/quarantine/types.js';
import type { QuarantineAnnotator } from '../src/quarantine/types.js';
import type { FlakehoundReport } from '../src/report/types.js';
import type { HistoryEntry, TestSignal } from '../src/signal/types.js';
import { FlakehoundError } from '../src/util/errors.js';

const specsDir = fileURLToPath(new URL('./fixtures/quarantine/specs', import.meta.url));
const TEST_ID = 'e2e/shop.spec.ts > pays with saved card';

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'flakehound-e2e-'));
  await mkdir(path.join(projectDir, 'e2e'), { recursive: true });
  await copyFile(path.join(specsDir, 'plain.spec.ts'), path.join(projectDir, 'e2e', 'shop.spec.ts'));
  await writeFile(
    path.join(projectDir, 'flakehound.config.json'),
    JSON.stringify({ quarantine: { github: { repo: 'o/r' } } }),
    'utf8',
  );
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function run(day: number, verdict: HistoryEntry['verdict'], retryFlips = 0): HistoryEntry {
  return { timestamp: `2026-07-${String(day).padStart(2, '0')}T12:00:00.000Z`, verdict, retryFlips };
}

function flakySignal(over: Partial<TestSignal> = {}): TestSignal {
  return {
    testId: TEST_ID,
    flakinessScore: 0.42,
    classification: 'flaky',
    confidence: 'high',
    reason: '3 retry flips across 12 runs',
    history: [run(1, 'pass'), run(2, 'fail'), run(3, 'pass', 1)],
    ...over,
  };
}

async function writeReport(signals: TestSignal[]): Promise<void> {
  const report: FlakehoundReport = {
    version: 1,
    generatedAt: '2026-07-12T00:00:00.000Z',
    summary: {
      filesParsed: 1,
      testRuns: signals.length,
      testsAnalyzed: signals.length,
      metadataSources: { sidecar: 0, dirname: 0, mtime: signals.length },
    },
    signals,
    clusters: [
      {
        id: 'abc123def456',
        representativeTrace: 'TimeoutError: waiting for getByText(Paid)',
        tests: [TEST_ID],
        firstSeen: '2026-07-01T00:00:00.000Z',
        lastSeen: '2026-07-10T00:00:00.000Z',
        occurrences: 4,
      },
    ],
    gate: {
      baselineUsed: false,
      newRegressions: [],
      knownRegressions: [],
      resolvedRegressions: [],
      newClusters: [],
      knownClusters: [],
    },
  };
  await writeFile(
    path.join(projectDir, 'flakehound.report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
}

function mockGithub() {
  const create = vi.fn(async () => ({
    data: { number: 12, html_url: 'https://github.com/o/r/issues/12' },
  }));
  const createComment = vi.fn(async () => ({}));
  const update = vi.fn(async () => ({}));
  const pullsCreate = vi.fn(async () => ({ data: { html_url: 'https://github.com/o/r/pull/34' } }));
  const client = {
    rest: { issues: { create, createComment, update }, pulls: { create: pullsCreate } },
  } as unknown as IssueClient;
  return { client, create, createComment, update, pullsCreate };
}

function fakeGit(script: Record<string, { stdout?: string; exitCode?: number }>): {
  git: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: GitRunner = {
    async run(args) {
      calls.push(args);
      const key = Object.keys(script).find((k) => args.join(' ').startsWith(k));
      const found = key === undefined ? {} : script[key]!;
      return { stdout: found.stdout ?? '', exitCode: found.exitCode ?? 0 };
    },
  };
  return { git, calls };
}

const silent = { log: () => {}, warn: () => {} };

describe('flakehound quarantine — end to end', () => {
  it('dry-run proposes actions with exit 1 and touches nothing', async () => {
    await writeReport([flakySignal()]);
    const specBefore = await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8');
    const { client, create } = mockGithub();

    const logs: string[] = [];
    const result = await runQuarantine({
      cwd: projectDir,
      github: client,
      log: (m) => logs.push(m),
      warn: () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.quarantined).toEqual([TEST_ID]);
    expect(create).not.toHaveBeenCalled();
    expect(await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8')).toBe(specBefore);
    expect(existsSync(path.join(projectDir, 'flakehound.quarantine.json'))).toBe(false);
    expect(logs.join('\n')).toContain('dry-run');
  });

  it('apply edits the spec, files an issue, and records state', async () => {
    await writeReport([flakySignal()]);
    const { client, create } = mockGithub();

    const result = await runQuarantine({
      cwd: projectDir,
      mode: 'apply',
      github: client,
      now: () => new Date('2026-07-12T10:00:00.000Z'),
      ...silent,
    });

    expect(result.exitCode).toBe(1);
    expect(result.quarantined).toEqual([TEST_ID]);

    const spec = await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8');
    expect(spec).toContain(`tag: '${QUARANTINE_TAG}'`);
    expect(spec).toContain('issue=https://github.com/o/r/issues/12');
    expect(spec).toContain('cluster=abc123def456');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'o',
        repo: 'r',
        title: expect.stringContaining(TEST_ID),
        body: expect.stringContaining('TimeoutError'),
      }),
    );

    const state = JSON.parse(
      await readFile(path.join(projectDir, 'flakehound.quarantine.json'), 'utf8'),
    );
    expect(state.quarantined).toHaveLength(1);
    expect(state.quarantined[0]).toMatchObject({
      testId: TEST_ID,
      file: path.join('e2e', 'shop.spec.ts'),
      quarantinedAt: '2026-07-12T10:00:00.000Z',
      clusterId: 'abc123def456',
      issue: { number: 12, url: 'https://github.com/o/r/issues/12' },
    });
  });

  it('rolls back the filed issue when the real edit fails after the probe', async () => {
    await writeReport([flakySignal()]);
    const { client, create, update } = mockGithub();
    // Probe (dry-run) passes so the issue gets filed, then the real write fails
    // — exercising the orphan-issue rollback path.
    const annotator: QuarantineAnnotator = {
      name: 'fake',
      tag: QUARANTINE_TAG,
      quarantine: async (target, _marker, opts) =>
        opts.dryRun
          ? { status: 'annotated', filePath: target.filePath }
          : { status: 'not-found', detail: 'simulated write failure' },
      release: async () => ({ status: 'already-annotated' }),
      readMarker: async () => undefined,
    };

    const result = await runQuarantine({
      cwd: projectDir,
      mode: 'apply',
      github: client,
      annotator,
      ...silent,
    });

    expect(result.quarantined).toEqual([]);
    expect(create).toHaveBeenCalledTimes(1);
    // The just-filed issue #12 is closed so a re-run won't duplicate it.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 12, state: 'closed' }));
    const state = JSON.parse(
      await readFile(path.join(projectDir, 'flakehound.quarantine.json'), 'utf8'),
    );
    expect(state.quarantined).toEqual([]);
  });

  it('a second apply run is a no-op with exit 0', async () => {
    await writeReport([flakySignal()]);
    const { client, create } = mockGithub();
    await runQuarantine({ cwd: projectDir, mode: 'apply', github: client, ...silent });
    const specAfterFirst = await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8');

    const second = await runQuarantine({ cwd: projectDir, mode: 'apply', github: client, ...silent });
    expect(second.exitCode).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8')).toBe(specAfterFirst);
  });

  it('releases a stabilized test: tag removed, issue closed, state pruned', async () => {
    const original = await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8');
    await writeReport([flakySignal()]);
    const { client, createComment, update } = mockGithub();
    await runQuarantine({
      cwd: projectDir,
      mode: 'apply',
      github: client,
      now: () => new Date('2026-07-12T10:00:00.000Z'),
      ...silent,
    });

    // Ten clean passes after the quarantine timestamp → releasable.
    const stableHistory = Array.from({ length: 10 }, (_, i) => run(13 + i, 'pass'));
    await writeReport([
      flakySignal({ classification: 'stable', flakinessScore: 0, history: stableHistory }),
    ]);

    const result = await runQuarantine({ cwd: projectDir, mode: 'apply', github: client, ...silent });
    expect(result.exitCode).toBe(1);
    expect(result.released).toEqual([TEST_ID]);

    expect(await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8')).toBe(original);
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 12 }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 12, state: 'closed' }));
    const state = JSON.parse(
      await readFile(path.join(projectDir, 'flakehound.quarantine.json'), 'utf8'),
    );
    expect(state.quarantined).toEqual([]);
  });

  it('exits 0 when there is nothing to do', async () => {
    await writeReport([flakySignal({ classification: 'stable', flakinessScore: 0 })]);
    const result = await runQuarantine({ cwd: projectDir, ...silent });
    expect(result).toMatchObject({ exitCode: 0, quarantined: [], released: [] });
  });

  it('respects --no-issues', async () => {
    await writeReport([flakySignal()]);
    const { client, create } = mockGithub();
    await runQuarantine({ cwd: projectDir, mode: 'apply', github: client, issues: false, ...silent });

    expect(create).not.toHaveBeenCalled();
    const spec = await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8');
    expect(spec).toContain('issue=pending');
  });

  it('quarantines without issues (with a warning) when GitHub is unavailable', async () => {
    await writeReport([flakySignal()]);
    const warnings: string[] = [];
    // No injected client and no GITHUB_TOKEN → degrade, never block the edit.
    const original = process.env['GITHUB_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    try {
      const result = await runQuarantine({
        cwd: projectDir,
        mode: 'apply',
        log: () => {},
        warn: (m) => warnings.push(m),
      });
      expect(result.quarantined).toEqual([TEST_ID]);
      expect(warnings.some((w) => w.includes('GITHUB_TOKEN'))).toBe(true);
    } finally {
      if (original !== undefined) process.env['GITHUB_TOKEN'] = original;
    }
  });

  it('--pr branches, commits, pushes, and opens the PR', async () => {
    await writeReport([flakySignal()]);
    const { client, pullsCreate } = mockGithub();
    const { git, calls } = fakeGit({
      'rev-parse --is-inside-work-tree': { stdout: 'true\n' },
      status: { stdout: '' },
      'symbolic-ref': { stdout: 'origin/main\n' },
    });

    const result = await runQuarantine({
      cwd: projectDir,
      mode: 'pr',
      github: client,
      git,
      now: () => new Date('2026-07-12T10:00:00.000Z'),
      ...silent,
    });

    expect(result.prUrl).toBe('https://github.com/o/r/pull/34');
    const flat = calls.map((c) => c.join(' '));
    expect(flat).toContain('switch -c flakehound/quarantine-2026-07-12');
    expect(flat.some((c) => c.startsWith('add -- ') && c.includes('shop.spec.ts'))).toBe(true);
    expect(flat).toContain('commit -m flakehound: quarantine 1 flaky test');
    expect(flat).toContain('push -u origin flakehound/quarantine-2026-07-12');
    expect(pullsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        head: 'flakehound/quarantine-2026-07-12',
        base: 'main',
        title: 'flakehound: quarantine 1 flaky test',
      }),
    );
  });

  it('--commit refuses to run on a dirty worktree before editing anything', async () => {
    await writeReport([flakySignal()]);
    const specBefore = await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8');
    const { git } = fakeGit({
      'rev-parse --is-inside-work-tree': { stdout: 'true\n' },
      status: { stdout: ' M e2e/shop.spec.ts\n' },
    });

    await expect(
      runQuarantine({ cwd: projectDir, mode: 'commit', git, ...silent }),
    ).rejects.toThrow(FlakehoundError);
    expect(await readFile(path.join(projectDir, 'e2e', 'shop.spec.ts'), 'utf8')).toBe(specBefore);
  });

  it('fails loudly when the report is missing', async () => {
    await expect(runQuarantine({ cwd: projectDir, ...silent })).rejects.toThrow(FlakehoundError);
    await expect(runQuarantine({ cwd: projectDir, ...silent })).rejects.toThrow(/flakehound analyze/);
  });

  it('skips unlocatable tests safely and exits 0 when nothing else is actionable', async () => {
    await writeReport([flakySignal({ testId: 'com.example.FooTest > testBar' })]);
    const warnings: string[] = [];
    const result = await runQuarantine({
      cwd: projectDir,
      mode: 'apply',
      log: () => {},
      warn: (m) => warnings.push(m),
    });

    expect(result.exitCode).toBe(0);
    expect(result.skipped).toEqual(['com.example.FooTest > testBar']);
    expect(warnings.some((w) => w.includes('skipping'))).toBe(true);
    expect(existsSync(path.join(projectDir, 'flakehound.quarantine.json'))).toBe(false);
  });
});
