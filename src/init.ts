import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { CONFIG_FILES, findConfigFile, loadConfig } from './config/load.js';
import { FlakehoundError } from './util/errors.js';

export interface RunInitOptions {
  cwd?: string;
  log?: (message: string) => void;
  /** Overwrite an existing config (off by default — init never clobbers). */
  force?: boolean;
}

/**
 * The scaffolded config. Every field carries its schema default and a one-line
 * comment, so the file is the documentation.
 *
 * Deliberately NO runtime import: `import type` + `satisfies` are erased when
 * jiti loads the file, so the config works even when flakehound is not
 * installed in the project's node_modules (the `npx flakehound init` case),
 * while IDEs still get full IntelliSense once it is a dependency.
 */
const CONFIG_TEMPLATE = `import type { FlakehoundUserConfig } from 'flakehound';

export default {
  /** Glob(s) of JUnit XML files — the accumulated run history to analyze. */
  input: 'reports/**/*.xml',

  /** Only analyze runs from the last N days. Delete to analyze everything. */
  // historyDays: 21,

  signal: {
    /** Score at or above which a test is classified flaky (0–1). */
    flakinessThreshold: 0.2,
    /** Minimum scorable runs before classifying a test at all. */
    minRuns: 3,
    /** Minimum trailing all-fail runs required to call a regression. */
    minRegressionStreak: 2,
    /** Weight of a fail↔pass flip WITHIN one run (retries) — the strongest flaky signal. */
    retryFlipWeight: 2,
    /** Weight of a pass↔fail transition across runs on the same commit. */
    crossRunFlipWeight: 1,
  },

  cluster: {
    /** Similarity at or above which two failures share a cluster (0–1). */
    similarityThreshold: 0.7,
    /** 'head': error class + message weigh double (resists false merges). 'uniform': plain Jaccard. */
    weighting: 'head',
  },

  ai: {
    /** Master switch for the optional root-cause hypotheses. \`--no-ai\` overrides. */
    enabled: true,
    /** 'auto': local Ollama if reachable → Claude API if ANTHROPIC_API_KEY is set → skip. */
    provider: 'auto',
    /** Anthropic model (used when the Claude API is selected). */
    model: 'claude-sonnet-5',
    ollama: {
      /** Local Ollama HTTP endpoint. */
      baseUrl: 'http://localhost:11434',
      /** Local model tag. */
      model: 'llama3.2',
    },
  },

  /** Previous report for the CI gate — new regressions fail, known ones don't. */
  // baseline: 'flakehound.report.json',

  /** Where the report artifact is written. */
  output: 'flakehound.report.json',
} satisfies FlakehoundUserConfig;
`;

/**
 * `flakehound init` — scaffold a commented flakehound.config.ts in cwd.
 * Never overwrites an existing config (any of the four supported names);
 * round-trips the written file through loadConfig so a broken template can
 * never ship silently.
 */
export async function runInit(options: RunInitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((message: string) => console.log(message));

  const existing = options.force === true ? undefined : findConfigFile(cwd);
  if (existing !== undefined) {
    throw new FlakehoundError(
      `a config file already exists at ${existing} — refusing to overwrite it.\n` +
        `  Edit that file directly, or move it aside and re-run \`flakehound init\`.\n` +
        `  (Supported names, first match wins: ${CONFIG_FILES.join(', ')})`,
    );
  }

  const filePath = path.join(cwd, 'flakehound.config.ts');
  await writeFile(filePath, CONFIG_TEMPLATE, 'utf8');

  // Self-validation: if the template ever drifts off-schema, fail HERE, loudly,
  // instead of shipping a broken scaffold to users.
  await loadConfig({ cwd });

  log(
    [
      `${pc.green('✓')} Created ${pc.bold('flakehound.config.ts')}`,
      '',
      pc.bold('Next steps:'),
      `  1. Point your test runner at JUnit XML output (Jest, Playwright, pytest, JUnit — all emit it).`,
      `  2. Collect runs into a history folder matching ${pc.cyan("input: 'reports/**/*.xml'")} (edit to taste).`,
      `  3. Run your first analysis:`,
      '',
      `       ${pc.cyan('npx flakehound analyze')}`,
      '',
      `  4. Dig into any test's run-by-run story:`,
      '',
      `       ${pc.cyan("npx flakehound explain 'suite > test name'")}`,
      '',
      pc.dim('Docs: https://github.com/mayageva11/flakehound#readme'),
    ].join('\n'),
  );
}
