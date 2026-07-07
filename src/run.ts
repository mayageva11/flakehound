import path from 'node:path';
import { interpretClusters } from './ai/index.js';
import type { HypothesisClient } from './ai/index.js';
import { clusterTestRuns } from './cluster/index.js';
import { findConfigFile, loadConfig } from './config/load.js';
import type { CliOverrides } from './config/load.js';
import { ingest } from './ingest/index.js';
import type { TestRun } from './ingest/types.js';
import { computeSignals } from './signal/index.js';
import { buildReport, diffAgainstBaseline, loadBaseline, renderReport, writeReport } from './report/index.js';
import type { FlakehoundReport } from './report/index.js';
import { FlakehoundError } from './util/errors.js';

export interface RunAnalyzeOptions {
  cwd?: string;
  configPath?: string;
  overrides?: CliOverrides;
  /** Injection points (tests, embedding): clock, AI client, output streams. */
  now?: () => Date;
  aiClient?: HypothesisClient;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface RunAnalyzeResult {
  report: FlakehoundReport;
  reportPath: string;
  /** 0 = clean; 1 = new regression(s). Tool errors throw and map to exit 2 in the CLI. */
  exitCode: 0 | 1;
}

export async function runAnalyze(options: RunAnalyzeOptions = {}): Promise<RunAnalyzeResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string) => console.error(message));

  const config = await loadConfig({
    cwd,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.overrides !== undefined ? { overrides: options.overrides } : {}),
  });

  // First-run guidance: no config file, no --input flag → we're guessing with
  // defaults. Say so once (then proceed — the defaults are legitimate).
  if (
    options.configPath === undefined &&
    options.overrides?.input === undefined &&
    findConfigFile(cwd) === undefined
  ) {
    warn(
      `flakehound: no flakehound.config.* found — using defaults (input: ${String(config.input)}); run 'npx flakehound init' to scaffold one`,
    );
  }

  const { runs, summary } = await ingest(config.input, cwd);

  // No-silent-pass policy: a QA gate must never exit 0 having analyzed nothing.
  // Zero matched files almost always means a misconfigured glob or a runner
  // that isn't emitting JUnit XML — that's a tool-level error (exit 2).
  if (summary.filesParsed === 0) {
    const patterns = Array.isArray(config.input) ? config.input.join("', '") : config.input;
    throw new FlakehoundError(
      `no JUnit XML files matched '${patterns}'\n` +
        `  searched from: ${cwd}\n` +
        `  Things to check:\n` +
        `    · does the glob point at your test-results folder? (quote it so the shell doesn't expand it)\n` +
        `    · is your test runner emitting JUnit XML? (Jest, Playwright, pytest, and JUnit all can)\n` +
        `    · run 'npx flakehound init' to scaffold a config with a documented input glob`,
    );
  }

  const windowed = applyHistoryWindow(runs, config.historyDays, now);

  const signals = computeSignals(windowed, config.signal);
  const clusters = clusterTestRuns(windowed, {
    similarityThreshold: config.cluster.similarityThreshold,
    weighting: config.cluster.weighting,
  });
  const interpreted = await interpretClusters(clusters, {
    config: config.ai,
    ...(options.aiClient !== undefined ? { client: options.aiClient } : {}),
    warn,
    info: warn,
  });

  const baseline =
    config.baseline === undefined
      ? undefined
      : await loadBaseline(path.resolve(cwd, config.baseline), warn);
  const gate = diffAgainstBaseline(signals, baseline, clusters, {
    similarityThreshold: config.cluster.similarityThreshold,
  });

  const report = buildReport({
    generatedAt: now().toISOString(),
    summary: { ...summary, testsAnalyzed: signals.length },
    signals,
    clusters: interpreted,
    gate,
  });

  const reportPath = path.resolve(cwd, config.output);
  await writeReport(reportPath, report);
  log(renderReport(report));

  return { report, reportPath, exitCode: gate.newRegressions.length > 0 ? 1 : 0 };
}

export function applyHistoryWindow(
  runs: TestRun[],
  historyDays: number | undefined,
  now: () => Date,
): TestRun[] {
  if (historyDays === undefined) return runs;
  const cutoff = now().getTime() - historyDays * 86_400_000;
  return runs.filter((run) => Date.parse(run.timestamp) >= cutoff);
}
