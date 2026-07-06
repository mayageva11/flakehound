import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/ingest/index.js';
import { FlakehoundError } from '../src/util/errors.js';

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url));

describe('ingest', () => {
  it('ingests a run history across all metadata sources', async () => {
    const { runs, summary } = await ingest('metadata/*/junit.xml', fixturesDir);

    expect(summary.filesParsed).toBe(3);
    expect(summary.testRuns).toBe(5);
    expect(summary.metadataSources).toEqual({ sidecar: 1, dirname: 1, mtime: 1 });

    const flakyCheckout = runs.filter(
      (r) => r.testId === 'checkout.spec.ts > flaky checkout',
    );
    expect(flakyCheckout).toHaveLength(2);
    expect(new Set(flakyCheckout.map((r) => r.status))).toEqual(new Set(['pass', 'fail']));
    expect(new Set(flakyCheckout.map((r) => r.commitSha))).toEqual(
      new Set(['a1b2c3d', 'f9e8d7c99a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d']),
    );
  });

  it('returns files in deterministic (sorted) order', async () => {
    const first = await ingest('metadata/*/junit.xml', fixturesDir);
    const second = await ingest('metadata/*/junit.xml', fixturesDir);
    expect(first.runs).toEqual(second.runs);
  });

  it('names the offending file when XML parsing fails', async () => {
    await expect(ingest('ingest/malformed.xml', fixturesDir)).rejects.toThrow(FlakehoundError);
    await expect(ingest('ingest/malformed.xml', fixturesDir)).rejects.toThrow(/malformed\.xml/);
  });

  it('handles an empty glob gracefully', async () => {
    const { runs, summary } = await ingest('does-not-exist/**/*.xml', fixturesDir);
    expect(runs).toEqual([]);
    expect(summary.filesParsed).toBe(0);
  });
});
