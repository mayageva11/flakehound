import { readFileSync } from 'node:fs';

/**
 * Read at runtime from package.json so --version can never drift from the
 * published version. Resolves from both src/ (tests) and dist/ (production):
 * either way, ../package.json is the package root.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export { defineConfig } from './config/define-config.js';
export { CONFIG_FILES, findConfigFile, loadConfig } from './config/load.js';
export type { CliOverrides } from './config/load.js';
export { runInit } from './init.js';
export type { RunInitOptions } from './init.js';
export type { FlakehoundConfig, FlakehoundUserConfig } from './config/schema.js';
export { runAnalyze, applyHistoryWindow } from './run.js';
export type { RunAnalyzeOptions, RunAnalyzeResult } from './run.js';
export { runExplain } from './explain.js';
export type { RunExplainOptions } from './explain.js';
export {
  buildReport,
  diffAgainstBaseline,
  loadBaseline,
  renderReport,
  writeReport,
} from './report/index.js';
export type { FlakehoundReport, GateResult, ReportSummary } from './report/index.js';

export { ingest, discoverXmlFiles, parseJUnitXml, resolveRunMetadata } from './ingest/index.js';
export type {
  IngestResult,
  IngestSummary,
  MetadataSource,
  RunMetadata,
  TestRun,
  TestStatus,
} from './ingest/types.js';
export { DEFAULT_AI_CONFIG, HYPOTHESIS_CATEGORIES, interpretClusters } from './ai/index.js';
export type {
  AiConfig,
  ClusterHypothesis,
  HypothesisCategory,
  HypothesisClient,
  InterpretedCluster,
  InterpretOptions,
} from './ai/index.js';
export {
  clusterFailures,
  clusterTestRuns,
  DEFAULT_CLUSTER_CONFIG,
  JaccardSimilarity,
  NORMALIZATION_RULES,
  normalizeTrace,
} from './cluster/index.js';
export type {
  ClusterConfig,
  FailureCluster,
  FailureOccurrence,
  NormalizationRule,
  NormalizedTrace,
  SimilarityMetric,
  TokenSet,
} from './cluster/index.js';
export { computeSignals, DEFAULT_SIGNAL_CONFIG } from './signal/index.js';
export type {
  Classification,
  Confidence,
  HistoryEntry,
  SignalConfig,
  TestSignal,
} from './signal/types.js';
export { FlakehoundError } from './util/errors.js';
