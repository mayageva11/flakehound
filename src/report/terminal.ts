import pc from 'picocolors';
import type { InterpretedCluster } from '../ai/types.js';
import type { HistoryEntry } from '../signal/types.js';
import type { FlakehoundReport } from './types.js';

const TRACE_PREVIEW_LENGTH = 160;

/**
 * Compact chronological run strip: ✓ pass · ✗ fail · - skip, with ↻ appended to
 * an execution that flipped on retry. Makes the flips visible in the terminal,
 * not just asserted in prose.
 */
function renderRunStrip(history: HistoryEntry[]): string {
  const glyphs = history.map((entry) => {
    const flip = entry.retryFlips > 0 ? pc.yellow('↻') : '';
    if (entry.verdict === 'pass') return pc.green('✓') + flip;
    if (entry.verdict === 'fail') return pc.red('✗') + flip;
    return pc.dim('-');
  });
  return `runs: ${glyphs.join(' ')}`;
}

export function renderReport(report: FlakehoundReport): string {
  const { summary, signals, clusters, gate } = report;
  const regressions = signals.filter((s) => s.classification === 'regression');
  const flaky = [...signals.filter((s) => s.classification === 'flaky')].sort(
    (a, b) => b.flakinessScore - a.flakinessScore || a.testId.localeCompare(b.testId),
  );
  const needsAttention = signals.filter(
    (s) =>
      s.classification === 'insufficient-metadata' || s.classification === 'insufficient-data',
  );

  const lines: string[] = [];
  lines.push(
    pc.bold(
      `flakehound — ${summary.testRuns} test runs across ${summary.filesParsed} files, ${summary.testsAnalyzed} tests analyzed`,
    ),
  );
  lines.push(
    pc.dim(
      `metadata sources: ${summary.metadataSources.sidecar} sidecar, ${summary.metadataSources.dirname} dirname, ${summary.metadataSources.mtime} mtime`,
    ),
  );

  lines.push('', pc.bold(pc.red(`Regressions (${regressions.length})`)));
  if (regressions.length === 0) lines.push(pc.dim('  none'));
  for (const signal of regressions) {
    lines.push(`  ${pc.red('✗')} ${signal.testId} — broken since ${signal.brokenSinceSha}`);
    if (signal.reason !== undefined) lines.push(pc.dim(`      ${signal.reason}`));
    if (signal.history.length > 0) lines.push(`      ${renderRunStrip(signal.history)}`);
  }

  lines.push('', pc.bold(pc.yellow(`Flaky tests — quarantine candidates (${flaky.length})`)));
  if (flaky.length === 0) lines.push(pc.dim('  none'));
  for (const signal of flaky) {
    lines.push(
      `  ${pc.yellow('~')} ${signal.testId} — score ${signal.flakinessScore.toFixed(2)} (${signal.confidence} confidence)`,
    );
    if (signal.reason !== undefined) lines.push(pc.dim(`      ${signal.reason}`));
    if (signal.history.length > 0) lines.push(`      ${renderRunStrip(signal.history)}`);
  }

  lines.push('', pc.bold(`Failure clusters (${clusters.length}) — ranked by impact`));
  if (clusters.length === 0) lines.push(pc.dim('  none'));
  for (const [index, cluster] of rankByImpact(clusters).entries()) {
    lines.push(
      `  ${index + 1}. [${cluster.id}] ${cluster.occurrences} occurrence(s) across ${cluster.tests.length} test(s), ${cluster.firstSeen} → ${cluster.lastSeen}`,
    );
    if (cluster.hypothesis !== undefined) {
      lines.push(
        pc.cyan(`      AI: ${cluster.hypothesis.category} — ${cluster.hypothesis.explanation}`),
      );
    }
    lines.push(pc.dim(`      ${preview(cluster.representativeTrace)}`));
  }

  if (needsAttention.length > 0) {
    lines.push('', pc.bold(`Needs attention (${needsAttention.length})`));
    for (const signal of needsAttention) {
      lines.push(`  ? ${signal.testId} — ${signal.classification}`);
      if (signal.reason !== undefined) lines.push(pc.dim(`      ${signal.reason}`));
    }
  }

  const gateColor = gate.newRegressions.length > 0 ? pc.red : pc.green;
  lines.push(
    '',
    pc.bold(
      gateColor(
        `CI gate: ${gate.newRegressions.length} new, ${gate.knownRegressions.length} known, ${gate.resolvedRegressions.length} resolved regression(s)`,
      ),
    ),
  );
  if (!gate.baselineUsed) {
    lines.push(pc.dim('  no baseline — failing safe: every regression counts as new'));
  }
  if (gate.resolvedRegressions.length > 0) {
    lines.push(pc.green(`  resolved: ${gate.resolvedRegressions.join(', ')}`));
  }
  return lines.join('\n');
}

/** Impact = occurrences × affected tests; deterministic tie-break. */
function rankByImpact(clusters: InterpretedCluster[]): InterpretedCluster[] {
  return [...clusters].sort(
    (a, b) =>
      b.occurrences * b.tests.length - a.occurrences * a.tests.length ||
      a.representativeTrace.localeCompare(b.representativeTrace),
  );
}

function preview(trace: string): string {
  return trace.length > TRACE_PREVIEW_LENGTH
    ? `${trace.slice(0, TRACE_PREVIEW_LENGTH)}…`
    : trace;
}
