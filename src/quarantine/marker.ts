import type { MarkerInfo } from './types.js';

/**
 * The machine-readable marker comment placed above every quarantined test —
 * the single source of truth for its format. `cluster=none` / `issue=pending`
 * encode "unknown yet" so the line shape is constant and parseable either way.
 */
const MARKER_LEAD = '// flakehound-quarantined';

const MARKER_PATTERN =
  /^\/\/ flakehound-quarantined cluster=(?<cluster>\S+) issue=(?<issue>\S+) — managed by 'flakehound quarantine', do not edit$/;

export function buildMarkerComment(info: MarkerInfo): string {
  const cluster = info.clusterId ?? 'none';
  const issue = info.issueUrl ?? 'pending';
  return `${MARKER_LEAD} cluster=${cluster} issue=${issue} — managed by 'flakehound quarantine', do not edit`;
}

/** Parse a marker line (leading/trailing whitespace tolerated). Non-markers → undefined. */
export function parseMarkerComment(line: string): MarkerInfo | undefined {
  const match = MARKER_PATTERN.exec(line.trim());
  const cluster = match?.groups?.['cluster'];
  const issue = match?.groups?.['issue'];
  if (cluster === undefined || issue === undefined) return undefined;
  return {
    ...(cluster !== 'none' ? { clusterId: cluster } : {}),
    ...(issue !== 'pending' ? { issueUrl: issue } : {}),
  };
}

export function isMarkerComment(line: string): boolean {
  return line.trim().startsWith(MARKER_LEAD);
}
