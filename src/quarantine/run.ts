import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import type { FlakehoundReport } from '../report/types.js';
import { FlakehoundError } from '../util/errors.js';
import { PlaywrightAnnotator } from './annotator/playwright.js';
import { selectQuarantineCandidates, selectReleaseCandidates } from './candidates.js';
import {
  closeQuarantineIssue,
  createQuarantineIssue,
  openQuarantinePr,
  parseRepoFromRemoteUrl,
  parseRepoSlug,
} from './github.js';
import type { IssueClient, RepoRef } from './github.js';
import {
  commitFiles,
  createBranch,
  ExecGitRunner,
  isGitRepo,
  isWorktreeCleanFor,
  push,
  remoteOriginUrl,
  resolveBaseBranch,
} from './git.js';
import type { GitRunner } from './git.js';
import { resolveSpecFile } from './locate.js';
import { loadState, writeState } from './state.js';
import { renderQuarantinePlan } from './terminal.js';
import type { QuarantinePlan } from './terminal.js';
import type {
  AnnotationTarget,
  QuarantineAnnotator,
  QuarantineEntry,
  QuarantineState,
} from './types.js';

export type QuarantineMode = 'dry-run' | 'apply' | 'commit' | 'pr';

export interface RunQuarantineOptions {
  cwd?: string;
  configPath?: string;
  /** Report to read; default is the configured analyze output path. */
  reportPath?: string;
  /** State file; default is config.quarantine.state. */
  statePath?: string;
  /** Escalation ladder; each step implies the previous. Default: dry-run. */
  mode?: QuarantineMode;
  /** Branch name for commit/pr modes. */
  branch?: string;
  /** false = --no-issues: skip GitHub issue creation/closing. */
  issues?: boolean;
  /** Injection points (tests, embedding): clock, GitHub client, git, annotator, streams. */
  now?: () => Date;
  github?: IssueClient;
  git?: GitRunner;
  annotator?: QuarantineAnnotator;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface RunQuarantineResult {
  /** 0 = nothing to do; 1 = actions taken (or proposed, in dry-run). Tool errors throw → exit 2. */
  exitCode: 0 | 1;
  quarantined: string[];
  released: string[];
  skipped: string[];
  prUrl?: string;
}

export async function runQuarantine(
  options: RunQuarantineOptions = {},
): Promise<RunQuarantineResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string) => console.error(message));
  const mode = options.mode ?? 'dry-run';
  const dryRun = mode === 'dry-run';

  const config = await loadConfig({
    cwd,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });
  const quarantineCfg = config.quarantine;

  const reportPath = path.resolve(cwd, options.reportPath ?? config.output);
  const report = await loadReport(reportPath);
  const statePath = path.resolve(cwd, options.statePath ?? quarantineCfg.state);
  const state = await loadState(statePath);

  const candidates = selectQuarantineCandidates(
    report,
    state,
    quarantineCfg,
    config.signal.flakinessThreshold,
  );
  const releases = selectReleaseCandidates(report, state, quarantineCfg);

  // Quarantined tests that stopped appearing in the report (renamed? removed?)
  // are surfaced but kept — releasing blind would leave a dangling tag anyway.
  const signalIds = new Set(report.signals.map((signal) => signal.testId));
  for (const entry of state.quarantined) {
    if (!signalIds.has(entry.testId)) {
      warn(
        `flakehound: quarantined test '${entry.testId}' no longer appears in the report — keeping it quarantined`,
      );
    }
  }

  if (candidates.length === 0 && releases.length === 0) {
    log('flakehound: nothing to quarantine or release');
    return { exitCode: 0, quarantined: [], released: [], skipped: [] };
  }

  // Resolve every edit location up front: skips are decided before any file,
  // git, or GitHub action happens, and the dry-run plan equals the real plan.
  const skipped: { testId: string; reason: string }[] = [];
  const quarantineActions: { signal: (typeof candidates)[number]; target: AnnotationTarget }[] = [];
  for (const signal of candidates) {
    const located = await resolveSpecFile(signal.testId, cwd);
    if (located.status !== 'found') {
      skipped.push({ testId: signal.testId, reason: located.detail });
      continue;
    }
    quarantineActions.push({ signal, target: located.target });
  }

  const releaseActions: { entry: QuarantineEntry; target: AnnotationTarget }[] = [];
  for (const entry of releases) {
    const located = await resolveSpecFile(entry.testId, cwd);
    if (located.status !== 'found') {
      skipped.push({
        testId: entry.testId,
        reason: `${located.detail} — keeping it in the state file`,
      });
      continue;
    }
    releaseActions.push({ entry, target: located.target });
  }

  for (const skip of skipped) {
    warn(`flakehound: skipping '${skip.testId}' — ${skip.reason}`);
  }

  if (quarantineActions.length === 0 && releaseActions.length === 0) {
    log('flakehound: no actionable candidates (all skipped) — nothing changed');
    return { exitCode: 0, quarantined: [], released: [], skipped: skipped.map((s) => s.testId) };
  }

  const clusterFor = (testId: string) =>
    report.clusters.find((cluster) => cluster.tests.includes(testId));

  if (dryRun) {
    const plan: QuarantinePlan = {
      quarantine: quarantineActions.map(({ signal, target }) => ({
        testId: signal.testId,
        file: path.relative(cwd, target.filePath),
        flakinessScore: signal.flakinessScore,
        confidence: signal.confidence,
        ...(clusterFor(signal.testId) !== undefined
          ? { clusterId: clusterFor(signal.testId)!.id }
          : {}),
      })),
      release: releaseActions.map(({ entry, target }) => ({
        testId: entry.testId,
        file: path.relative(cwd, target.filePath),
        ...(entry.issue !== undefined ? { issueUrl: entry.issue.url } : {}),
      })),
      skipped,
    };
    log(renderQuarantinePlan(plan, { dryRun: true }));
    return {
      exitCode: 1,
      quarantined: plan.quarantine.map((i) => i.testId),
      released: plan.release.map((i) => i.testId),
      skipped: skipped.map((s) => s.testId),
    };
  }

  // ---- apply / commit / pr ----

  const git = options.git ?? new ExecGitRunner(cwd);
  const touchedSpecs = [
    ...new Set(
      [...quarantineActions, ...releaseActions].map(({ target }) =>
        path.relative(cwd, target.filePath),
      ),
    ),
  ];

  // Preflight before ANY edit: never mix user changes into a flakehound commit.
  if (mode === 'commit' || mode === 'pr') {
    if (!(await isGitRepo(git))) {
      throw new FlakehoundError(`--${mode === 'pr' ? 'pr' : 'commit'} requires a git repository`);
    }
    const checkFiles = [...touchedSpecs, path.relative(cwd, statePath)];
    if (!(await isWorktreeCleanFor(git, checkFiles))) {
      throw new FlakehoundError(
        'the files to be edited have uncommitted changes — commit or stash them first, flakehound will not mix your edits into its commit',
      );
    }
  }

  const { github, repo } = await resolveGithub(options, quarantineCfg, git, warn);
  const annotator = options.annotator ?? new PlaywrightAnnotator();

  const quarantinedNow: QuarantineEntry[] = [];
  for (const { signal, target } of quarantineActions) {
    // Probe first so a test we cannot edit never gets an orphan GitHub issue.
    const probe = await annotator.quarantine(target, {}, { dryRun: true });
    if (probe.status === 'not-found' || probe.status === 'ambiguous') {
      skipped.push({ testId: signal.testId, reason: probe.detail });
      warn(`flakehound: skipping '${signal.testId}' — ${probe.detail}`);
      continue;
    }

    const cluster = clusterFor(signal.testId);
    const entry: QuarantineEntry = {
      testId: signal.testId,
      file: path.relative(cwd, target.filePath),
      quarantinedAt: now().toISOString(),
      flakinessScore: signal.flakinessScore,
      confidence: signal.confidence,
      ...(cluster !== undefined ? { clusterId: cluster.id } : {}),
    };

    if (probe.status === 'already-annotated') {
      // Tag and marker already in the file but missing from state (drift):
      // adopt it, recovering the issue link from the marker if present.
      const marker = await annotator.readMarker(target);
      quarantinedNow.push(entry);
      if (marker?.issueUrl !== undefined) {
        warn(
          `flakehound: '${signal.testId}' was already annotated — adopting it into the state file (${marker.issueUrl})`,
        );
      }
      continue;
    }

    const issue =
      github !== undefined
        ? await createQuarantineIssue(
            github.client,
            github.repo,
            signal,
            entry,
            cluster,
            quarantineCfg.stableRunsToRelease,
            warn,
          )
        : undefined;
    const withIssue: QuarantineEntry = { ...entry, ...(issue !== undefined ? { issue } : {}) };

    const result = await annotator.quarantine(
      target,
      {
        ...(cluster !== undefined ? { clusterId: cluster.id } : {}),
        ...(issue !== undefined ? { issueUrl: issue.url } : {}),
      },
      { dryRun: false },
    );
    if (result.status === 'annotated' || result.status === 'already-annotated') {
      quarantinedNow.push(withIssue);
    } else {
      // The issue was filed before the (now-failed) edit — roll it back so a
      // re-run doesn't file a duplicate. Best-effort: a close failure still
      // leaves the test skipped.
      if (issue !== undefined && github !== undefined) {
        await closeQuarantineIssue(github.client, github.repo, issue, signal.testId, warn);
      }
      skipped.push({ testId: signal.testId, reason: result.detail });
      warn(`flakehound: skipping '${signal.testId}' — ${result.detail}`);
    }
  }

  const releasedNow: QuarantineEntry[] = [];
  for (const { entry, target } of releaseActions) {
    const result = await annotator.release(target, { dryRun: false });
    if (result.status === 'not-found' || result.status === 'ambiguous') {
      skipped.push({ testId: entry.testId, reason: `${result.detail} — keeping it in the state file` });
      warn(`flakehound: could not release '${entry.testId}' — ${result.detail}`);
      continue;
    }
    if (entry.issue !== undefined && github !== undefined) {
      await closeQuarantineIssue(github.client, github.repo, entry.issue, entry.testId, warn);
    }
    releasedNow.push(entry);
  }

  const releasedIds = new Set(releasedNow.map((entry) => entry.testId));
  const nextState: QuarantineState = {
    version: 1,
    quarantined: [
      ...state.quarantined.filter((entry) => !releasedIds.has(entry.testId)),
      ...quarantinedNow,
    ],
  };
  await writeState(statePath, nextState);

  let prUrl: string | undefined;
  if ((mode === 'commit' || mode === 'pr') && (quarantinedNow.length > 0 || releasedNow.length > 0)) {
    const summaryTitle = buildSummaryTitle(quarantinedNow.length, releasedNow.length);
    // Base must be captured before switching to the quarantine branch.
    const base = await resolveBaseBranch(git);
    const branch = options.branch ?? `flakehound/quarantine-${now().toISOString().slice(0, 10)}`;
    await createBranch(git, branch);
    await commitFiles(git, [...touchedSpecs, path.relative(cwd, statePath)], summaryTitle);
    log(`flakehound: committed to branch '${branch}'`);

    if (mode === 'pr') {
      if (repo === undefined) {
        throw new FlakehoundError(
          '--pr needs a GitHub repo — set quarantine.github.repo or add an origin remote',
        );
      }
      const client = github?.client ?? (await defaultIssueClient());
      if (client === undefined) {
        throw new FlakehoundError('--pr needs a GITHUB_TOKEN environment variable');
      }
      await push(git, branch);
      prUrl = await openQuarantinePr(client, repo, {
        title: summaryTitle,
        head: branch,
        base,
        body: buildPrBody(quarantinedNow, releasedNow),
      });
      log(`flakehound: opened ${prUrl}`);
    }
  }

  const plan: QuarantinePlan = {
    quarantine: quarantinedNow.map((entry) => ({
      testId: entry.testId,
      file: entry.file,
      flakinessScore: entry.flakinessScore,
      confidence: entry.confidence,
      ...(entry.clusterId !== undefined ? { clusterId: entry.clusterId } : {}),
      ...(entry.issue !== undefined ? { issueUrl: entry.issue.url } : {}),
    })),
    release: releasedNow.map((entry) => ({
      testId: entry.testId,
      file: entry.file,
      ...(entry.issue !== undefined ? { issueUrl: entry.issue.url } : {}),
    })),
    skipped,
  };
  log(renderQuarantinePlan(plan, { dryRun: false }));

  return {
    exitCode: quarantinedNow.length > 0 || releasedNow.length > 0 ? 1 : 0,
    quarantined: quarantinedNow.map((entry) => entry.testId),
    released: releasedNow.map((entry) => entry.testId),
    skipped: skipped.map((s) => s.testId),
    ...(prUrl !== undefined ? { prUrl } : {}),
  };
}

