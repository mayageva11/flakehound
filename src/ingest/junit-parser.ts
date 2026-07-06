import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { FlakehoundError } from '../util/errors.js';
import { normalizeTimestamp } from './metadata.js';
import type { RunMetadata, TestRun } from './types.js';

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name) => name === 'testsuite' || name === 'testcase',
});

/**
 * Parse one JUnit XML document into TestRun[].
 *
 * Retries appear as repeated <testcase> entries with the same identity within
 * one file (Playwright retries, jest-retry); each is kept as a separate
 * TestRun — the Signal layer reads mixed statuses per (file, testId) as the
 * intra-run flakiness signal.
 */
export function parseJUnitXml(xml: string, metadata: RunMetadata): TestRun[] {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new FlakehoundError(
      `Invalid XML at line ${validation.err.line}: ${validation.err.msg}`,
    );
  }

  const doc = parser.parse(xml) as XmlNode;
  const rootSuites = collectRootSuites(doc);
  if (rootSuites.length === 0) {
    throw new FlakehoundError('No <testsuites> or <testsuite> root element found');
  }

  const runs: TestRun[] = [];
  for (const suite of rootSuites) {
    walkSuite(suite, [], runs, metadata);
  }
  return runs;
}

function collectRootSuites(doc: XmlNode): XmlNode[] {
  const wrapper = doc['testsuites'];
  if (wrapper !== undefined && typeof wrapper === 'object' && wrapper !== null) {
    return asNodeArray((wrapper as XmlNode)['testsuite']);
  }
  return asNodeArray(doc['testsuite']);
}

function walkSuite(
  suite: XmlNode,
  ancestors: string[],
  runs: TestRun[],
  metadata: RunMetadata,
): void {
  const name = attr(suite, 'name');
  const chain = name !== undefined && name !== '' ? [...ancestors, name] : ancestors;
  const timestamp = resolveSuiteTimestamp(attr(suite, 'timestamp'), metadata);

  for (const testcase of asNodeArray(suite['testcase'])) {
    runs.push(toTestRun(testcase, chain, timestamp, metadata));
  }
  for (const child of asNodeArray(suite['testsuite'])) {
    walkSuite(child, chain, runs, metadata);
  }
}

/**
 * The <testsuite timestamp="..."> attribute is more precise than file mtime,
 * but less authoritative than user-provided metadata — use it only when the
 * resolution chain bottomed out at mtime.
 */
function resolveSuiteTimestamp(suiteTimestamp: string | undefined, metadata: RunMetadata): string {
  if (metadata.source === 'mtime' && suiteTimestamp !== undefined) {
    return normalizeTimestamp(suiteTimestamp) ?? metadata.timestamp;
  }
  return metadata.timestamp;
}

function toTestRun(
  testcase: XmlNode,
  suiteChain: string[],
  timestamp: string,
  metadata: RunMetadata,
): TestRun {
  const fault = extractFault(testcase);
  const status = fault !== undefined ? 'fail' : testcase['skipped'] !== undefined ? 'skip' : 'pass';

  const errorMessage = fault?.message ?? fault?.text?.split('\n')[0]?.trim();
  const stackTrace = fault?.text;

  return {
    testId: buildTestId(testcase, suiteChain),
    status,
    durationMs: parseDurationMs(attr(testcase, 'time')),
    timestamp,
    ...(metadata.commitSha !== undefined ? { commitSha: metadata.commitSha } : {}),
    ...(metadata.runnerId !== undefined ? { runnerId: metadata.runnerId } : {}),
    ...(errorMessage !== undefined && errorMessage !== '' ? { errorMessage } : {}),
    ...(stackTrace !== undefined && stackTrace !== '' ? { stackTrace } : {}),
  };
}

/**
 * testId = suite path + classname (when it adds information) + test name.
 * Deterministic for a given XML shape, so identity is stable across runs.
 */
function buildTestId(testcase: XmlNode, suiteChain: string[]): string {
  const parts = [...suiteChain];
  const classname = attr(testcase, 'classname');
  if (classname !== undefined && classname !== '' && classname !== parts[parts.length - 1]) {
    parts.push(classname);
  }
  parts.push(attr(testcase, 'name') ?? '(unnamed test)');
  return parts.join(' > ');
}

interface Fault {
  message?: string;
  text?: string;
}

function extractFault(testcase: XmlNode): Fault | undefined {
  for (const kind of ['failure', 'error'] as const) {
    const raw = testcase[kind];
    if (raw === undefined) continue;
    const node = Array.isArray(raw) ? raw[0] : raw;
    if (typeof node === 'string') {
      return node === '' ? {} : { text: node };
    }
    if (typeof node === 'object' && node !== null) {
      const n = node as XmlNode;
      const message = str(n['@_message']);
      const text = str(n['#text']);
      return {
        ...(message !== undefined ? { message } : {}),
        ...(text !== undefined ? { text } : {}),
      };
    }
    return {};
  }
  return undefined;
}

function parseDurationMs(time: string | undefined): number {
  if (time === undefined) return 0;
  // Surefire (common in Jenkins ecosystems) can emit locale-formatted times
  // with thousands separators ("1,024.5"). Strip the commas only when the
  // value strictly matches that shape, so nothing else is reinterpreted.
  const normalized = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(time)
    ? time.replaceAll(',', '')
    : time;
  const seconds = Number(normalized);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

function attr(node: XmlNode, name: string): string | undefined {
  return str(node[`@_${name}`]);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNodeArray(value: unknown): XmlNode[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.filter((item): item is XmlNode => typeof item === 'object' && item !== null);
}
