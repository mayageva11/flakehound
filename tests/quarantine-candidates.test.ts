import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isReleasable,
  resolveScoreThreshold,
  selectQuarantineCandidates,
  selectReleaseCandidates,
} from '../src/quarantine/candidates.js';
import { loadState, writeState } from '../src/quarantine/state.js';
import { DEFAULT_QUARANTINE_CONFIG } from '../src/quarantine/types.js';
import type { QuarantineConfig, QuarantineEntry, QuarantineState } from '../src/quarantine/types.js';
import type { FlakehoundReport } from '../src/report/types.js';
import type { HistoryEntry, TestSignal } from '../src/signal/types.js';
import { FlakehoundError } from '../src/util/errors.js';

function signal(testId: string, over: Partial<TestSignal> = {}): TestSignal {
  return {
    testId,
    flakinessScore: 0.5,
    classification: 'flaky',
    confidence: 'high',
    history: [],
    ...over,
  };
}

function report(signals: TestSignal[]): FlakehoundReport {
  return {
    version: 1,
    generatedAt: '2026-07-12T00:00:00.000Z',
    summary: {
      filesParsed: 1,
      testRuns: signals.length,
      testsAnalyzed: signals.length,
      metadataSources: { sidecar: 0, dirname: 0, mtime: signals.length },
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

function entry(testId: string, over: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    testId,
    file: 'e2e/shop.spec.ts',
    quarantinedAt: '2026-06-01T00:00:00.000Z',
    flakinessScore: 0.5,
    confidence: 'high',
    ...over,
  };
}

/** History entry on 2026-06-<day> — after the default entry()'s quarantinedAt. */
function run(day: number, verdict: HistoryEntry['verdict'], retryFlips = 0): HistoryEntry {
  return { timestamp: `2026-06-${String(day).padStart(2, '0')}T12:00:00.000Z`, verdict, retryFlips };
}

function cfg(over: Partial<QuarantineConfig> = {}): QuarantineConfig {
  return { ...DEFAULT_QUARANTINE_CONFIG, ...over };
}

const emptyState: QuarantineState = { version: 1, quarantined: [] };

describe('quarantine state file', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'flakehound-state-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('round-trips through write and load', async () => {
    const file = path.join(workDir, 'flakehound.quarantine.json');
    const state: QuarantineState = {
      version: 1,
      quarantined: [
        entry('a.spec.ts > first', {
          clusterId: 'abc123def456',
          issue: { number: 7, url: 'https://github.com/o/r/issues/7' },
        }),
      ],
    };
    await writeState(file, state);
    expect(await loadState(file)).toEqual(state);
  });

  it('writes byte-stable output sorted by testId', async () => {
    const a = path.join(workDir, 'a.json');
    const b = path.join(workDir, 'b.json');
    const entries = [entry('b.spec.ts > two'), entry('a.spec.ts > one'), entry('c.spec.ts > three')];
    await writeState(a, { version: 1, quarantined: entries });
    await writeState(b, { version: 1, quarantined: [entries[2]!, entries[0]!, entries[1]!] });

    const fileA = await readFile(a, 'utf8');
    expect(fileA).toBe(await readFile(b, 'utf8'));
    expect(fileA.endsWith('\n')).toBe(true);
    const loaded = await loadState(a);
    expect(loaded.quarantined.map((e) => e.testId)).toEqual([
      'a.spec.ts > one',
      'b.spec.ts > two',
      'c.spec.ts > three',
    ]);
  });

  it('treats a missing file as an empty state', async () => {
    expect(await loadState(path.join(workDir, 'nope.json'))).toEqual(emptyState);
  });

  it('fails loudly on corrupt JSON', async () => {
    const file = path.join(workDir, 'corrupt.json');
    await writeFile(file, '{ not json', 'utf8');
    await expect(loadState(file)).rejects.toThrow(FlakehoundError);
  });

  it('fails loudly on an off-schema file', async () => {
    const file = path.join(workDir, 'offschema.json');
    await writeFile(file, JSON.stringify({ version: 2, tests: [] }), 'utf8');
    await expect(loadState(file)).rejects.toThrow(FlakehoundError);
  });
});