/**
 * No-silent-pass: quarantining from a missing or unreadable report is a
 * misconfiguration, not a "clean" state — unlike the lenient baseline loader.
 */
async function loadReport(filePath: string): Promise<FlakehoundReport> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    throw new FlakehoundError(
      `no report found at ${filePath}\n` +
        `  run 'flakehound analyze' first, or point --report at an existing flakehound.report.json`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new FlakehoundError(`invalid JSON in report ${filePath}`, { cause });
  }
  const report = parsed as FlakehoundReport;
  if (report.version !== 1 || !Array.isArray(report.signals) || !Array.isArray(report.clusters)) {
    throw new FlakehoundError(`${filePath} is not a flakehound report (expected version 1)`);
  }
  return report;
}

/**
 * GitHub is optional everywhere except --pr: no token, no repo, or
 * createIssues=false all degrade to "quarantine without issues" with a single
 * warning — mirroring how the AI layer degrades to "report without hypotheses".
 */
async function resolveGithub(
  options: RunQuarantineOptions,
  quarantineCfg: { github: { createIssues: boolean; repo?: string | undefined } },
  git: GitRunner,
  warn: (message: string) => void,
): Promise<{ github?: { client: IssueClient; repo: RepoRef }; repo?: RepoRef }> {
  let repo: RepoRef | undefined;
  if (quarantineCfg.github.repo !== undefined) {
    repo = parseRepoSlug(quarantineCfg.github.repo);
  } else {
    const remote = await remoteOriginUrl(git);
    if (remote !== undefined) repo = parseRepoFromRemoteUrl(remote);
  }

  const issuesWanted = quarantineCfg.github.createIssues && options.issues !== false;
  if (!issuesWanted) return { ...(repo !== undefined ? { repo } : {}) };

  const client = options.github ?? (await defaultIssueClient());
  if (client === undefined) {
    warn('flakehound: GITHUB_TOKEN is not set — quarantining without GitHub issues');
    return { ...(repo !== undefined ? { repo } : {}) };
  }
  if (repo === undefined) {
    warn(
      'flakehound: no GitHub repo (set quarantine.github.repo or add an origin remote) — quarantining without issues',
    );
    return {};
  }
  return { github: { client, repo }, repo };
}

