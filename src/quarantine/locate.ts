import { existsSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'tinyglobby';
import type { AnnotationTarget } from './types.js';

/**
 * The report has no source-location field: the spec file path lives only in
 * the testId's first ' > ' segment (Playwright puts the file path in the JUnit
 * suite name). Everything here fails safe — a segment we can't resolve to
 * exactly one file means the candidate is skipped, never a guessed edit.
 */

const SPEC_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export type LocateResult =
  | { status: 'found'; target: AnnotationTarget }
  | { status: 'not-found'; detail: string }
  | { status: 'ambiguous'; detail: string };

/** Split a testId into its file segment, describe chain, and test title. */
export function parseTestId(
  testId: string,
): { fileSegment: string; describePath: string[]; testTitle: string } | undefined {
  const parts = testId.split(' > ');
  if (parts.length < 2) return undefined;
  const fileSegment = parts[0]!.replaceAll('\\', '/');
  return {
    fileSegment,
    describePath: parts.slice(1, -1),
    testTitle: parts[parts.length - 1]!,
  };
}

export async function resolveSpecFile(testId: string, cwd: string): Promise<LocateResult> {
  const parsed = parseTestId(testId);
  if (parsed === undefined) {
    return { status: 'not-found', detail: `testId '${testId}' has no ' > ' separator` };
  }
  const { fileSegment, describePath, testTitle } = parsed;

  if (!SPEC_EXTENSION.test(fileSegment)) {
    return {
      status: 'not-found',
      detail: `testId segment '${fileSegment}' is not a source file path (only Playwright-style suite names are supported)`,
    };
  }

  const target = (filePath: string): AnnotationTarget => ({
    testId,
    filePath,
    testTitle,
    describePath,
  });

  const direct = path.resolve(cwd, fileSegment);
  if (existsSync(direct)) return { status: 'found', target: target(direct) };

  // The suite path is relative to Playwright's testDir, not necessarily the
  // repo root — fall back to searching for the file anywhere in the project.
  const matches = await glob(`**/${path.posix.basename(fileSegment)}`, {
    cwd,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**'],
  });
  const sorted = [...matches].sort();

  if (sorted.length === 1) return { status: 'found', target: target(sorted[0]!) };
  if (sorted.length === 0) {
    return { status: 'not-found', detail: `no file matching '${fileSegment}' under ${cwd}` };
  }

  // Several files share the basename — accept only an unambiguous full-segment match.
  const endsWithSegment = sorted.filter((file) =>
    file.replaceAll('\\', '/').endsWith(`/${fileSegment}`),
  );
  if (endsWithSegment.length === 1) return { status: 'found', target: target(endsWithSegment[0]!) };

  return {
    status: 'ambiguous',
    detail: `'${fileSegment}' matches ${sorted.length} files: ${sorted.join(', ')}`,
  };
}
