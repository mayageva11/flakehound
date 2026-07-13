import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { injectReport, writeHtmlReport } from '../src/report/html.js';
import type { FlakehoundReport } from '../src/report/types.js';
import { runAnalyze } from '../src/run.js';

const report: FlakehoundReport = {
  version: 1,
  generatedAt: '2026-07-13T00:00:00.000Z',
  summary: {
    filesParsed: 1,
    testRuns: 1,
    testsAnalyzed: 1,
    metadataSources: { sidecar: 0, dirname: 0, mtime: 1 },
  },
  signals: [],
  clusters: [],
  gate: {
    baselineUsed: false,
    newRegressions: [],
    knownRegressions: [],
    resolvedRegressions: [],
    newClusters: [],
    knownClusters: [],
  },
};

describe('injectReport', () => {
  const template = '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n</html>';

  it('embeds the report as window.FHREPORT after <head>', () => {
    const html = injectReport(template, { report });
    expect(html).toContain('<!-- flakehound-embedded-report -->');
    expect(html).toContain(`window.FHREPORT = ${JSON.stringify(report)};`);
    expect(html.indexOf('window.FHREPORT')).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf('window.FHREPORT')).toBeLessThan(html.indexOf('<meta charset'));
  });

  it('embeds quarantine and dashboard config only when provided', () => {
    const bare = injectReport(template, { report });
    expect(bare).not.toContain('window.FHQUARANTINE');
    expect(bare).not.toContain('window.FHCONFIG');

    const full = injectReport(template, {
      report,
      quarantine: { quarantined: [] },
      dashboard: { stableRuns: 5, mode: 'demo' },
    });
    expect(full).toContain('window.FHQUARANTINE = {"quarantined":[]};');
    expect(full).toContain('window.FHCONFIG = {"stableRuns":5,"mode":"demo"};');
  });

  it('escapes </script> sequences inside embedded JSON', () => {
    const hostile: FlakehoundReport = {
      ...report,
      signals: [
        {
          testId: 'a.spec.ts > breaks with </script> in a trace',
          classification: 'stable',
          confidence: 'high',
          flakinessScore: 0,
          reason: '</script><script>alert(1)</script>',
          history: [],
        } as unknown as FlakehoundReport['signals'][number],
      ],
    };
    const html = injectReport(template, { report: hostile });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it('rejects a template without <head>', () => {
    expect(() => injectReport('<html></html>', { report })).toThrow(/no <head>/);
  });
});

describe('writeHtmlReport', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'flakehound-html-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the real dashboard template with the report embedded', async () => {
    const out = path.join(dir, 'report.html');
    await writeHtmlReport(out, { report });
    const html = await readFile(out, 'utf8');
    expect(html).toContain('window.FHREPORT');
    // The loader added for embedded mode must be present in the template.
    expect(html).toContain('if (window.FHREPORT)');
  });
});

describe('runAnalyze with html output', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'flakehound-analyze-html-'));
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="a.spec.ts" tests="1" failures="0" time="1">
    <testcase name="passes" classname="a.spec.ts" time="1"/>
  </testsuite>
</testsuites>
`;
    await writeFile(path.join(dir, 'junit.xml'), xml, 'utf8');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('emits the self-contained HTML next to the JSON when html.output is set', async () => {
    await runAnalyze({
      cwd: dir,
      overrides: { input: 'junit.xml', ai: false, html: 'report.html' },
      log: () => {},
      warn: () => {},
    });
    const html = await readFile(path.join(dir, 'report.html'), 'utf8');
    expect(html).toContain('window.FHREPORT');
    // stableRuns rides along from quarantine.stableRunsToRelease (default 10).
    expect(html).toContain('window.FHCONFIG = {"stableRuns":10};');
    const embedded = /window\.FHREPORT = (.*);/.exec(html);
    expect(embedded).not.toBeNull();
    const parsed = JSON.parse(embedded![1]!) as FlakehoundReport;
    expect(parsed.summary.testsAnalyzed).toBe(1);
  });

  it('does not emit HTML when html output is not configured', async () => {
    await runAnalyze({
      cwd: dir,
      overrides: { input: 'junit.xml', ai: false },
      log: () => {},
      warn: () => {},
    });
    await expect(readFile(path.join(dir, 'flakehound.report.html'), 'utf8')).rejects.toThrow();
  });
});