/** Real Octokit, loaded lazily and only when a token exists. */
async function defaultIssueClient(): Promise<IssueClient | undefined> {
  const token = process.env['GITHUB_TOKEN'];
  if (token === undefined || token === '') return undefined;
  const { Octokit } = await import('@octokit/rest');
  return new Octokit({ auth: token }) as unknown as IssueClient;
}

function buildSummaryTitle(quarantined: number, released: number): string {
  const parts: string[] = [];
  if (quarantined > 0) parts.push(`quarantine ${quarantined} flaky test${quarantined === 1 ? '' : 's'}`);
  if (released > 0) parts.push(`release ${released} stable test${released === 1 ? '' : 's'}`);
  return `flakehound: ${parts.join(', ')}`;
}

function buildPrBody(quarantined: QuarantineEntry[], released: QuarantineEntry[]): string {
  const lines: string[] = [];
  if (quarantined.length > 0) {
    lines.push('### Quarantined');
    for (const entry of quarantined) {
      const details = [
        `score ${entry.flakinessScore}`,
        ...(entry.clusterId !== undefined ? [`cluster \`${entry.clusterId}\``] : []),
        ...(entry.issue !== undefined ? [entry.issue.url] : []),
      ];
      lines.push(`- \`${entry.testId}\` — ${details.join(' · ')}`);
    }
  }
  if (released.length > 0) {
    lines.push('', '### Released (stable again)');
    for (const entry of released) {
      const details = entry.issue !== undefined ? ` — closes ${entry.issue.url}` : '';
      lines.push(`- \`${entry.testId}\`${details}`);
    }
  }
  lines.push(
    '',
    '---',
    'Opened by `flakehound quarantine`. Quarantined tests keep running under the `@flakehound-quarantined` tag and are released automatically once stable.',
  );
  return lines.join('\n');
}
