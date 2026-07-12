import type { InterpretedCluster } from '../ai/types.js';
import type { TestSignal } from '../signal/types.js';
import { FlakehoundError } from '../util/errors.js';
import type { QuarantineEntry, QuarantineIssueRef } from './types.js';

/**
 * Structural subset of Octokit, mirroring how HypothesisClient subsets the
 * Anthropic SDK: the orchestrator injects a real Octokit in production and
 * tests inject vi.fn() doubles — no vi.mock, no network.
 */
export interface IssueClient {
  rest: {
    issues: {
      create(params: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        labels?: string[];
      }): Promise<{ data: { number: number; html_url: string } }>;
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
      update(params: {
        owner: string;
        repo: string;
        issue_number: number;
        state: 'closed';
      }): Promise<unknown>;
    };
    pulls: {
      create(params: {
        owner: string;
        repo: string;
        title: string;
        head: string;
        base: string;
        body: string;
      }): Promise<{ data: { html_url: string } }>;
    };
  };
}

export interface RepoRef {
  owner: string;
  repo: string;
}

/** "owner/repo" → RepoRef. */
export function parseRepoSlug(slug: string): RepoRef | undefined {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(slug);
  if (match === null) return undefined;
  return { owner: match[1]!, repo: match[2]! };
}

/** Extract owner/repo from a git remote URL (ssh, https, or ssh:// forms). */
export function parseRepoFromRemoteUrl(url: string): RepoRef | undefined {
  const trimmed = url.trim();
  const match =
    /^git@[^:]+:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed) ??
    /^(?:https|ssh):\/\/(?:[^@/]+@)?[^/]+\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (match === null) return undefined;
  return { owner: match[1]!, repo: match[2]! };
}

export function buildIssueTitle(signal: TestSignal): string {
  return `flakehound: quarantined flaky test '${signal.testId}'`;
}

/** Pure — everything the report knows about why this test was quarantined. */
export function buildIssueBody(
  signal: TestSignal,
  entry: QuarantineEntry,
  cluster: InterpretedCluster | undefined,
  stableRunsToRelease: number,
): string {
  const lines = [
    `**Test:** \`${signal.testId}\``,
    `**File:** \`${entry.file}\``,
    `**Flakiness score:** ${signal.flakinessScore} · **Confidence:** ${signal.confidence}`,
  ];
  if (signal.reason !== undefined) lines.push(`**Why flaky:** ${signal.reason}`);

  if (cluster !== undefined) {
    lines.push('', `### Failure cluster \`${cluster.id}\` (${cluster.occurrences} occurrences)`);
    if (cluster.hypothesis !== undefined) {
      lines.push(
        `**AI hypothesis:** ${cluster.hypothesis.category} — ${cluster.hypothesis.explanation}`,
      );
    }
    lines.push('', '```', cluster.representativeTrace, '```');
  }

  lines.push(
    '',
    '---',
    `Quarantined automatically by [flakehound](https://github.com/mayageva11/flakehound): the test keeps running under the \`@flakehound-quarantined\` tag and will be released (and this issue closed) after ${stableRunsToRelease} consecutive clean passes.`,
  );
  return lines.join('\n');
}

/**
 * Issue creation degrades like the AI layer: any failure warns once and the
 * quarantine proceeds with `issue=pending` — GitHub availability must never
 * block the deterministic edit.
 */
export async function createQuarantineIssue(
  client: IssueClient,
  repo: RepoRef,
  signal: TestSignal,
  entry: QuarantineEntry,
  cluster: InterpretedCluster | undefined,
  stableRunsToRelease: number,
  warn: (message: string) => void,
): Promise<QuarantineIssueRef | undefined> {
  try {
    const { data } = await client.rest.issues.create({
      owner: repo.owner,
      repo: repo.repo,
      title: buildIssueTitle(signal),
      body: buildIssueBody(signal, entry, cluster, stableRunsToRelease),
      labels: ['flaky-test', 'flakehound'],
    });
    return { number: data.number, url: data.html_url };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    warn(
      `flakehound: could not create a GitHub issue for '${signal.testId}' — continuing without one (${detail})`,
    );
    return undefined;
  }
}

export async function closeQuarantineIssue(
  client: IssueClient,
  repo: RepoRef,
  issue: QuarantineIssueRef,
  testId: string,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await client.rest.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issue.number,
      body: `flakehound released \`${testId}\` from quarantine — the test has been stable and runs normally again.`,
    });
    await client.rest.issues.update({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issue.number,
      state: 'closed',
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    warn(`flakehound: could not close GitHub issue #${issue.number} for '${testId}' (${detail})`);
  }
}

/**
 * Unlike issues, a failed PR after a pushed branch is a hard error: the user
 * explicitly asked for a PR, and silence would strand the branch.
 */
export async function openQuarantinePr(
  client: IssueClient,
  repo: RepoRef,
  params: { title: string; head: string; base: string; body: string },
): Promise<string> {
  try {
    const { data } = await client.rest.pulls.create({
      owner: repo.owner,
      repo: repo.repo,
      ...params,
    });
    return data.html_url;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new FlakehoundError(
      `could not open the quarantine PR (branch '${params.head}' is pushed): ${detail}`,
      { cause },
    );
  }
}
