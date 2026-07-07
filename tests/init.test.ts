import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { runInit } from '../src/init.js';
import { runAnalyze } from '../src/run.js';
import { FlakehoundError } from '../src/util/errors.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'flakehound-init-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('flakehound init', () => {
  it('creates flakehound.config.ts and prints next steps', async () => {
    const log = vi.fn();
    await runInit({ cwd: dir, log });

    const content = await readFile(path.join(dir, 'flakehound.config.ts'), 'utf8');
    // type-only import — must load under jiti even when the package is absent
    expect(content).toContain("import type { FlakehoundUserConfig } from 'flakehound'");
    expect(content).toContain('satisfies FlakehoundUserConfig');
    expect(content).not.toContain('defineConfig'); // no runtime import
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('flakehound.config.ts');
    expect(log.mock.calls[0]![0]).toContain('flakehound analyze');
  });

  it('the generated file round-trips through loadConfig with pure defaults', async () => {
    await runInit({ cwd: dir, log: () => {} });
    const config = await loadConfig({ cwd: dir });
    expect(config.input).toBe('reports/**/*.xml');
    expect(config.signal.flakinessThreshold).toBe(0.2);
    expect(config.signal.minRuns).toBe(3);
    expect(config.cluster.weighting).toBe('head');
    expect(config.ai.provider).toBe('auto');
    expect(config.ai.ollama.model).toBe('llama3.2');
    expect(config.output).toBe('flakehound.report.json');
  });

  it.each(['flakehound.config.ts', 'flakehound.config.js', 'flakehound.config.mjs', 'flakehound.config.json'])(
    'refuses to overwrite an existing %s (exit-2 path), naming the file',
    async (existing) => {
      const sentinel = existing.endsWith('.json') ? '{"input":"keep/**"}' : 'export default {};';
      await writeFile(path.join(dir, existing), sentinel, 'utf8');

      await expect(runInit({ cwd: dir, log: () => {} })).rejects.toThrowError(FlakehoundError);
      await expect(runInit({ cwd: dir, log: () => {} })).rejects.toThrowError(
        new RegExp(existing.replace(/\./g, '\\.')),
      );
      // untouched
      expect(await readFile(path.join(dir, existing), 'utf8')).toBe(sentinel);
    },
  );

  it('--force overwrites deliberately', async () => {
    await writeFile(path.join(dir, 'flakehound.config.ts'), 'export default {};', 'utf8');
    await runInit({ cwd: dir, log: () => {}, force: true });
    const content = await readFile(path.join(dir, 'flakehound.config.ts'), 'utf8');
    expect(content).toContain('satisfies FlakehoundUserConfig');
  });
});

describe('graceful degraded states', () => {
  it('analyze with a glob matching zero files → FlakehoundError with guidance, never a silent pass', async () => {
    const attempt = runAnalyze({
      cwd: dir,
      overrides: { input: 'does-not-exist/**/*.xml', ai: false },
      log: () => {},
      warn: () => {},
    });
    await expect(attempt).rejects.toThrowError(FlakehoundError);
    await expect(
      runAnalyze({
        cwd: dir,
        overrides: { input: 'does-not-exist/**/*.xml', ai: false },
        log: () => {},
        warn: () => {},
      }),
    ).rejects.toThrowError(/no JUnit XML files matched 'does-not-exist\/\*\*\/\*\.xml'[\s\S]*flakehound init/);
  });

  it('no config file + no --input → one info line suggesting init, then defaults proceed', async () => {
    const warn = vi.fn();
    // default glob reports/**/*.xml matches nothing in the tmp dir → the run
    // still ends in the empty-glob error, but the info line fired first.
    await runAnalyze({ cwd: dir, log: () => {}, warn }).catch(() => {});
    const infoLine = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('flakehound init'));
    expect(infoLine).toContain('no flakehound.config.* found');
    expect(infoLine).toContain('reports/**/*.xml');
  });

  it('an explicit --input suppresses the no-config info line', async () => {
    const warn = vi.fn();
    await runAnalyze({
      cwd: dir,
      overrides: { input: 'x/**/*.xml' },
      log: () => {},
      warn,
    }).catch(() => {});
    expect(
      warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('no flakehound.config.*')),
    ).toBeUndefined();
  });
});
