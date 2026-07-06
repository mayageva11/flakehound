import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJUnitXml } from '../src/ingest/junit-parser.js';
import { FlakehoundError } from '../src/util/errors.js';
import type { RunMetadata } from '../src/ingest/types.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/ingest/${name}`, import.meta.url)), 'utf8');
}

const sidecarMeta: RunMetadata = {
  commitSha: 'a1b2c3d',
  runnerId: 'ubuntu-22',
  timestamp: '2026-07-01T10:00:00.000Z',
  source: 'sidecar',
};

const mtimeMeta: RunMetadata = {
  timestamp: '2026-07-03T00:00:00.000Z',
  source: 'mtime',
};

describe('parseJUnitXml', () => {
  it('parses a jest-style report with nested testsuites root', () => {
    const runs = parseJUnitXml(fixture('jest.xml'), sidecarMeta);

    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.status)).toEqual(['pass', 'pass', 'fail']);

    const failed = runs[2]!;
    expect(failed.testId).toBe('auth/login.test.ts > LoginForm > shows session timeout banner');
    expect(failed.durationMs).toBe(456);
    expect(failed.errorMessage).toBe('expect(received).toBe(expected)');
    expect(failed.stackTrace).toContain('login.test.ts:42:19');
    expect(failed.commitSha).toBe('a1b2c3d');
    expect(failed.runnerId).toBe('ubuntu-22');
  });

  it('keeps retried testcases as separate runs with the same testId', () => {
    const runs = parseJUnitXml(fixture('playwright-retries.xml'), sidecarMeta);

    expect(runs).toHaveLength(2);
    expect(runs[0]!.testId).toBe(runs[1]!.testId);
    expect(runs[0]!.testId).toBe('checkout.spec.ts > completes payment');
    expect(runs.map((r) => r.status)).toEqual(['fail', 'pass']);
  });

  it('parses pytest reports: bare testsuite root, skipped, and <error> faults', () => {
    const runs = parseJUnitXml(fixture('pytest.xml'), sidecarMeta);

    expect(runs.map((r) => r.status)).toEqual(['pass', 'skip', 'fail']);

    const errored = runs[2]!;
    expect(errored.testId).toBe('pytest > tests.test_api > test_db_connection');
    expect(errored.errorMessage).toBe('ConnectionError: could not connect to postgres:5432');
    expect(errored.stackTrace).toContain('psycopg2.connect');
  });

  it('prefers the <testsuite timestamp> attribute only when metadata came from mtime', () => {
    const fromMtime = parseJUnitXml(fixture('jest.xml'), mtimeMeta);
    expect(fromMtime[0]!.timestamp).toBe('2026-07-01T10:00:00.000Z');

    const fromSidecar = parseJUnitXml(fixture('jest.xml'), sidecarMeta);
    expect(fromSidecar[0]!.timestamp).toBe(sidecarMeta.timestamp);
  });

  it('throws a readable error on malformed XML', () => {
    expect(() => parseJUnitXml(fixture('malformed.xml'), mtimeMeta)).toThrow(FlakehoundError);
    expect(() => parseJUnitXml(fixture('malformed.xml'), mtimeMeta)).toThrow(/Invalid XML/);
  });

  it('throws a readable error when no suite root exists', () => {
    expect(() => parseJUnitXml('<report/>', mtimeMeta)).toThrow(/No <testsuites>/);
  });
});
