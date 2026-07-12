import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMarkerComment,
  isMarkerComment,
  parseMarkerComment,
} from '../src/quarantine/marker.js';
import { parseTestId, resolveSpecFile } from '../src/quarantine/locate.js';

const locateDir = fileURLToPath(new URL('./fixtures/quarantine/locate', import.meta.url));

describe('marker comment — build/parse round-trip', () => {
  it('round-trips full info (cluster + issue)', () => {
    const line = buildMarkerComment({
      clusterId: 'a1b2c3d4e5f6',
      issueUrl: 'https://github.com/o/r/issues/12',
    });
    expect(parseMarkerComment(line)).toEqual({
      clusterId: 'a1b2c3d4e5f6',
      issueUrl: 'https://github.com/o/r/issues/12',
    });
  });

  it('encodes unknown cluster as none and unknown issue as pending', () => {
    const line = buildMarkerComment({});
    expect(line).toContain('cluster=none');
    expect(line).toContain('issue=pending');
    expect(parseMarkerComment(line)).toEqual({});
  });

  it('round-trips cluster-only and issue-only', () => {
    expect(parseMarkerComment(buildMarkerComment({ clusterId: 'abc123' }))).toEqual({
      clusterId: 'abc123',
    });
    expect(parseMarkerComment(buildMarkerComment({ issueUrl: 'https://x/1' }))).toEqual({
      issueUrl: 'https://x/1',
    });
  });

  it('tolerates surrounding indentation', () => {
    const line = `    ${buildMarkerComment({ clusterId: 'abc123' })}`;
    expect(parseMarkerComment(line)).toEqual({ clusterId: 'abc123' });
    expect(isMarkerComment(line)).toBe(true);
  });

  it('rejects non-marker lines', () => {
    expect(parseMarkerComment('// a normal comment')).toBeUndefined();
    expect(parseMarkerComment("test('pays', async () => {})")).toBeUndefined();
    expect(parseMarkerComment('// flakehound-quarantined but mangled')).toBeUndefined();
    expect(isMarkerComment('// a normal comment')).toBe(false);
  });
});

describe('parseTestId', () => {
  it('splits file, describe chain, and title', () => {
    expect(parseTestId('e2e/shop.spec.ts > checkout > pays with saved card')).toEqual({
      fileSegment: 'e2e/shop.spec.ts',
      describePath: ['checkout'],
      testTitle: 'pays with saved card',
    });
  });

  it('handles a flat testId with no describe', () => {
    expect(parseTestId('shop.spec.ts > pays')).toEqual({
      fileSegment: 'shop.spec.ts',
      describePath: [],
      testTitle: 'pays',
    });
  });

  it('normalizes Windows separators in the file segment', () => {
    expect(parseTestId('e2e\\shop.spec.ts > pays')?.fileSegment).toBe('e2e/shop.spec.ts');
  });

  it('returns undefined for a single-segment testId', () => {
    expect(parseTestId('just-a-name')).toBeUndefined();
  });
});

describe('resolveSpecFile', () => {
  it('resolves a direct path relative to cwd', async () => {
    const result = await resolveSpecFile('e2e/shop.spec.ts > pays with saved card', locateDir);
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.target.filePath).toBe(path.join(locateDir, 'e2e', 'shop.spec.ts'));
    expect(result.target.testTitle).toBe('pays with saved card');
    expect(result.target.describePath).toEqual([]);
  });

  it('falls back to a glob search when the segment is not repo-root-relative', async () => {
    const result = await resolveSpecFile('shop.spec.ts > pays with saved card', locateDir);
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.target.filePath).toBe(path.join(locateDir, 'e2e', 'shop.spec.ts'));
  });

  it('reports ambiguity instead of guessing between same-basename files', async () => {
    const result = await resolveSpecFile('dup.spec.ts > duplicate a', locateDir);
    expect(result.status).toBe('ambiguous');
  });

  it('disambiguates by full segment when the testId carries a directory', async () => {
    const result = await resolveSpecFile('a/dup.spec.ts > duplicate a', locateDir);
    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.target.filePath).toBe(path.join(locateDir, 'a', 'dup.spec.ts'));
  });

  it('fails safe on non-path segments (pytest/Jest-style ids)', async () => {
    const result = await resolveSpecFile('com.example.CheckoutTest > testPays', locateDir);
    expect(result.status).toBe('not-found');
  });

  it('fails safe when the file does not exist anywhere', async () => {
    const result = await resolveSpecFile('missing.spec.ts > pays', locateDir);
    expect(result.status).toBe('not-found');
  });
});
