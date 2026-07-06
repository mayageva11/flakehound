import { z } from 'zod';

export const configSchema = z.object({
  /** Glob(s) of JUnit XML files — the run history. */
  input: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
    .default('reports/**/*.xml'),
  /** History window in days; runs older than this are ignored. Unset = no limit. */
  historyDays: z.number().positive().optional(),
  signal: z
    .object({
      retryFlipWeight: z.number().positive().default(2),
      crossRunFlipWeight: z.number().positive().default(1),
      flakinessThreshold: z.number().min(0).max(1).default(0.2),
      minRuns: z.number().int().min(1).default(3),
      minRegressionStreak: z.number().int().min(1).default(2),
    })
    .prefault({}),
  cluster: z
    .object({
      similarityThreshold: z.number().min(0).max(1).default(0.7),
    })
    .prefault({}),
  ai: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Hypothesis source. 'auto' prefers a reachable local Ollama, then a
       * configured Anthropic key, else skips. 'ollama' / 'anthropic' force one.
       */
      provider: z.enum(['auto', 'anthropic', 'ollama']).default('auto'),
      model: z.string().min(1).default('claude-sonnet-5'),
      maxTokens: z.number().int().positive().default(1024),
      concurrency: z.number().int().min(1).max(8).default(2),
      ollama: z
        .object({
          baseUrl: z.string().min(1).default('http://localhost:11434'),
          model: z.string().min(1).default('llama3.2'),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Previous flakehound.report.json for the CI gate. */
  baseline: z.string().min(1).optional(),
  /** Where to write the report artifact. */
  output: z.string().min(1).default('flakehound.report.json'),
});

/** What users write in flakehound.config.ts (everything optional). */
export type FlakehoundUserConfig = z.input<typeof configSchema>;
/** Fully resolved config after defaults + validation. */
export type FlakehoundConfig = z.output<typeof configSchema>;
