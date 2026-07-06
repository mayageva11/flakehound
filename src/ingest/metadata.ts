import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { FlakehoundError } from '../util/errors.js';
import type { MetadataSource, RunMetadata } from './types.js';

const sidecarSchema = z.object({
  commitSha: z.string().min(1).optional(),
  timestamp: z.string().min(1).optional(),
  runnerId: z.string().min(1).optional(),
});

type Sidecar = z.infer<typeof sidecarSchema>;

// Directory convention: {sha}_{timestamp}, e.g. a1b2c3d_2026-07-01T10-00
const RUN_DIR_RE = /^([0-9a-f]{7,40})_(.+)$/i;

const HAS_TIMEZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse a timestamp string into canonical ISO 8601 UTC.
 * Naive timestamps (no timezone suffix) are interpreted as UTC so results
 * don't depend on the machine's local timezone. Directory-name timestamps
 * may encode colons as hyphens ("T10-00"); both forms are accepted.
 */
export function normalizeTimestamp(raw: string): string | undefined {
  for (const candidate of timestampCandidates(raw.trim())) {
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

function* timestampCandidates(raw: string): Generator<string> {
  const withZone = (s: string) => (HAS_TIMEZONE_RE.test(s) ? s : `${s}Z`);
  yield withZone(raw);
  const tIndex = raw.indexOf('T');
  if (tIndex !== -1) {
    const colonized = raw.slice(0, tIndex) + 'T' + raw.slice(tIndex + 1).replace(/-/g, ':');
    yield withZone(colonized);
  }
}

async function readSidecar(xmlPath: string): Promise<Sidecar | undefined> {
  const sidecarPath = xmlPath.replace(/\.xml$/i, '.meta.json');
  let content: string;
  try {
    content = await readFile(sidecarPath, 'utf8');
  } catch {
    return undefined; // no sidecar — fall through the chain
  }
  // A sidecar that exists but can't be read is a user error, not missing
  // metadata — surface it instead of silently degrading.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new FlakehoundError(`Invalid JSON in metadata sidecar ${sidecarPath}`, { cause });
  }
  const result = sidecarSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path.join('.') || '(root)';
    throw new FlakehoundError(
      `Invalid metadata sidecar ${sidecarPath}: field "${field}" — ${issue?.message ?? 'unknown error'}`,
    );
  }
  return result.data;
}

function parseRunDirName(dirName: string): { commitSha: string; timestamp?: string } | undefined {
  const match = RUN_DIR_RE.exec(dirName);
  if (!match) return undefined;
  const [, commitSha, rawTimestamp] = match;
  if (commitSha === undefined) return undefined;
  const timestamp = rawTimestamp === undefined ? undefined : normalizeTimestamp(rawTimestamp);
  return timestamp === undefined ? { commitSha } : { commitSha, timestamp };
}

/**
 * Resolution chain per XML file (partial metadata is first-class, never an error):
 *   1. sibling sidecar `<name>.meta.json`  → commitSha, timestamp, runnerId
 *   2. parent directory name `{sha}_{timestamp}`
 *   3. file mtime for timestamp; commitSha/runnerId stay undefined
 */
export async function resolveRunMetadata(xmlPath: string): Promise<RunMetadata> {
  const abs = path.resolve(xmlPath);
  const sidecar = await readSidecar(abs);
  const fromDir = parseRunDirName(path.basename(path.dirname(abs)));

  const commitSha = sidecar?.commitSha ?? fromDir?.commitSha;
  const runnerId = sidecar?.runnerId;

  const sidecarTimestamp =
    sidecar?.timestamp === undefined ? undefined : requireValidTimestamp(sidecar.timestamp, abs);
  let timestamp = sidecarTimestamp ?? fromDir?.timestamp;
  if (timestamp === undefined) {
    timestamp = (await stat(abs)).mtime.toISOString();
  }

  const source: MetadataSource = sidecar ? 'sidecar' : fromDir ? 'dirname' : 'mtime';
  return {
    ...(commitSha !== undefined ? { commitSha } : {}),
    ...(runnerId !== undefined ? { runnerId } : {}),
    timestamp,
    source,
  };
}

function requireValidTimestamp(raw: string, xmlPath: string): string {
  const normalized = normalizeTimestamp(raw);
  if (normalized === undefined) {
    throw new FlakehoundError(
      `Unparseable timestamp "${raw}" in metadata sidecar for ${xmlPath}`,
    );
  }
  return normalized;
}
