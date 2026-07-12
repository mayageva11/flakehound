import pc from 'picocolors';
import type { Confidence } from '../signal/types.js';

export interface QuarantinePlanItem {
  testId: string;
  file: string;
  flakinessScore: number;
  confidence: Confidence;
  clusterId?: string;
  issueUrl?: string;
}

export interface ReleasePlanItem {
  testId: string;
  file: string;
  issueUrl?: string;
}

export interface QuarantinePlan {
  quarantine: QuarantinePlanItem[];
  release: ReleasePlanItem[];
  skipped: { testId: string; reason: string }[];
}

export function renderQuarantinePlan(plan: QuarantinePlan, opts: { dryRun: boolean }): string {
  const lines: string[] = [];

  lines.push(pc.bold(pc.yellow(`Quarantine (${plan.quarantine.length})`)));
  if (plan.quarantine.length === 0) lines.push(pc.dim('  none'));
  for (const item of plan.quarantine) {
    lines.push(
      `  ${pc.yellow('⊘')} ${item.testId} — score ${item.flakinessScore.toFixed(2)} (${item.confidence} confidence)`,
    );
    const details = [
      `${item.file}`,
      ...(item.clusterId !== undefined ? [`cluster ${item.clusterId}`] : []),
      ...(item.issueUrl !== undefined ? [item.issueUrl] : []),
    ];
    lines.push(pc.dim(`      ${details.join(' · ')}`));
  }

  lines.push('', pc.bold(pc.green(`Release (${plan.release.length})`)));
  if (plan.release.length === 0) lines.push(pc.dim('  none'));
  for (const item of plan.release) {
    lines.push(`  ${pc.green('✓')} ${item.testId} — stable again`);
    const details = [item.file, ...(item.issueUrl !== undefined ? [`closes ${item.issueUrl}`] : [])];
    lines.push(pc.dim(`      ${details.join(' · ')}`));
  }

  if (plan.skipped.length > 0) {
    lines.push('', pc.bold(`Skipped (${plan.skipped.length})`));
    for (const item of plan.skipped) {
      lines.push(`  ? ${item.testId}`);
      lines.push(pc.dim(`      ${item.reason}`));
    }
  }

  lines.push(
    '',
    opts.dryRun
      ? pc.bold(
          'dry-run: no files touched — re-run with --apply to edit, --commit to branch+commit, or --pr to open a PR',
        )
      : pc.bold(`${plan.quarantine.length} quarantined, ${plan.release.length} released`),
  );
  return lines.join('\n');
}
