import { describe, expect, it } from 'vitest';
import { diffAgainstBaseline, diffClusters } from '../src/report/baseline.js';
import type { FailureCluster } from '../src/cluster/index.js';
import type { FlakehoundReport } from '../src/report/types.js';
import type { TestSignal } from '../src/signal/types.js';

function regression(testId: string): TestSignal {
  return {
    testId,
    flakinessScore: 0,
    classification: 'regression',
    confidence: 'high',
    brokenSinceSha: 'bbb2222',
    history: [],
  };
}

function stable(testId: string): TestSignal {
  return { testId, flakinessScore: 0, classification: 'stable', confidence: 'high', history: [] };
}

function baselineWith(...signals: TestSignal[]): FlakehoundReport {
  return {
    version: 1,
    generatedAt: '2026-07-01T00:00:00.000Z',
    summary: {
      filesParsed: 1,
      testRuns: 1,
      testsAnalyzed: signals.length,
      metadataSources: { sidecar: 0, dirname: 1, mtime: 0 },
    },
    signals,
    clusters: [],
    gate: {
      baselineUsed: false,
      newRegressions: [],
      knownRegressions: [],
      resolvedRegressions: [],
      newClusters: [],
      knownClusters: [],
    },
  };
}

describe('diffAgainstBaseline', () => {
  it('regression in both → known (does not re-fail the gate)', () => {
    const gate = diffAgainstBaseline([regression('t1')], baselineWith(regression('t1')));
    expect(gate).toEqual({
      baselineUsed: true,
      newRegressions: [],
      knownRegressions: ['t1'],
      resolvedRegressions: [],
      newClusters: [],
      knownClusters: [],
    });
  });

  it('regression only in current → new', () => {
    const gate = diffAgainstBaseline(
      [regression('t1'), regression('t2')],
      baselineWith(regression('t1')),
    );
    expect(gate.newRegressions).toEqual(['t2']);
    expect(gate.knownRegressions).toEqual(['t1']);
  });

  it('regression only in baseline → resolved (surfaced as good news)', () => {
    const gate = diffAgainstBaseline([stable('t1')], baselineWith(regression('t1')));
    expect(gate.newRegressions).toEqual([]);
    expect(gate.resolvedRegressions).toEqual(['t1']);
  });

  it('no baseline → fail-safe: every regression is new', () => {
    const gate = diffAgainstBaseline([regression('t2'), regression('t1')], undefined);
    expect(gate.baselineUsed).toBe(false);
    expect(gate.newRegressions).toEqual(['t1', 't2']); // sorted, deterministic
    expect(gate.knownRegressions).toEqual([]);
  });

  it('non-regression classifications never enter the gate', () => {
    const flaky: TestSignal = {
      testId: 'f1',
      flakinessScore: 0.8,
      classification: 'flaky',
      confidence: 'high',
      history: [],
    };
    const gate = diffAgainstBaseline([flaky, stable('s1')], undefined);
    expect(gate.newRegressions).toEqual([]);
  });
});

function cluster(id: string, representativeTrace: string): FailureCluster {
  return {
    id,
    representativeTrace,
    tests: ['t'],
    firstSeen: '2026-07-01T10:00:00.000Z',
    lastSeen: '2026-07-02T10:00:00.000Z',
    occurrences: 2,
  };
}

function baselineWithClusters(...clusters: FailureCluster[]): FlakehoundReport {
  return { ...baselineWith(stable('s1')), clusters };
}

describe('diffClusters — "a new unique bug appeared" (informational)', () => {
  const timeoutRep =
    "TimeoutError: Timeout <DURATION> exceeded waiting for locator('#pay-button') at CheckoutPage.pay (checkout-page.ts:<N>:<N>)";
  const assertRep =
    'AssertionError: expected cart total to equal charged amount at PaymentPage.verify (payment-page.ts:<N>:<N>)';

  it('no baseline → every cluster is new (fail-safe-consistent)', () => {
    const diff = diffClusters([cluster('bbb', timeoutRep), cluster('aaa', assertRep)], undefined);
    expect(diff).toEqual({ newClusters: ['aaa', 'bbb'], knownClusters: [] });
  });

  it('id present in the baseline → known', () => {
    const diff = diffClusters(
      [cluster('aaa', timeoutRep)],
      baselineWithClusters(cluster('aaa', timeoutRep)),
    );
    expect(diff).toEqual({ newClusters: [], knownClusters: ['aaa'] });
  });

  it('drifted representative (different id, similar trace) still matches → known', () => {
    // same bug, but the representative gained a trailing frame → new hash id
    const drifted = `${timeoutRep} at shop.spec.ts:<N>:<N>`;
    const diff = diffClusters(
      [cluster('new-id', drifted)],
      baselineWithClusters(cluster('old-id', timeoutRep)),
    );
    expect(diff).toEqual({ newClusters: [], knownClusters: ['new-id'] });
  });

  it('genuinely different failure → new, alongside known ones', () => {
    const diff = diffClusters(
      [cluster('t1', timeoutRep), cluster('a1', assertRep)],
      baselineWithClusters(cluster('t1', timeoutRep)),
    );
    expect(diff).toEqual({ newClusters: ['a1'], knownClusters: ['t1'] });
  });
});
