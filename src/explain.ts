import pc from 'picocolors';
import { clusterTestRuns } from './cluster/index.js';
import { loadConfig } from './config/load.js';
import type { CliOverrides } from './config/load.js';
import { ingest } from './ingest/index.js';
import { computeSignals, groupExecutions } from './signal/index.js';
import { applyHistoryWindow } from './run.js';
import { FlakehoundError } from './util/errors.js';

export interface RunExplainOptions {
  testId: string;
  cwd?: string;
  configPath?: string;
  overrides?: CliOverrides;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * `flakehound explain <testId>` — the run-by-run story behind one test's
 * classification: every execution in the window (date, commit, verdict,
 * attempts), the resulting classification with its reasoning, and the failure
 * cluster(s) the test appears in. Uses the exact same pipeline as `analyze`
 * (same config, same history window, same signals), so the answer always
 * matches the report.
 */
export async function runExplain(options: RunExplainOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.log(message));

  const config = await loadConfig({
    cwd,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.overrides !== undefined ? { overrides: options.overrides } : {}),
  });

  const { runs } = await ingest(config.input, cwd);
  const windowed = applyHistoryWindow(runs, config.historyDays, now);

  const testRuns = windowed.filter((run) => run.testId === options.testId);
  if (testRuns.length === 0) {
    const known = [...new Set(windowed.map((run) => run.testId))].sort();
    const near = known.filter((id) => id.toLowerCase().includes(options.testId.toLowerCase()));
    const hint =
      near.length > 0
        ? `Did you mean: ${near.slice(0, 5).join(' · ')}`
        : `Known tests: ${known.slice(0, 10).join(' · ')}${known.length > 10 ? ' …' : ''}`;
    throw new FlakehoundError(`no runs found for test "${options.testId}". ${hint}`);
  }

  const signal = computeSignals(windowed, config.signal).find((s) => s.testId === options.testId);
  const executions = groupExecutions(testRuns);
  const clusters = clusterTestRuns(windowed, {
    similarityThreshold: config.cluster.similarityThreshold,
  }).filter((cluster) => cluster.tests.includes(options.testId));

  const lines: string[] = [];
  lines.push(pc.bold(options.testId));

  const badge =
    signal === undefined
      ? pc.dim('unclassified')
      : signal.classification === 'regression'
        ? pc.red(`regression — broken since ${signal.brokenSinceSha}`)
        : signal.classification === 'flaky'
          ? pc.yellow(`flaky — score ${signal.flakinessScore.toFixed(2)} (${signal.confidence} confidence)`)
          : pc.green(signal.classification);
  lines.push(`  classification: ${badge}`);
  if (signal?.reason !== undefined) lines.push(pc.dim(`  why: ${signal.reason}`));

  lines.push('', pc.bold(`Run history (${executions.length} execution(s), oldest first)`));
  for (const execution of executions) {
    const attempts = execution.passCount + execution.failCount;
    const verdict =
      execution.verdict === 'pass'
        ? pc.green('pass')
        : execution.verdict === 'fail'
          ? pc.red('fail')
          : pc.dim('skip');
    const retry =
      execution.retryFlips > 0
        ? pc.yellow(`  ↻ retry flip (${execution.failCount} fail / ${execution.passCount} pass in-run)`)
        : attempts > 1
          ? pc.dim(`  ${attempts} attempts`)
          : '';
    lines.push(
      `  ${execution.timestamp.slice(0, 16)}  ${(execution.commitSha ?? '-------').slice(0, 7)}  ${verdict}${retry}`,
    );
  }

  lines.push('', pc.bold(`Failure clusters containing this test (${clusters.length})`));
  if (clusters.length === 0) lines.push(pc.dim('  none — no failing runs with a trace'));
  for (const cluster of clusters) {
    lines.push(`  [${cluster.id}] ${cluster.occurrences} occurrence(s) across ${cluster.tests.length} test(s)`);
    lines.push(pc.dim(`      ${cluster.representativeTrace.slice(0, 160)}`));
  }

  log(lines.join('\n'));
}
