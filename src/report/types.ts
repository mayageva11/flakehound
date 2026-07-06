import type { InterpretedCluster } from '../ai/types.js';
import type { MetadataSource } from '../ingest/types.js';
import type { TestSignal } from '../signal/types.js';

export interface GateResult {
  /** false = no usable baseline → fail-safe: every regression counts as new. */
  baselineUsed: boolean;
  /** Regressions absent from the baseline → exit 1. */
  newRegressions: string[];
  /** Regressions already in the baseline — reported, but don't re-fail the gate. */
  knownRegressions: string[];
  /** In the baseline but no longer regressing — surfaced as good news. */
  resolvedRegressions: string[];
}

export interface ReportSummary {
  filesParsed: number;
  testRuns: number;
  testsAnalyzed: number;
  metadataSources: Record<MetadataSource, number>;
}

/** The flakehound.report.json artifact — also consumable as a future baseline. */
export interface FlakehoundReport {
  version: 1;
  generatedAt: string;
  summary: ReportSummary;
  signals: TestSignal[];
  clusters: InterpretedCluster[];
  gate: GateResult;
}
