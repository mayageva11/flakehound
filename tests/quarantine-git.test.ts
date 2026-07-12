import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  commitFiles,
  createBranch,
  ExecGitRunner,
  isGitRepo,
  isWorktreeCleanFor,
  push,
  remoteOriginUrl,
  resolveBaseBranch,
} from '../src/quarantine/git.js';
import type { GitRunner } from '../src/quarantine/git.js';
import { FlakehoundError } from '../src/util/errors.js';

const execFileAsync = promisify(execFile);

/** Scripted double: maps a joined arg prefix to a canned response. */
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

describe('git helpers (fake runner)', () => {
  it('isGitRepo reflects rev-parse exit code', async () => {
    expect(await isGitRepo(fakeGit({ 'rev-parse': { exitCode: 0 } }).git)).toBe(true);
    expect(await isGitRepo(fakeGit({ 'rev-parse': { exitCode: 128 } }).git)).toBe(false);
  });

  it('isWorktreeCleanFor is true only for empty porcelain output', async () => {
    expect(await isWorktreeCleanFor(fakeGit({ status: { stdout: '' } }).git, ['a.ts'])).toBe(true);
    expect(
      await isWorktreeCleanFor(fakeGit({ status: { stdout: ' M a.ts\n' } }).git, ['a.ts']),
    ).toBe(false);
  });

  it('remoteOriginUrl returns the trimmed url or undefined', async () => {
    expect(
      await remoteOriginUrl(fakeGit({ remote: { stdout: 'git@github.com:o/r.git\n' } }).git),
    ).toBe('git@github.com:o/r.git');
    expect(await remoteOriginUrl(fakeGit({ remote: { exitCode: 2 } }).git)).toBeUndefined();
  });

  it('resolveBaseBranch prefers origin HEAD, then current branch, then main', async () => {
    expect(
      await resolveBaseBranch(fakeGit({ 'symbolic-ref': { stdout: 'origin/trunk\n' } }).git),
    ).toBe('trunk');
    expect(
      await resolveBaseBranch(
        fakeGit({
          'symbolic-ref': { exitCode: 128 },
          'rev-parse --abbrev-ref HEAD': { stdout: 'feature\n' },
        }).git,
      ),
    ).toBe('feature');
    expect(
      await resolveBaseBranch(
        fakeGit({
          'symbolic-ref': { exitCode: 128 },
          'rev-parse --abbrev-ref HEAD': { stdout: 'HEAD\n' },
        }).git,
      ),
    ).toBe('main');
  });

  it('commitFiles stages only the given files then commits', async () => {
    const { git, calls } = fakeGit({});
    await commitFiles(git, ['e2e/shop.spec.ts', 'flakehound.quarantine.json'], 'msg');
    expect(calls).toEqual([
      ['add', '--', 'e2e/shop.spec.ts', 'flakehound.quarantine.json'],
      ['commit', '-m', 'msg'],
    ]);
  });

  it('branch/commit/push failures raise FlakehoundError', async () => {
    const failing = fakeGit({
      switch: { exitCode: 128 },
      add: { exitCode: 1 },
      push: { exitCode: 1 },
    }).git;
    await expect(createBranch(failing, 'b')).rejects.toThrow(FlakehoundError);
    await expect(commitFiles(failing, ['a'], 'm')).rejects.toThrow(FlakehoundError);
    await expect(push(failing, 'b')).rejects.toThrow(FlakehoundError);
  });
});

describe('ExecGitRunner (real git in a temp repo)', () => {
  it('creates a branch and commits files end to end', async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), 'flakehound-git-'));
    try {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.email', 'test@flakehound.dev'], { cwd: repoDir });
      await execFileAsync('git', ['config', 'user.name', 'flakehound test'], { cwd: repoDir });
      await writeFile(path.join(repoDir, 'a.spec.ts'), 'original\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir });

      const git = new ExecGitRunner(repoDir);
      expect(await isGitRepo(git)).toBe(true);
      expect(await isWorktreeCleanFor(git, ['a.spec.ts'])).toBe(true);

      await writeFile(path.join(repoDir, 'a.spec.ts'), 'quarantined\n', 'utf8');
      expect(await isWorktreeCleanFor(git, ['a.spec.ts'])).toBe(false);

      await createBranch(git, 'flakehound/quarantine-2026-07-12');
      await commitFiles(git, ['a.spec.ts'], 'flakehound: quarantine 1 flaky test');

      const { stdout: branch } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoDir,
      });
      expect(branch.trim()).toBe('flakehound/quarantine-2026-07-12');
      const { stdout: log } = await execFileAsync('git', ['log', '-1', '--pretty=%s'], {
        cwd: repoDir,
      });
      expect(log.trim()).toBe('flakehound: quarantine 1 flaky test');
      expect(await isWorktreeCleanFor(git, ['a.spec.ts'])).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('reports a non-zero exit code without throwing', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'flakehound-nogit-'));
    try {
      const git = new ExecGitRunner(outsideDir);
      const result = await git.run(['rev-parse', '--is-inside-work-tree']);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
