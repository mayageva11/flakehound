import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlaywrightAnnotator } from '../src/quarantine/annotator/playwright.js';
import { QUARANTINE_TAG } from '../src/quarantine/types.js';
import type { AnnotationTarget } from '../src/quarantine/types.js';

const specsDir = fileURLToPath(new URL('./fixtures/quarantine/specs', import.meta.url));
const annotator = new PlaywrightAnnotator();
const marker = { clusterId: 'abc123def456', issueUrl: 'https://github.com/o/r/issues/7' };

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'flakehound-quarantine-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function stage(fixture: string): Promise<string> {
  const dest = path.join(workDir, fixture);
  await copyFile(path.join(specsDir, fixture), dest);
  return dest;
}

function target(filePath: string, testTitle: string, describePath: string[] = []): AnnotationTarget {
  return { testId: `${path.basename(filePath)} > ${testTitle}`, filePath, testTitle, describePath };
}

describe('PlaywrightAnnotator — quarantine', () => {
  it('inserts an options argument and marker on a plain test', async () => {
    const file = await stage('plain.spec.ts');
    const result = await annotator.quarantine(target(file, 'pays with saved card'), marker, {
      dryRun: false,
    });
    expect(result.status).toBe('annotated');

    const text = await readFile(file, 'utf8');
    expect(text).toContain(
      `test('pays with saved card', { tag: '${QUARANTINE_TAG}' }, async ({ page }) => {`,
    );
    expect(text).toContain(
      "// flakehound-quarantined cluster=abc123def456 issue=https://github.com/o/r/issues/7",
    );
    // The sibling test is untouched.
    expect(text).toContain("test('shows an empty cart message', async ({ page }) => {");
  });

  it('is idempotent: second run is a no-op and bytes are identical', async () => {
    const file = await stage('plain.spec.ts');
    const tgt = target(file, 'pays with saved card');
    await annotator.quarantine(tgt, marker, { dryRun: false });
    const afterFirst = await readFile(file, 'utf8');

    const second = await annotator.quarantine(tgt, marker, { dryRun: false });
    expect(second.status).toBe('already-annotated');
    expect(await readFile(file, 'utf8')).toBe(afterFirst);
  });

  it('handles describe nesting and preserves indentation', async () => {
    const file = await stage('nested.spec.ts');
    const result = await annotator.quarantine(
      target(file, 'pays instantly', ['checkout', 'with saved card']),
      marker,
      { dryRun: false },
    );
    expect(result.status).toBe('annotated');

    const text = await readFile(file, 'utf8');
    expect(text).toContain(`test('pays instantly', { tag: '${QUARANTINE_TAG}' }, async ({ page }) => {`);
    expect(text).toMatch(/\n {4}\/\/ flakehound-quarantined /);
  });

  it('disambiguates duplicate titles by describe chain', async () => {
    const file = await stage('duplicate-titles.spec.ts');
    const result = await annotator.quarantine(
      target(file, 'renders the banner', ['mobile']),
      marker,
      { dryRun: false },
    );
    expect(result.status).toBe('annotated');

    const text = await readFile(file, 'utf8');
    const tagged = text.split('\n').filter((l) => l.includes(QUARANTINE_TAG));
    // one tag + one marker line, both inside the mobile describe
    expect(tagged).toHaveLength(1);
    expect(text.indexOf(QUARANTINE_TAG)).toBeGreaterThan(text.indexOf("test.describe('mobile'"));
  });

  it('refuses to edit when duplicate titles cannot be disambiguated', async () => {
    const file = await stage('duplicate-titles.spec.ts');
    const before = await readFile(file, 'utf8');
    const result = await annotator.quarantine(target(file, 'renders the banner'), marker, {
      dryRun: false,
    });
    expect(result.status).toBe('ambiguous');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('adds a tag property to an existing options object', async () => {
    const file = await stage('with-options.spec.ts');
    const result = await annotator.quarantine(target(file, 'uploads a large file'), marker, {
      dryRun: false,
    });
    expect(result.status).toBe('annotated');

    const text = await readFile(file, 'utf8');
    expect(text).toContain(`tag: '${QUARANTINE_TAG}'`);
    expect(text).toContain("annotation: { type: 'slow', description: 'big fixture' }");
  });

  it('turns an existing string tag into an array', async () => {
    const file = await stage('tag-string.spec.ts');
    await annotator.quarantine(target(file, 'syncs the ledger'), marker, { dryRun: false });
    expect(await readFile(file, 'utf8')).toContain(`tag: ['@slow', '${QUARANTINE_TAG}']`);
  });

  it('appends to an existing tag array', async () => {
    const file = await stage('tag-array.spec.ts');
    await annotator.quarantine(target(file, 'reconciles accounts'), marker, { dryRun: false });
    expect(await readFile(file, 'utf8')).toContain(
      `tag: ['@slow', '@nightly', '${QUARANTINE_TAG}']`,
    );
  });

  it('reports not-found for computed titles instead of guessing', async () => {
    const file = await stage('computed-title.spec.ts');
    const result = await annotator.quarantine(target(file, 'loads the us dashboard'), marker, {
      dryRun: false,
    });
    expect(result.status).toBe('not-found');
  });

  it('never writes in dry-run mode', async () => {
    const file = await stage('plain.spec.ts');
    const before = await readFile(file, 'utf8');
    const result = await annotator.quarantine(target(file, 'pays with saved card'), marker, {
      dryRun: true,
    });
    expect(result.status).toBe('annotated');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('repairs a missing marker without duplicating the tag', async () => {
    const file = await stage('plain.spec.ts');
    const tgt = target(file, 'pays with saved card');
    await annotator.quarantine(tgt, marker, { dryRun: false });

    // A human deletes the marker line but leaves the tag.
    const withoutMarker = (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => !line.includes('// flakehound-quarantined'))
      .join('\n');
    await writeFile(file, withoutMarker, 'utf8');

    const repaired = await annotator.quarantine(tgt, marker, { dryRun: false });
    expect(repaired.status).toBe('annotated');
    const text = await readFile(file, 'utf8');
    expect(text.split('\n').filter((l) => l.includes('// flakehound-quarantined'))).toHaveLength(1);
    expect(text.split(`tag: '${QUARANTINE_TAG}'`).length - 1).toBe(1); // tag not duplicated
  });
});

describe('PlaywrightAnnotator — release', () => {
  it('restores the original bytes when we created the options object', async () => {
    const file = await stage('plain.spec.ts');
    const original = await readFile(file, 'utf8');
    const tgt = target(file, 'pays with saved card');

    await annotator.quarantine(tgt, marker, { dryRun: false });
    const released = await annotator.release(tgt, { dryRun: false });
    expect(released.status).toBe('annotated');
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('restores an original string tag exactly', async () => {
    const file = await stage('tag-string.spec.ts');
    const original = await readFile(file, 'utf8');
    const tgt = target(file, 'syncs the ledger');

    await annotator.quarantine(tgt, marker, { dryRun: false });
    await annotator.release(tgt, { dryRun: false });
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('restores an original tag array exactly', async () => {
    const file = await stage('tag-array.spec.ts');
    const original = await readFile(file, 'utf8');
    const tgt = target(file, 'reconciles accounts');

    await annotator.quarantine(tgt, marker, { dryRun: false });
    await annotator.release(tgt, { dryRun: false });
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('is a no-op on a test that is not quarantined', async () => {
    const file = await stage('plain.spec.ts');
    const before = await readFile(file, 'utf8');
    const result = await annotator.release(target(file, 'pays with saved card'), {
      dryRun: false,
    });
    expect(result.status).toBe('already-annotated');
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('never writes in dry-run mode', async () => {
    const file = await stage('plain.spec.ts');
    const tgt = target(file, 'pays with saved card');
    await annotator.quarantine(tgt, marker, { dryRun: false });
    const before = await readFile(file, 'utf8');

    const result = await annotator.release(tgt, { dryRun: true });
    expect(result.status).toBe('annotated');
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

describe('PlaywrightAnnotator — readMarker', () => {
  it('reads back the cluster id and issue url', async () => {
    const file = await stage('plain.spec.ts');
    const tgt = target(file, 'pays with saved card');
    await annotator.quarantine(tgt, marker, { dryRun: false });
    expect(await annotator.readMarker(tgt)).toEqual(marker);
  });

  it('returns undefined when there is no marker', async () => {
    const file = await stage('plain.spec.ts');
    expect(await annotator.readMarker(target(file, 'pays with saved card'))).toBeUndefined();
  });
});
