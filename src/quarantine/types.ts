import type { Confidence } from '../signal/types.js';

/**
 * The Playwright tag attached to every quarantined test. CI splits on it:
 * the blocking lane runs `--grep-invert` on this tag, a non-blocking lane
 * runs `--grep` on it so quarantined tests keep producing signal — that
 * signal is what later satisfies `stableRunsToRelease` and releases them.
 */
export const QUARANTINE_TAG = '@flakehound-quarantined';

export interface QuarantineIssueRef {
  number: number;
  url: string;
}

/** One quarantined test as recorded in flakehound.quarantine.json. */
export interface QuarantineEntry {
  testId: string;
  /** Spec file path relative to the project root, as resolved at quarantine time. */
  file: string;
  quarantinedAt: string;
  /** Snapshot of the evidence that justified quarantining. */
  flakinessScore: number;
  confidence: Confidence;
  clusterId?: string;
  issue?: QuarantineIssueRef;
}

/**
 * The flakehound.quarantine.json artifact. Committing it to the repo is what
 * prevents duplicate quarantines and duplicate GitHub issues across CI runs.
 */
export interface QuarantineState {
  version: 1;
  quarantined: QuarantineEntry[];
}

/** What the marker comment above a quarantined test encodes. */
export interface MarkerInfo {
  clusterId?: string;
  issueUrl?: string;
}

/** A test pinpointed in its source file, derived from the report's testId. */
export interface AnnotationTarget {
  testId: string;
  /** Absolute path to the spec file. */
  filePath: string;
  /** Last ' > ' segment of the testId — the test's own title. */
  testTitle: string;
  /** Middle segments — the enclosing describe chain (may be empty). */
  describePath: string[];
}

/**
 *'not-found' and 'ambiguous' are expected outcomes, not errors: the candidate
 * is skipped with a warning and the batch continues — we never guess which
 * test to edit.
 */
export type AnnotateResult =
  | { status: 'annotated'; filePath: string }
  | { status: 'already-annotated' }
  | { status: 'not-found'; detail: string }
  | { status: 'ambiguous'; detail: string };

/**
 * Framework-specific quarantine editing behind one interface, mirroring
 * HypothesisProvider: the orchestrator never knows how a framework expresses
 * "quarantined". Implementations must be idempotent (quarantining an already
 * quarantined test is a no-op) and must never write when dryRun is set.
 */
export interface QuarantineAnnotator {
  /** Stable identifier, e.g. 'playwright'. */
  readonly name: string;
  /** The tag this annotator attaches, e.g. QUARANTINE_TAG. */
  readonly tag: string;
  quarantine(
    target: AnnotationTarget,
    marker: MarkerInfo,
    opts: { dryRun: boolean },
  ): Promise<AnnotateResult>;
  release(target: AnnotationTarget, opts: { dryRun: boolean }): Promise<AnnotateResult>;
  /** Read the marker comment (for the issue URL) without editing anything. */
  readMarker(target: AnnotationTarget): Promise<MarkerInfo | undefined>;
}

export interface QuarantineGithubConfig {
  createIssues: boolean;
  /** "owner/repo"; unset = infer from the git remote 'origin'. */
  repo?: string;
}

export interface QuarantineConfig {
  /** Reserved for future analyze-integrated automation; the subcommand itself is the opt-in. */
  enabled: boolean;
  /** Minimum flakinessScore to quarantine. Unset = mirrors signal.flakinessThreshold. */
  scoreThreshold?: number;
  /** Consecutive clean passes (after quarantine) required to release a test. */
  stableRunsToRelease: number;
  /** Test ids that must never be auto-quarantined. */
  criticalTests: string[];
  framework: 'playwright';
  github: QuarantineGithubConfig;
  /** Where the quarantine state artifact lives. */
  state: string;
}

export const DEFAULT_QUARANTINE_CONFIG: QuarantineConfig = {
  enabled: false,
  stableRunsToRelease: 10,
  criticalTests: [],
  framework: 'playwright',
  github: {
    createIssues: true,
  },
  state: 'flakehound.quarantine.json',
};
