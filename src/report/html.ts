import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../util/atomic-write.js';
import { FlakehoundError } from '../util/errors.js';
import type { FlakehoundReport } from './types.js';

/**
 * Self-contained HTML report: the dashboard template with the report baked in
 * as window.FHREPORT. The emitted file needs no server and no sibling JSON —
 * it renders from file://, an email attachment, or a CI artifact download —
 * while a live flakehound.quarantine.json served next to it still overrides
 * the embedded quarantine snapshot (see the loader in the template).
 */
export interface HtmlReportData {
  report: FlakehoundReport;
  /** Parsed quarantine state file, embedded as a fallback snapshot. */
  quarantine?: unknown;
  /** Dashboard settings, embedded as window.FHCONFIG (e.g. stableRuns). */
  dashboard?: Record<string, unknown>;
}

/**
 * Template resolution, first hit wins:
 *   dist/report/html.js → ../dashboard.html   (the published package: build
 *                                              copies docs/index.html there)
 *   src/report/html.ts  → ../../docs/index.html  (dev checkout and tests)
 */
const TEMPLATE_CANDIDATES = ['../dashboard.html', '../../docs/index.html'] as const;

async function loadTemplate(): Promise<string> {
  for (const candidate of TEMPLATE_CANDIDATES) {
    try {
      return await readFile(new URL(candidate, import.meta.url), 'utf8');
    } catch {
      // fall through to the next candidate
    }
  }
  throw new FlakehoundError(
    'dashboard template not found next to the flakehound package — reinstall flakehound (the package should contain dist/dashboard.html)',
  );
}

/** `</script>` inside embedded JSON would terminate the script block early. */
const embed = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c');

export function injectReport(template: string, data: HtmlReportData): string {
  if (!template.includes('<head>')) {
    throw new FlakehoundError('dashboard template is malformed: no <head> to inject into');
  }
  const lines = ['<script>'];
  if (data.dashboard !== undefined) lines.push(`window.FHCONFIG = ${embed(data.dashboard)};`);
  lines.push(`window.FHREPORT = ${embed(data.report)};`);
  if (data.quarantine !== undefined) lines.push(`window.FHQUARANTINE = ${embed(data.quarantine)};`);
  lines.push('</script>');
  const block = ['<head>', '<!-- flakehound-embedded-report -->', ...lines].join('\n');
  return template.replace('<head>', block);
}

export async function writeHtmlReport(filePath: string, data: HtmlReportData): Promise<void> {
  const template = await loadTemplate();
  await writeFileAtomic(filePath, injectReport(template, data));
}
