import { readFile } from 'node:fs/promises';
import { FlakehoundError } from '../util/errors.js';
import { discoverXmlFiles } from './discover.js';
import { parseJUnitXml } from './junit-parser.js';
import { resolveRunMetadata } from './metadata.js';
import type { IngestResult, TestRun } from './types.js';

export { discoverXmlFiles } from './discover.js';
export { normalizeTimestamp, resolveRunMetadata } from './metadata.js';
export { parseJUnitXml } from './junit-parser.js';
export type * from './types.js';

export async function ingest(
  patterns: string | string[],
  cwd: string = process.cwd(),
): Promise<IngestResult> {
  const files = await discoverXmlFiles(patterns, cwd);
  const runs: TestRun[] = [];
  const metadataSources = { sidecar: 0, dirname: 0, mtime: 0 };

  for (const file of files) {
    const metadata = await resolveRunMetadata(file);
    metadataSources[metadata.source] += 1;
    const content = await readFile(file, 'utf8');
    try {
      runs.push(...parseJUnitXml(content, metadata).map((run) => ({ ...run, runId: file })));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new FlakehoundError(`Failed to parse JUnit XML ${file}: ${detail}`, { cause });
    }
  }

  return {
    runs,
    summary: { filesParsed: files.length, testRuns: runs.length, metadataSources },
  };
}
