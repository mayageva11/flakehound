import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeTimestamp, resolveRunMetadata } from '../src/ingest/metadata.js';
import { FlakehoundError } from '../src/util/errors.js';

function fixturePath(relative: string): string {
  return fileURLToPath(new URL(`./fixtures/${relative}`, import.meta.url));
}

describe('normalizeTimestamp', () => {
  it('treats naive timestamps as UTC for machine-independent results', () => {
    expect(normalizeTimestamp('2026-07-01T10:00:00')).toBe('2026-07-01T10:00:00.000Z');
  });

  it('accepts directory-name form with hyphens in the time part', () => {
    expect(normalizeTimestamp('2026-07-01T10-00')).toBe('2026-07-01T10:00:00.000Z');
  });

  it('preserves explicit timezone offsets', () => {
    expect(normalizeTimestamp('2026-07-01T10:00:00+02:00')).toBe('2026-07-01T08:00:00.000Z');
  });

  it('returns undefined for garbage', () => {
    expect(normalizeTimestamp('not-a-date')).toBeUndefined();
  });
});

describe('resolveRunMetadata', () => {
  it('uses the sidecar when present (highest priority)', async () => {
    const meta = await resolveRunMetadata(
      fixturePath('metadata/f9e8d7c_2026-07-02T09-15/junit.xml'),
    );
    expect(meta.source).toBe('sidecar');
    expect(meta.commitSha).toBe('f9e8d7c99a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d');
    expect(meta.runnerId).toBe('ubuntu-22');
    expect(meta.timestamp).toBe('2026-07-02T09:15:30.000Z');
  });

  it('falls back to the {sha}_{timestamp} directory convention', async () => {
    const meta = await resolveRunMetadata(
      fixturePath('metadata/a1b2c3d_2026-07-01T10-00/junit.xml'),
    );
    expect(meta.source).toBe('dirname');
    expect(meta.commitSha).toBe('a1b2c3d');
    expect(meta.runnerId).toBeUndefined();
    expect(meta.timestamp).toBe('2026-07-01T10:00:00.000Z');
  });

  it('bottoms out at file mtime with commitSha/runnerId undefined', async () => {
    const meta = await resolveRunMetadata(fixturePath('metadata/plain/junit.xml'));
    expect(meta.source).toBe('mtime');
    expect(meta.commitSha).toBeUndefined();
    expect(meta.runnerId).toBeUndefined();
    expect(Number.isNaN(Date.parse(meta.timestamp))).toBe(false);
  });

  it('surfaces an off-schema sidecar (valid JSON, wrong field type) naming the field', async () => {
    await expect(
      resolveRunMetadata(fixturePath('offschema-sidecar/junit.xml')),
    ).rejects.toThrow(FlakehoundError);
    await expect(
      resolveRunMetadata(fixturePath('offschema-sidecar/junit.xml')),
    ).rejects.toThrow(/Invalid metadata sidecar .*field "commitSha"/);
  });

  it('surfaces a corrupt sidecar as a readable error instead of silently degrading', async () => {
    await expect(
      resolveRunMetadata(fixturePath('corrupt-sidecar/junit.xml')),
    ).rejects.toThrow(FlakehoundError);
    await expect(
      resolveRunMetadata(fixturePath('corrupt-sidecar/junit.xml')),
    ).rejects.toThrow(/Invalid JSON in metadata sidecar/);
  });
});
