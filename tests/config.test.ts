import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '../src/config/define-config.js';
import { loadConfig } from '../src/config/load.js';
import { configSchema } from '../src/config/schema.js';
import { FlakehoundError } from '../src/util/errors.js';

function projectDir(name: string): string {
  return fileURLToPath(new URL(`./fixtures/config/${name}`, import.meta.url));
}

describe('loadConfig', () => {
  it('loads flakehound.config.ts at runtime via jiti', async () => {
    const config = await loadConfig({ cwd: projectDir('ts-project') });
    expect(config.input).toBe('runs/**/*.xml');
    expect(config.signal.minRuns).toBe(5);
    // untouched fields fall back to schema defaults
    expect(config.signal.flakinessThreshold).toBe(0.2);
    expect(config.cluster.similarityThreshold).toBe(0.7);
    expect(config.ai.model).toBe('claude-sonnet-5');
    expect(config.output).toBe('flakehound.report.json');
  });

  it('loads flakehound.config.json', async () => {
    const config = await loadConfig({ cwd: projectDir('json-project') });
    expect(config.input).toBe('json-runs/**/*.xml');
    expect(config.ai.enabled).toBe(false);
  });

  it('resolves pure defaults when no config file exists', async () => {
    const config = await loadConfig({ cwd: projectDir('empty-project') });
    expect(config.input).toBe('reports/**/*.xml');
    expect(config.signal.minRuns).toBe(3);
    expect(config.ai.enabled).toBe(true);
  });

  it('resolves quarantine defaults (opt-in, mirrored threshold left unset)', async () => {
    const config = await loadConfig({ cwd: projectDir('empty-project') });
    expect(config.quarantine).toEqual({
      enabled: false,
      stableRunsToRelease: 10,
      criticalTests: [],
      framework: 'playwright',
      github: { createIssues: true },
      state: 'flakehound.quarantine.json',
    });
    expect(config.quarantine.scoreThreshold).toBeUndefined();
  });

  it('validates quarantine.github.repo as "owner/repo"', () => {
    expect(configSchema.safeParse({ quarantine: { github: { repo: 'o/r' } } }).success).toBe(true);
    expect(configSchema.safeParse({ quarantine: { github: { repo: 'not a slug' } } }).success).toBe(
      false,
    );
    expect(
      configSchema.safeParse({ quarantine: { github: { repo: 'too/many/parts' } } }).success,
    ).toBe(false);
  });

  it('CLI flags override config-file values', async () => {
    const config = await loadConfig({
      cwd: projectDir('ts-project'),
      overrides: { input: 'flag/**/*.xml', output: 'custom.json', ai: false },
    });
    expect(config.input).toBe('flag/**/*.xml'); // flag wins over file
    expect(config.output).toBe('custom.json');
    expect(config.ai.enabled).toBe(false); // --no-ai
    expect(config.signal.minRuns).toBe(5); // non-overridden file value survives
  });

  it('invalid config → readable error naming the offending field', async () => {
    await expect(loadConfig({ cwd: projectDir('invalid-project') })).rejects.toThrow(
      FlakehoundError,
    );
    await expect(loadConfig({ cwd: projectDir('invalid-project') })).rejects.toThrow(
      /field "signal\.flakinessThreshold"/,
    );
  });

  it('explicit --config path that does not exist → readable error', async () => {
    await expect(
      loadConfig({ cwd: projectDir('empty-project'), configPath: 'nope.config.ts' }),
    ).rejects.toThrow(/Config file not found/);
  });
});

describe('defineConfig', () => {
  it('is a typed identity helper', () => {
    const config = defineConfig({ input: 'x/**/*.xml', signal: { minRuns: 4 } });
    expect(config).toEqual({ input: 'x/**/*.xml', signal: { minRuns: 4 } });
  });
});