describe('selectQuarantineCandidates', () => {
  it('selects flaky, high-confidence signals at or above the threshold', () => {
    const r = report([
      signal('a.spec.ts > picks me', { flakinessScore: 0.3 }),
      signal('b.spec.ts > exactly at threshold', { flakinessScore: 0.2 }),
      signal('c.spec.ts > below threshold', { flakinessScore: 0.19 }),
      signal('d.spec.ts > medium confidence', { confidence: 'medium' }),
      signal('e.spec.ts > low confidence', { confidence: 'low' }),
      signal('f.spec.ts > a regression', { classification: 'regression' }),
      signal('g.spec.ts > stable', { classification: 'stable', flakinessScore: 0 }),
    ]);
    const picked = selectQuarantineCandidates(r, emptyState, cfg(), 0.2);
    expect(picked.map((s) => s.testId)).toEqual([
      'a.spec.ts > picks me',
      'b.spec.ts > exactly at threshold',
    ]);
  });

  it('mirrors signal.flakinessThreshold when scoreThreshold is unset', () => {
    expect(resolveScoreThreshold(cfg(), 0.35)).toBe(0.35);
    expect(resolveScoreThreshold(cfg({ scoreThreshold: 0.7 }), 0.35)).toBe(0.7);

    const r = report([signal('a.spec.ts > t', { flakinessScore: 0.5 })]);
    expect(selectQuarantineCandidates(r, emptyState, cfg({ scoreThreshold: 0.7 }), 0.2)).toEqual([]);
  });

  it('never quarantines critical tests', () => {
    const r = report([signal('a.spec.ts > sacred')]);
    const picked = selectQuarantineCandidates(
      r,
      emptyState,
      cfg({ criticalTests: ['a.spec.ts > sacred'] }),
      0.2,
    );
    expect(picked).toEqual([]);
  });

  it('skips tests that are already quarantined', () => {
    const r = report([signal('a.spec.ts > again')]);
    const state: QuarantineState = { version: 1, quarantined: [entry('a.spec.ts > again')] };
    expect(selectQuarantineCandidates(r, state, cfg(), 0.2)).toEqual([]);
  });

  it('determinism: shuffled signals → identical sorted output', () => {
    const signals = [
      signal('c.spec.ts > three'),
      signal('a.spec.ts > one'),
      signal('b.spec.ts > two'),
    ];
    const shuffled = [signals[1]!, signals[2]!, signals[0]!];
    expect(selectQuarantineCandidates(report(shuffled), emptyState, cfg(), 0.2)).toEqual(
      selectQuarantineCandidates(report(signals), emptyState, cfg(), 0.2),
    );
  });
});

describe('release condition', () => {
  const passes = (n: number, fromDay: number) =>
    Array.from({ length: n }, (_, i) => run(fromDay + i, 'pass'));

  it('releases after exactly stableRunsToRelease clean passes', () => {
    const stable = signal('a.spec.ts > t', { history: passes(10, 2) });
    const almost = signal('a.spec.ts > t', { history: passes(9, 2) });
    expect(isReleasable(stable, entry('a.spec.ts > t'), 10)).toBe(true);
    expect(isReleasable(almost, entry('a.spec.ts > t'), 10)).toBe(false);
  });

  it('a failure breaks the streak', () => {
    const history = [...passes(5, 2), run(8, 'fail'), ...passes(9, 10)];
    expect(isReleasable(signal('t', { history }), entry('t'), 10)).toBe(false);
  });

  it('a skip breaks the streak', () => {
    const history = [...passes(5, 2), run(8, 'skip'), ...passes(9, 10)];
    expect(isReleasable(signal('t', { history }), entry('t'), 10)).toBe(false);
  });

  it('a pass with retry flips breaks the streak', () => {
    const history = [run(2, 'pass', 1), ...passes(9, 3)];
    expect(isReleasable(signal('t', { history }), entry('t'), 10)).toBe(false);
  });

  it('runs from before the quarantine never count', () => {
    // 10 clean passes, but 5 predate quarantinedAt (2026-06-01).
    const history = [...passes(5, 2).map((h) => ({ ...h, timestamp: `2026-05-0${h.timestamp[9]}T12:00:00.000Z` })), ...passes(5, 2)];
    expect(isReleasable(signal('t', { history }), entry('t'), 10)).toBe(false);
  });

  it('selectReleaseCandidates skips tests absent from the report and sorts output', () => {
    const state: QuarantineState = {
      version: 1,
      quarantined: [
        entry('gone.spec.ts > vanished'),
        entry('b.spec.ts > stable now'),
        entry('a.spec.ts > also stable'),
      ],
    };
    const r = report([
      signal('b.spec.ts > stable now', { classification: 'stable', history: passes(10, 2) }),
      signal('a.spec.ts > also stable', { classification: 'stable', history: passes(10, 2) }),
    ]);
    const released = selectReleaseCandidates(r, state, cfg());
    expect(released.map((e) => e.testId)).toEqual(['a.spec.ts > also stable', 'b.spec.ts > stable now']);
  });
});
