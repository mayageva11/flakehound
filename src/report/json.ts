import { writeFileAtomic } from '../util/atomic-write.js';
import type { InterpretedCluster } from '../ai/types.js';
import type { TestSignal } from '../signal/types.js';
import type { FlakehoundReport, GateResult, ReportSummary } from './types.js';

export function buildReport(parts: {
  generatedAt: string;
  summary: ReportSummary;
  signals: TestSignal[];
  clusters: InterpretedCluster[];
  gate: GateResult;
}): FlakehoundReport {
  // Literal construction fixes the key order — reports are byte-stable.
  return {
    version: 1,
    generatedAt: parts.generatedAt,
    summary: parts.summary,
    signals: parts.signals,
    clusters: parts.clusters,
    gate: parts.gate,
  };
}

export async function writeReport(filePath: string, report: FlakehoundReport): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(report, null, 2)}\n`);
}
