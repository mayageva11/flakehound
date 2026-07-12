import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FlakehoundError } from '../util/errors.js';

const execFileAsync = promisify(execFile);

/**
 * All git access goes through this seam so tests can fake it and the
 * orchestrator never spawns processes directly.
 */
export interface GitRunner {
  run(args: string[]): Promise<{ stdout: string; exitCode: number }>;
}

export class ExecGitRunner implements GitRunner {
  constructor(private readonly cwd: string) {}

  async run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: this.cwd });
      return { stdout, exitCode: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; code?: number | string };
      return {
        stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
        exitCode: typeof failed.code === 'number' ? failed.code : 1,
      };
    }
  }
}

export async function isGitRepo(git: GitRunner): Promise<boolean> {
  const { exitCode } = await git.run(['rev-parse', '--is-inside-work-tree']);
  return exitCode === 0;
}

/** True when none of the given files have uncommitted changes. */
export async function isWorktreeCleanFor(git: GitRunner, files: string[]): Promise<boolean> {
  const { stdout, exitCode } = await git.run(['status', '--porcelain', '--', ...files]);
  return exitCode === 0 && stdout.trim() === '';
}

export async function remoteOriginUrl(git: GitRunner): Promise<string | undefined> {
  const { stdout, exitCode } = await git.run(['remote', 'get-url', 'origin']);
  const url = stdout.trim();
  return exitCode === 0 && url !== '' ? url : undefined;
}

/** Base branch for the PR: origin's HEAD, else the current branch, else 'main'. */
export async function resolveBaseBranch(git: GitRunner): Promise<string> {
  const head = await git.run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head.exitCode === 0) {
    const name = head.stdout.trim().replace(/^origin\//, '');
    if (name !== '') return name;
  }
  const current = await git.run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = current.stdout.trim();
  if (current.exitCode === 0 && branch !== '' && branch !== 'HEAD') return branch;
  return 'main';
}

export async function createBranch(git: GitRunner, name: string): Promise<void> {
  const { exitCode } = await git.run(['switch', '-c', name]);
  if (exitCode !== 0) {
    throw new FlakehoundError(`could not create branch '${name}' (does it already exist?)`);
  }
}

export async function commitFiles(git: GitRunner, files: string[], message: string): Promise<void> {
  const add = await git.run(['add', '--', ...files]);
  if (add.exitCode !== 0) throw new FlakehoundError('git add failed for the quarantine edits');
  const commit = await git.run(['commit', '-m', message]);
  if (commit.exitCode !== 0) throw new FlakehoundError('git commit failed for the quarantine edits');
}

export async function push(git: GitRunner, branch: string): Promise<void> {
  const { exitCode } = await git.run(['push', '-u', 'origin', branch]);
  if (exitCode !== 0) {
    throw new FlakehoundError(
      `could not push branch '${branch}' to origin — check credentials and remote access`,
    );
  }
}
