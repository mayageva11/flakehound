import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/util/atomic-write.js';

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fh-atomic-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Assert no run left a stray temp file behind.
  for (const dir of dirs.splice(0)) {
    const leftover = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
    expect(leftover).toEqual([]);
  }
});

describe('writeFileAtomic', () => {
  it('writes the exact bytes to the target', async () => {
    const dir = await scratch();
    const target = join(dir, 'report.json');
    const data = `${JSON.stringify({ version: 1 }, null, 2)}\n`;
    await writeFileAtomic(target, data);
    expect(await readFile(target, 'utf8')).toBe(data);
  });

  it('overwrites an existing file in place', async () => {
    const dir = await scratch();
    const target = join(dir, 'state.json');
    await writeFile(target, 'old', 'utf8');
    await writeFileAtomic(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
  });

  it('leaves no temp file after a successful write', async () => {
    const dir = await scratch();
    await writeFileAtomic(join(dir, 'out.json'), 'x');
    expect((await readdir(dir)).sort()).toEqual(['out.json']);
  });

  it('never exposes a torn file to a concurrent reader', async () => {
    const dir = await scratch();
    const target = join(dir, 'race.json');
    // Seed a valid file so the reader always has something complete to read.
    await writeFileAtomic(target, `${JSON.stringify({ n: 0 })}\n`);

    let stop = false;
    const reader = (async () => {
      while (!stop) {
        // If a partial write were ever visible, JSON.parse would throw.
        JSON.parse(await readFile(target, 'utf8'));
      }
    })();

    for (let n = 1; n <= 200; n++) {
      await writeFileAtomic(target, `${JSON.stringify({ n, pad: 'x'.repeat(n * 50) })}\n`);
    }
    stop = true;
    await expect(reader).resolves.toBeUndefined();
  });
});
