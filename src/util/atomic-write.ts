import { randomBytes } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';

/**
 * Write a file atomically: write a sibling temp file, then rename it onto the
 * target. `rename` is atomic on the same filesystem, so a concurrent reader
 * always sees either the old file or the complete new one — never a truncated,
 * half-written file. This matters in CI, where multiple flakehound processes may
 * touch the same report/state paths and a torn read would either crash a load
 * (quarantine state) or silently fail-safe (baseline).
 *
 * The temp name carries the pid and random bytes so two writers never collide on
 * the same temp path. If `rename` fails across a device boundary (EXDEV — e.g. a
 * bind-mounted output dir), fall back to a direct write.
 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EXDEV') {
      await writeFile(filePath, data, 'utf8');
    }
    // Best-effort cleanup: a leftover temp file must never mask the real error.
    await unlink(tmp).catch(() => {});
    if ((cause as NodeJS.ErrnoException).code !== 'EXDEV') throw cause;
  }
}
