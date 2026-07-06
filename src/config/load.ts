import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { FlakehoundError } from '../util/errors.js';
import { configSchema } from './schema.js';
import type { FlakehoundConfig } from './schema.js';

/** Resolution order: first existing file wins. */
const CONFIG_FILES = [
  'flakehound.config.ts',
  'flakehound.config.js',
  'flakehound.config.mjs',
  'flakehound.config.json',
];

/** CLI flags — they win over config-file values. */
export interface CliOverrides {
  input?: string;
  baseline?: string;
  output?: string;
  /** false = --no-ai. */
  ai?: boolean;
}

export interface LoadConfigOptions {
  cwd?: string;
  /** Explicit --config path; skips the search. */
  configPath?: string;
  overrides?: CliOverrides;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<FlakehoundConfig> {
  const cwd = options.cwd ?? process.cwd();
  const filePath = resolveConfigPath(cwd, options.configPath);
  const fileConfig = filePath === undefined ? {} : await readConfigFile(filePath);
  const merged = applyOverrides(fileConfig, options.overrides ?? {});

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || '(root)';
    const source = filePath === undefined ? '' : ` in ${filePath}`;
    throw new FlakehoundError(
      `Invalid configuration${source}: field "${field}" — ${issue?.message ?? 'unknown error'}`,
    );
  }
  return result.data;
}

function resolveConfigPath(cwd: string, explicit: string | undefined): string | undefined {
  if (explicit !== undefined) {
    const abs = path.resolve(cwd, explicit);
    if (!existsSync(abs)) {
      throw new FlakehoundError(`Config file not found: ${abs}`);
    }
    return abs;
  }
  for (const candidate of CONFIG_FILES) {
    const abs = path.join(cwd, candidate);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

async function readConfigFile(filePath: string): Promise<Record<string, unknown>> {
  let loaded: unknown;
  if (filePath.endsWith('.json')) {
    try {
      loaded = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (cause) {
      throw new FlakehoundError(`Invalid JSON in config file ${filePath}`, { cause });
    }
  } else {
    // jiti transpiles TypeScript config files at runtime (same pattern as
    // Vite/Nuxt), so flakehound.config.ts works without a build step.
    const jiti = createJiti(import.meta.url);
    try {
      loaded = await jiti.import(filePath, { default: true });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new FlakehoundError(`Failed to load config file ${filePath}: ${detail}`, { cause });
    }
  }
  if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
    throw new FlakehoundError(
      `Config file ${filePath} must export a configuration object (got ${Array.isArray(loaded) ? 'array' : typeof loaded})`,
    );
  }
  return loaded as Record<string, unknown>;
}

function applyOverrides(
  fileConfig: Record<string, unknown>,
  overrides: CliOverrides,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...fileConfig };
  if (overrides.input !== undefined) merged['input'] = overrides.input;
  if (overrides.baseline !== undefined) merged['baseline'] = overrides.baseline;
  if (overrides.output !== undefined) merged['output'] = overrides.output;
  if (overrides.ai === false) {
    const fileAi = fileConfig['ai'];
    merged['ai'] = {
      ...(typeof fileAi === 'object' && fileAi !== null ? fileAi : {}),
      enabled: false,
    };
  }
  return merged;
}
