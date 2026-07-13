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
      /**
       * 'head' weights error-class/message tokens double so the bug's identity
       * dominates shared library frames; 'uniform' is the original Jaccard.
       */
      weighting: z.enum(['head', 'uniform']).default('head'),
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
  quarantine: z
    .object({
      /** Reserved for future analyze-integrated automation; running the subcommand is the opt-in. */
      enabled: z.boolean().default(false),
      /** Minimum flakinessScore to quarantine. Unset = mirrors signal.flakinessThreshold. */
      scoreThreshold: z.number().min(0).max(1).optional(),
      /** Consecutive clean passes (after quarantine) required to auto-release. */
      stableRunsToRelease: z.number().int().min(1).default(10),
      /** Test ids that must never be auto-quarantined. */
      criticalTests: z.array(z.string().min(1)).default([]),
      framework: z.enum(['playwright']).default('playwright'),
      github: z
        .object({
          createIssues: z.boolean().default(true),
          /** "owner/repo"; unset = inferred from the git remote 'origin'. */
          repo: z
            .string()
            .regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/repo"')
            .optional(),
        })
        .prefault({}),
      /** Where the quarantine state artifact lives. */
      state: z.string().min(1).default('flakehound.quarantine.json'),
    })
    .prefault({}),
  /** Previous flakehound.report.json for the CI gate. */
  baseline: z.string().min(1).optional(),
  /** Where to write the report artifact. */
  output: z.string().min(1).default('flakehound.report.json'),
  html: z
    .object({
      /**
       * Where to write the self-contained HTML report (the dashboard with the
       * report embedded — opens from file://, no server). Unset = not emitted;
       * the bare `--html` flag defaults it to flakehound.report.html.
       */
      output: z.string().min(1).optional(),
      /**
       * Extra dashboard settings embedded as window.FHCONFIG. stableRuns is
       * filled from quarantine.stableRunsToRelease automatically; anything
       * set here wins.
       */
      dashboard: z.record(z.string(), z.unknown()).default({}),
    })
    .prefault({}),
});

/** What users write in flakehound.config.ts (everything optional). */
export type FlakehoundUserConfig = z.input<typeof configSchema>;
/** Fully resolved config after defaults + validation. */
export type FlakehoundConfig = z.output<typeof configSchema>;
