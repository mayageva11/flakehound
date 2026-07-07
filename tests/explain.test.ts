import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runExplain } from '../src/explain.js';
import { FlakehoundError } from '../src/util/errors.js';

const e2eDir = fileURLToPath(new URL('./fixtures/e2e', import.meta.url));
const fixedNow = () => new Date('2026-07-05T00:00:00.000Z');

async function explain(testId: string): Promise<string> {
  const logs: string[] = [];
  await runExplain({
    testId,
    cwd: e2eDir,
    overrides: { input: '*/junit.xml' },
    now: fixedNow,
    log: (m) => logs.push(m),
  });
  return logs.join('\n');
}

describe('flakehound explain', () => {
  it('tells the flaky story: classification, run-by-run history, cluster', async () => {
    const out = await explain('shop.spec.ts > checkout');
    expect(out).toContain('shop.spec.ts > checkout');
    expect(out).toContain('flaky');
    expect(out).toContain('medium confidence');
    expect(out).toContain('Run history (4 execution(s)');
    // chronological verdict sequence pass/fail/pass/fail, with commits
    expect(out).toContain('aaa1111');
    expect(out).toContain('bbb2222');
    expect(out).toContain('ccc3333');
    // the timeout cluster this test belongs to
    expect(out).toContain('Failure clusters containing this test (1)');
    expect(out).toContain('TimeoutError');
  });

  it('tells the regression story with the breaking commit', async () => {
    const out = await explain('shop.spec.ts > payment');
    expect(out).toContain('regression — broken since bbb2222');
    expect(out).toContain('AssertionError');
  });

  it('a stable test shows history and no clusters', async () => {
    const out = await explain('shop.spec.ts > login');
    expect(out).toContain('stable');
    expect(out).toContain('Failure clusters containing this test (0)');
  });

  it('unknown test id → FlakehoundError with suggestions', async () => {
    await expect(explain('checkout')).rejects.toThrowError(FlakehoundError);
    await expect(explain('checkout')).rejects.toThrowError(/Did you mean.*shop\.spec\.ts > checkout/);
  });
});
