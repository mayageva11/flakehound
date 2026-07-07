import { describe, expect, it } from 'vitest';
import { computeSignals } from '../src/signal/index.js';
import type { TestRun, TestStatus } from '../src/ingest/types.js';

interface RunOpts {
  sha?: string;
  day?: number;
  runId?: string;
}

function run(testId: string, status: TestStatus, opts: RunOpts = {}): TestRun {
  const day = opts.day ?? 1;
  return {
    testId,
    status,
    durationMs: 100,
    timestamp: `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    ...(opts.sha !== undefined ? { commitSha: opts.sha } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
  };
}

function signalFor(runs: TestRun[], testId: string, overrides = {}) {
  const signal = computeSignals(runs, overrides).find((s) => s.testId === testId);
  expect(signal).toBeDefined();
  return signal!;
}

describe('computeSignals', () => {
  it('pure flaky: alternating pass/fail on one commit → flaky, medium confidence', () => {
    const runs = [
      run('t', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('t', 'fail', { sha: 'aaa1111', day: 2, runId: 'r2' }),
      run('t', 'pass', { sha: 'aaa1111', day: 3, runId: 'r3' }),
      run('t', 'fail', { sha: 'aaa1111', day: 4, runId: 'r4' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('flaky');
    expect(signal.confidence).toBe('medium');
    expect(signal.flakinessScore).toBe(1); // 3 flips / 3 opportunities
    expect(signal.reason).toContain('same commit');
  });

  it('retry-only flake: fail-then-pass within a single run → flaky, high confidence', () => {
    const runs = [
      run('t', 'fail', { sha: 'bbb2222', day: 1, runId: 'r1' }),
      run('t', 'pass', { sha: 'bbb2222', day: 1, runId: 'r1' }), // retry, same run
      run('t', 'pass', { sha: 'bbb2222', day: 2, runId: 'r2' }),
      run('t', 'pass', { sha: 'bbb2222', day: 3, runId: 'r3' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('flaky');
    expect(signal.confidence).toBe('high');
    expect(signal.reason).toContain('retry flip');
    // 1 retry flip × weight 2 over (1 retry + 2 cross-run) opportunities
    expect(signal.flakinessScore).toBeCloseTo(2 / 3);
  });

  it('hard regression: pass…pass then fail…fail after commit X → regression, not flaky', () => {
    const runs = [
      run('t', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('t', 'pass', { sha: 'aaa1111', day: 2, runId: 'r2' }),
      run('t', 'fail', { sha: 'bbb2222', day: 3, runId: 'r3' }),
      run('t', 'fail', { sha: 'bbb2222', day: 4, runId: 'r4' }),
      run('t', 'fail', { sha: 'ccc3333', day: 5, runId: 'r5' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('regression');
    expect(signal.brokenSinceSha).toBe('bbb2222');
    expect(signal.confidence).toBe('high');
    expect(signal.flakinessScore).toBe(0); // mutually exclusive with flaky
    expect(signal.reason).toContain('100%');
  });

  it('same-commit flip inside the failing window disqualifies regression → flaky', () => {
    const runs = [
      run('t', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('t', 'fail', { sha: 'aaa1111', day: 2, runId: 'r2' }), // flip on aaa1111
      run('t', 'fail', { sha: 'bbb2222', day: 3, runId: 'r3' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('flaky');
    expect(signal.brokenSinceSha).toBeUndefined();
  });

  it('missing sha: flaky via time-ordered fallback → low confidence', () => {
    const runs = [
      run('t', 'pass', { day: 1, runId: 'r1' }),
      run('t', 'fail', { day: 2, runId: 'r2' }),
      run('t', 'pass', { day: 3, runId: 'r3' }),
      run('t', 'fail', { day: 4, runId: 'r4' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('flaky');
    expect(signal.confidence).toBe('low');
    expect(signal.reason).toContain('no commitSha');
  });

  it('missing sha: regression-shaped history → insufficient-metadata with reason, never throws', () => {
    const runs = [
      run('t', 'pass', { day: 1, runId: 'r1' }),
      run('t', 'pass', { day: 2, runId: 'r2' }),
      run('t', 'fail', { day: 3, runId: 'r3' }),
      run('t', 'fail', { day: 4, runId: 'r4' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('insufficient-metadata');
    expect(signal.confidence).toBe('low');
    expect(signal.reason).toContain('commitSha');
    expect(signal.brokenSinceSha).toBeUndefined();
  });

  it('fewer than minRuns → insufficient-data with reason', () => {
    const runs = [
      run('t', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('t', 'fail', { sha: 'aaa1111', day: 2, runId: 'r2' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('insufficient-data');
    expect(signal.reason).toContain('only 2');
    expect(signal.reason).toContain('3 required');
  });

  it('stable: no flips → not flaky, not regression', () => {
    const runs = [1, 2, 3, 4].map((day) =>
      run('t', 'pass', { sha: 'aaa1111', day, runId: `r${day}` }),
    );
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('stable');
    expect(signal.flakinessScore).toBe(0);
    expect(signal.confidence).toBe('high');
  });

  it('always-failing with no observed pass is not called a regression, and says why', () => {
    const runs = [1, 2, 3].map((day) =>
      run('t', 'fail', { sha: 'aaa1111', day, runId: `r${day}` }),
    );
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('stable');
    expect(signal.reason).toContain('100% of observed runs');
  });

  it('skipped runs are excluded from scoring', () => {
    const runs = [
      run('t', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('t', 'skip', { sha: 'aaa1111', day: 2, runId: 'r2' }),
      run('t', 'pass', { sha: 'aaa1111', day: 3, runId: 'r3' }),
      run('t', 'pass', { sha: 'aaa1111', day: 4, runId: 'r4' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.classification).toBe('stable');
    expect(signal.flakinessScore).toBe(0);
  });

  it('thresholds come from config: raising minRuns downgrades to insufficient-data', () => {
    const runs = [1, 2, 3, 4].map((day) =>
      run('t', day % 2 === 0 ? 'fail' : 'pass', { sha: 'aaa1111', day, runId: `r${day}` }),
    );
    expect(signalFor(runs, 't').classification).toBe('flaky');
    expect(signalFor(runs, 't', { minRuns: 5 }).classification).toBe('insufficient-data');
  });

  it('determinism: shuffled run order → identical signals', () => {
    const all = [
      // flaky test
      run('flaky', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('flaky', 'fail', { sha: 'aaa1111', day: 2, runId: 'r2' }),
      run('flaky', 'pass', { sha: 'aaa1111', day: 3, runId: 'r3' }),
      // regression test
      run('broken', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('broken', 'fail', { sha: 'bbb2222', day: 2, runId: 'r2' }),
      run('broken', 'fail', { sha: 'ccc3333', day: 3, runId: 'r3' }),
      // retried test
      run('retried', 'fail', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('retried', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('retried', 'pass', { sha: 'bbb2222', day: 2, runId: 'r2' }),
      run('retried', 'pass', { sha: 'ccc3333', day: 3, runId: 'r3' }),
    ];
    const shuffled = [
      ...all.filter((_, i) => i % 3 === 2),
      ...all.filter((_, i) => i % 3 === 0).reverse(),
      ...all.filter((_, i) => i % 3 === 1),
    ];

    expect(computeSignals(shuffled)).toEqual(computeSignals(all));
    expect(computeSignals(all).map((s) => s.testId)).toEqual(['broken', 'flaky', 'retried']);
  });
});

describe('TestSignal.history — the published evidence trail', () => {
  it('is chronological, one entry per execution, with verdict/commit/retryFlips', () => {
    const runs = [
      // deliberately out of order: history must come back sorted
      run('t', 'fail', { sha: 'bbb2222', day: 3, runId: 'r3' }),
      run('t', 'pass', { sha: 'aaa1111', day: 1, runId: 'r1' }),
      run('t', 'fail', { sha: 'bbb2222', day: 2, runId: 'r2' }), // first attempt…
      run('t', 'pass', { sha: 'bbb2222', day: 2, runId: 'r2' }), // …retry flip
    ];
    const signal = signalFor(runs, 't');
    expect(signal.history).toEqual([
      { timestamp: '2026-07-01T10:00:00.000Z', commitSha: 'aaa1111', verdict: 'pass', retryFlips: 0 },
      { timestamp: '2026-07-02T10:00:00.000Z', commitSha: 'bbb2222', verdict: 'pass', retryFlips: 1 },
      { timestamp: '2026-07-03T10:00:00.000Z', commitSha: 'bbb2222', verdict: 'fail', retryFlips: 0 },
    ]);
  });

  it('omits commitSha when metadata is absent and records skips', () => {
    const runs = [
      run('t', 'pass', { day: 1, runId: 'r1' }),
      run('t', 'skip', { day: 2, runId: 'r2' }),
      run('t', 'fail', { day: 3, runId: 'r3' }),
    ];
    const signal = signalFor(runs, 't');
    expect(signal.history.map((h) => h.verdict)).toEqual(['pass', 'skip', 'fail']);
    expect(signal.history.every((h) => !('commitSha' in h))).toBe(true);
  });

  it('is present on every classification, including insufficient-data', () => {
    const one = signalFor([run('t', 'pass', { day: 1, runId: 'r1' })], 't');
    expect(one.classification).toBe('insufficient-data');
    expect(one.history).toHaveLength(1);
  });
});
