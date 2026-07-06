export type TestStatus = 'pass' | 'fail' | 'skip';

export interface TestRun {
  /** Suite path + test name, stable across runs. */
  testId: string;
  /**
   * Identifies the CI run (source XML file) this entry came from; set by
   * ingest(). Lets the Signal layer detect intra-run retries (same testId,
   * same runId, mixed statuses).
   */
  runId?: string;
  status: TestStatus;
  durationMs: number;
  /** ISO 8601. Naive timestamps (no timezone) are interpreted as UTC. */
  timestamp: string;
  commitSha?: string;
  /** CI runner / OS. */
  runnerId?: string;
  errorMessage?: string;
  stackTrace?: string;
}

export type MetadataSource = 'sidecar' | 'dirname' | 'mtime';

export interface RunMetadata {
  commitSha?: string;
  timestamp: string;
  runnerId?: string;
  /** Which step of the resolution chain provided this metadata. */
  source: MetadataSource;
}

export interface IngestSummary {
  filesParsed: number;
  testRuns: number;
  metadataSources: Record<MetadataSource, number>;
}

export interface IngestResult {
  runs: TestRun[];
  summary: IngestSummary;
}
