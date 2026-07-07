import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAnalyze } from '../src/run.js';

const e2eDir = fileURLToPath(new URL('./fixtures/e2e', import.meta.url));
const fixedNow = () => new Date('2026-07-05T00:00:00.000Z');

let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'flakehound-e2e-'));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function analyze(extra: { baseline?: string; output: string }) {
  const logs: string[] = [];
  const result = runAnalyze({
    cwd: e2eDir,
    overrides: {
      input: '*/junit.xml',
      output: extra.output,
      ai: false, // --no-ai: the e2e path must never touch the network
      ...(extra.baseline !== undefined ? { baseline: extra.baseline } : {}),
    },
    now: fixedNow,
    log: (m) => logs.push(m),
    warn: () => {},
  });
  return result.then((r) => ({ ...r, terminal: logs.join('\n') }));
}

describe('flakehound end-to-end', () => {
  it('separates the regression from the flaky test and clusters the failures', async () => {
    const { report, exitCode, terminal } = await analyze({
      output: path.join(outDir, 'first.json'),
    });

    // regression: payment passed on aaa1111, fails 100% since bbb2222
    const payment = report.signals.find((s) => s.testId === 'shop.spec.ts > payment');
    expect(payment?.classification).toBe('regression');
    expect(payment?.brokenSinceSha).toBe('bbb2222');

    // flaky: checkout flips pass↔fail on commit bbb2222
    const checkout = report.signals.find((s) => s.testId === 'shop.spec.ts > checkout');
    expect(checkout?.classification).toBe('flaky');
    expect(checkout?.confidence).toBe('medium');

    // stable test stays out of both buckets
    const login = report.signals.find((s) => s.testId === 'shop.spec.ts > login');
    expect(login?.classification).toBe('stable');

    // every signal publishes its per-run evidence trail, chronological
    for (const signal of report.signals) {
      expect(signal.history).toHaveLength(4); // 4 runs in the fixture history
      const stamps = signal.history.map((h) => h.timestamp);
      expect([...stamps].sort()).toEqual(stamps);
    }
    expect(payment?.history.map((h) => h.verdict)).toEqual(['pass', 'fail', 'fail', 'fail']);
    expect(checkout?.history.map((h) => h.verdict)).toEqual(['pass', 'fail', 'pass', 'fail']);

    // 5 failures = 2 unique causes: the timeout cluster and the assertion cluster
    expect(report.clusters).toHaveLength(2);
    const sizes = report.clusters.map((c) => c.occurrences).sort();
    expect(sizes).toEqual([2, 3]);
    expect(report.clusters.every((c) => c.hypothesis === undefined)).toBe(true); // --no-ai

    // no baseline → fail-safe gate → exit 1
    expect(report.gate.baselineUsed).toBe(false);
    expect(report.gate.newRegressions).toEqual(['shop.spec.ts > payment']);
    expect(exitCode).toBe(1);

    // terminal report shows all sections
    expect(terminal).toContain('Regressions (1)');
    expect(terminal).toContain('shop.spec.ts > payment');
    expect(terminal).toContain('quarantine candidates (1)');
    expect(terminal).toContain('Failure clusters (2)');
    expect(terminal).toContain('CI gate: 1 new');
  });

  it('writes a report artifact that works as the next run’s baseline → known regression, exit 0', async () => {
    const first = await analyze({ output: path.join(outDir, 'baseline.json') });
    expect(first.exitCode).toBe(1);

    const second = await analyze({
      output: path.join(outDir, 'second.json'),
      baseline: path.join(outDir, 'baseline.json'),
    });

    expect(second.report.gate.baselineUsed).toBe(true);
    expect(second.report.gate.newRegressions).toEqual([]);
    expect(second.report.gate.knownRegressions).toEqual(['shop.spec.ts > payment']);
    expect(second.exitCode).toBe(0); // known regression does not re-fail the gate
  });

  it('unreadable baseline → fail-safe (all regressions new), run does not crash', async () => {
    const { report, exitCode } = await analyze({
      output: path.join(outDir, 'failsafe.json'),
      baseline: path.join(outDir, 'does-not-exist.json'),
    });
    expect(report.gate.baselineUsed).toBe(false);
    expect(report.gate.newRegressions).toEqual(['shop.spec.ts > payment']);
    expect(exitCode).toBe(1);
  });

  it('determinism: two runs produce byte-identical report files', async () => {
    const a = await analyze({ output: path.join(outDir, 'det-a.json') });
    const b = await analyze({ output: path.join(outDir, 'det-b.json') });

    const fileA = await readFile(a.reportPath, 'utf8');
    const fileB = await readFile(b.reportPath, 'utf8');
    expect(fileA).toBe(fileB);
    expect(fileA.length).toBeGreaterThan(100);
  });
});
