import { describe, expect, it } from 'vitest';
import { clusterFailures, clusterTestRuns, normalizeTrace } from '../src/cluster/index.js';
import { JaccardSimilarity, WeightedJaccardSimilarity } from '../src/cluster/similarity.js';
import type { FailureOccurrence } from '../src/cluster/cluster.js';
import type { TestRun } from '../src/ingest/types.js';

function failure(testId: string, day: number, trace: string): FailureOccurrence {
  return {
    testId,
    timestamp: `2026-07-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    trace,
  };
}

const timeoutTrace = (line: number, addr: string) =>
  `TimeoutError: Timeout 30000ms exceeded.
    at ProgressController.run (/home/ci/repo/node_modules/playwright-core/lib/server/progress.js:${line}:24) [${addr}]
    at CheckoutPage.pay (/home/ci/repo/e2e/pages/checkout-page.ts:88:41)`;

const connectionTrace = `ConnectionError: could not connect to postgres:5432
    at Pool.acquire (/home/ci/repo/src/db/pool.ts:31:9)`;

const assertionTrace = `AssertionError: expected cart total to equal shipping quote
    at CartPage.verifyTotals (/home/ci/repo/e2e/pages/cart-page.ts:54:11)`;

describe('JaccardSimilarity', () => {
  const metric = new JaccardSimilarity();
  const set = (...items: string[]) => new Set(items);

  it('is 1 for identical sets and 0 for disjoint sets', () => {
    expect(metric.compare(set('a', 'b'), set('a', 'b'))).toBe(1);
    expect(metric.compare(set('a', 'b'), set('c', 'd'))).toBe(0);
  });

  it('computes |∩| / |∪|', () => {
    expect(metric.compare(set('a', 'b', 'c'), set('b', 'c', 'd'))).toBeCloseTo(2 / 4);
  });

  it('handles empty sets: both empty → identical, one empty → disjoint', () => {
    expect(metric.compare(set(), set())).toBe(1);
    expect(metric.compare(set(), set('a'))).toBe(0);
  });
});

describe('WeightedJaccardSimilarity', () => {
  const metric = new WeightedJaccardSimilarity();

  it('reduces exactly to plain Jaccard when every token is a head token', () => {
    const plain = new JaccardSimilarity();
    const a = normalizeTrace('WidgetError alpha beta gamma');
    const b = normalizeTrace('WidgetError alpha beta delta');
    expect(metric.compare(a, b)).toBeCloseTo(plain.compare(a.tokens, b.tokens));
  });

  it('head tokens dominate frame tokens', () => {
    // identical heads, disjoint frames → similarity pulled UP by the head
    const sameHead = metric.compare(
      normalizeTrace('QuotaError: limit reached\n    at alpha (a.ts:1:1)'),
      normalizeTrace('QuotaError: limit reached\n    at beta (b.ts:2:2)'),
    );
    // disjoint heads, identical frames → similarity pulled DOWN by the head
    const sameFrames = metric.compare(
      normalizeTrace('AlphaError: expired\n    at helper (lib/retry.ts:1:1)'),
      normalizeTrace('BetaError: closed\n    at helper (lib/retry.ts:2:2)'),
    );
    expect(sameHead).toBeGreaterThan(sameFrames);
  });

  it('handles empty inputs: both empty → identical, one empty → disjoint', () => {
    const empty = normalizeTrace('');
    const some = normalizeTrace('Error: x');
    expect(metric.compare(empty, empty)).toBe(1);
    expect(metric.compare(empty, some)).toBe(0);
  });
});

describe('clusterFailures — head weighting (default)', () => {
  // Two DIFFERENT bugs whose traces share a deep library call path. Uniform
  // Jaccard merges them (11 shared frame tokens / 15 union = 0.73 ≥ 0.7) — a
  // false merge, the failure mode the tool must avoid. Head weighting keeps
  // them apart because the error heads are disjoint.
  const sharedFrames =
    '\n    at helper (lib/retry.ts:1:1)\n    at wrapper (lib/queue.ts:2:2)\n    at runner (lib/run.ts:3:3)\n    at dispatch (lib/bus.ts:4:4)\n    at flush (lib/sink.ts:5:5)';
  const alphaTrace = `AlphaError: expired${sharedFrames}`;
  const betaTrace = `BetaError: closed${sharedFrames}`;

  it('resists the shared-library-frames false merge that uniform Jaccard commits', () => {
    const failures = [failure('t1', 1, alphaTrace), failure('t2', 2, betaTrace)];
    expect(clusterFailures(failures)).toHaveLength(2); // head-weighted: split ✔
    expect(clusterFailures(failures, { weighting: 'uniform' })).toHaveLength(1); // old metric merged
  });

  it('merges the same bug surfacing through two call paths (same head, different frames)', () => {
    const head = 'GammaError: transaction deadlock detected on table orders';
    const failures = [
      failure('t1', 1, `${head}\n    at alpha (a.ts:1:1)`),
      failure('t2', 2, `${head}\n    at beta (b.ts:2:2)`),
    ];
    expect(clusterFailures(failures)).toHaveLength(1); // head-weighted: merge ✔
    expect(clusterFailures(failures, { weighting: 'uniform' })).toHaveLength(2); // old metric split
  });

  it('DETERMINISM holds under head weighting: shuffled input → identical output', () => {
    const all = [
      failure('t1', 1, alphaTrace),
      failure('t2', 2, betaTrace),
      failure('t3', 3, `AlphaError: expired${sharedFrames}`),
    ];
    const shuffled = [all[2]!, all[0]!, all[1]!];
    expect(JSON.stringify(clusterFailures(shuffled))).toBe(JSON.stringify(clusterFailures(all)));
  });
});

describe('clusterFailures', () => {
  it('N structurally-identical traces (different line numbers/addresses) → 1 cluster', () => {
    const clusters = clusterFailures([
      failure('checkout > completes payment', 1, timeoutTrace(75, '0x7f3a91bc2000')),
      failure('checkout > completes payment', 3, timeoutTrace(212, '0x559b22aa0010')),
      failure('checkout > applies coupon', 5, timeoutTrace(99, '0xdeadbeef0042')),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.occurrences).toBe(3);
  });

  it('two genuinely different exceptions → 2 clusters', () => {
    const clusters = clusterFailures([
      failure('t1', 1, timeoutTrace(75, '0x1')),
      failure('t2', 2, connectionTrace),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('N similar + M different → N-in-1 + M separate', () => {
    const clusters = clusterFailures([
      failure('t1', 1, timeoutTrace(75, '0x1')),
      failure('t2', 2, timeoutTrace(80, '0x2')),
      failure('t3', 3, timeoutTrace(91, '0x3')),
      failure('t4', 4, connectionTrace),
      failure('t5', 5, assertionTrace),
    ]);
    expect(clusters).toHaveLength(3);
    const sizes = clusters.map((c) => c.occurrences).sort((a, b) => b - a);
    expect(sizes).toEqual([3, 1, 1]);
    const timeoutCluster = clusters.find((c) => c.occurrences === 3)!;
    expect(timeoutCluster.tests).toEqual(['t1', 't2', 't3']);
  });

  it('threshold sensitivity: just above merges, just below splits (inclusive ≥)', () => {
    // 10 shared tokens of 12 union → 0.833 ≥ 0.7 → merge
    const above = clusterFailures([
      failure('t1', 1, 'WidgetError alpha beta gamma delta epsilon zeta eta theta iota kappa'),
      failure('t2', 2, 'WidgetError alpha beta gamma delta epsilon zeta eta theta iota mu'),
    ]);
    expect(above).toHaveLength(1);

    // 3 shared tokens of 7 union → 0.43 < 0.7 → split
    const below = clusterFailures([
      failure('t1', 1, 'GadgetError alpha beta gamma delta'),
      failure('t2', 2, 'GadgetError alpha beta rho sigma'),
    ]);
    expect(below).toHaveLength(2);

    // exactly at the boundary: |A|=8, |B|=9, ∩=7 → 7/10 = 0.7 → merges (≥, not >)
    const atBoundary = clusterFailures([
      failure('t1', 1, 'EdgeError one two three four five six seven'),
      failure('t2', 2, 'EdgeError one two three four five six eight nine'),
    ]);
    expect(atBoundary).toHaveLength(1);
  });

  it('traces differing only by HTTP status code stay in separate clusters', () => {
    // 500 vs 403 is two different bugs (server error vs auth). Numbers are
    // identity: {expected,200,but,got,500} vs {…,403} → ∩4/∪6 = 0.67 < 0.7.
    const clusters = clusterFailures([
      failure('t1', 1, 'expected 200 but got 500'),
      failure('t2', 2, 'expected 200 but got 403'),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('threshold is configurable', () => {
    const traces = [
      failure('t1', 1, 'GadgetError alpha beta gamma delta'),
      failure('t2', 2, 'GadgetError alpha beta rho sigma'),
    ];
    expect(clusterFailures(traces, { similarityThreshold: 0.7 })).toHaveLength(2);
    expect(clusterFailures(traces, { similarityThreshold: 0.4 })).toHaveLength(1);
  });

  it('DETERMINISM: shuffled input → byte-identical cluster output', () => {
    const all = [
      failure('t1', 1, timeoutTrace(75, '0x1')),
      failure('t2', 2, connectionTrace),
      failure('t3', 3, timeoutTrace(80, '0x2')),
      failure('t4', 4, assertionTrace),
      failure('t5', 5, timeoutTrace(91, '0x3')),
      failure('t6', 6, 'WidgetError alpha beta gamma delta epsilon zeta eta theta iota kappa'),
      failure('t7', 7, 'WidgetError alpha beta gamma delta epsilon zeta eta theta iota mu'),
    ];
    const shuffled = [
      ...all.filter((_, i) => i % 3 === 2),
      ...all.filter((_, i) => i % 3 === 0).reverse(),
      ...all.filter((_, i) => i % 3 === 1),
    ];

    expect(JSON.stringify(clusterFailures(shuffled))).toBe(JSON.stringify(clusterFailures(all)));
  });

  it('computes firstSeen/lastSeen/occurrences/tests across a multi-run cluster', () => {
    const clusters = clusterFailures([
      failure('checkout > completes payment', 3, timeoutTrace(75, '0x1')),
      failure('checkout > applies coupon', 1, timeoutTrace(80, '0x2')),
      failure('checkout > completes payment', 5, timeoutTrace(91, '0x3')),
    ]);
    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.firstSeen).toBe('2026-07-01T10:00:00.000Z');
    expect(cluster.lastSeen).toBe('2026-07-05T10:00:00.000Z');
    expect(cluster.occurrences).toBe(3);
    expect(cluster.tests).toEqual(['checkout > applies coupon', 'checkout > completes payment']);
    expect(cluster.id).toMatch(/^[0-9a-f]{12}$/);
    expect(cluster.representativeTrace).toContain('TimeoutError');
  });

  it('cluster ids are stable content hashes (same representative → same id across runs)', () => {
    const a = clusterFailures([failure('t1', 1, timeoutTrace(75, '0x1'))]);
    const b = clusterFailures([failure('other-test', 9, timeoutTrace(212, '0xff'))]);
    expect(a[0]!.id).toBe(b[0]!.id);
  });
});

describe('clusterTestRuns adapter', () => {
  const run = (testId: string, status: TestRun['status'], trace?: string): TestRun => ({
    testId,
    status,
    durationMs: 1,
    timestamp: '2026-07-01T10:00:00.000Z',
    ...(trace !== undefined ? { stackTrace: trace } : {}),
  });

  it('clusters only failed runs that carry a trace', () => {
    const clusters = clusterTestRuns([
      run('t1', 'fail', timeoutTrace(75, '0x1')),
      run('t2', 'pass', timeoutTrace(75, '0x1')), // passing — ignored
      run('t3', 'fail'), // no trace — nothing to cluster on
      run('t4', 'skip'),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.tests).toEqual(['t1']);
  });

  it('falls back to errorMessage when stackTrace is absent', () => {
    const clusters = clusterTestRuns([
      {
        testId: 't1',
        status: 'fail',
        durationMs: 1,
        timestamp: '2026-07-01T10:00:00.000Z',
        errorMessage: 'ConnectionError: could not connect to postgres:5432',
      },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.representativeTrace).toContain('ConnectionError');
  });
});
