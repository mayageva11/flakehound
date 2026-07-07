export type Classification =
  | 'flaky'
  | 'regression'
  | 'stable'
  | 'insufficient-data'
  | 'insufficient-metadata';

export type Confidence = 'high' | 'medium' | 'low';

/** One execution in a test's chronological run history, as published in the report. */
export interface HistoryEntry {
  timestamp: string;
  commitSha?: string;
  verdict: 'pass' | 'fail' | 'skip';
  /** Intra-run pass↔fail flips (>0 marks a retry flip — the strongest flaky signal). */
  retryFlips: number;
}

export interface TestSignal {
  testId: string;
  /** Weighted transitions / opportunities, capped at 1. Not a naive fail rate. */
  flakinessScore: number;
  classification: Classification;
  confidence: Confidence;
  reason?: string;
  /** Set only when classification is 'regression'. */
  brokenSinceSha?: string;
  /**
   * Chronological per-run history inside the analysis window — the evidence
   * behind the classification, so reports and dashboards can SHOW the flips
   * rather than just assert them.
   */
  history: HistoryEntry[];
}

export interface SignalConfig {
  /** Weight of an intra-run retry flip (fail↔pass within one CI run). */
  retryFlipWeight: number;
  /** Weight of a cross-run pass↔fail transition on the same commitSha. */
  crossRunFlipWeight: number;
  /** Score at or above which a test is classified flaky. */
  flakinessThreshold: number;
  /** Minimum scorable (non-skip) executions required to classify at all. */
  minRuns: number;
  /** Minimum trailing all-fail executions required to call a regression. */
  minRegressionStreak: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  retryFlipWeight: 2,
  crossRunFlipWeight: 1,
  flakinessThreshold: 0.2,
  minRuns: 3,
  minRegressionStreak: 2,
};
