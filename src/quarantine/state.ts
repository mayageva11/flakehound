import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from '../util/atomic-write.js';
import { FlakehoundError } from '../util/errors.js';
import type { QuarantineState } from './types.js';

const stateSchema = z.object({
  version: z.literal(1),
  quarantined: z.array(
    z.object({
      testId: z.string().min(1),
      file: z.string().min(1),
      quarantinedAt: z.string().min(1),
      flakinessScore: z.number().min(0).max(1),
      confidence: z.enum(['high', 'medium', 'low']),
      clusterId: z.string().min(1).optional(),
      issue: z
        .object({
          number: z.number().int().positive(),
          url: z.string().min(1),
        })
        .optional(),
    }),
  ),
});

export const EMPTY_STATE: QuarantineState = { version: 1, quarantined: [] };

/**
 * Missing file → empty state (first run). Corrupt or off-schema → loud
 * FlakehoundError: unlike the baseline (where fail-safe means "assume worst"),
 * silently ignoring a broken state file would re-quarantine tests and file
 * duplicate GitHub issues — failing is the safe direction here.
 */
export async function loadState(filePath: string): Promise<QuarantineState> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_STATE, quarantined: [] };
    throw new FlakehoundError(`cannot read quarantine state ${filePath}`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new FlakehoundError(
      `invalid JSON in quarantine state ${filePath} — fix or delete it (deleting may re-quarantine tests and duplicate issues)`,
      { cause },
    );
  }

  const result = stateSchema.safeParse(parsed);
  if (!result.success) {
    throw new FlakehoundError(
      `quarantine state ${filePath} does not match the expected schema — fix or delete it (deleting may re-quarantine tests and duplicate issues)`,
    );
  }
  return result.data;
}

/** Byte-stable output: fixed key order, entries sorted by testId, 2-space JSON + trailing newline. */
export async function writeState(filePath: string, state: QuarantineState): Promise<void> {
  const sorted: QuarantineState = {
    version: 1,
    quarantined: [...state.quarantined].sort((a, b) => (a.testId < b.testId ? -1 : 1)),
  };
  await writeFileAtomic(filePath, `${JSON.stringify(sorted, null, 2)}\n`);
}
