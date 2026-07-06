import { describe, expect, it } from 'vitest';
import { NORMALIZATION_RULES, normalizeTrace } from '../src/cluster/normalize.js';

describe('normalizeTrace — volatile tokens', () => {
  it('same bug, different line numbers → identical normalized string', () => {
    const a = normalizeTrace(
      'Error: expect(received).toBe(expected)\n    at Object.<anonymous> (/home/ci/repo/src/auth/login.test.ts:42:19)',
    );
    const b = normalizeTrace(
      'Error: expect(received).toBe(expected)\n    at Object.<anonymous> (/home/ci/repo/src/auth/login.test.ts:57:3)',
    );
    expect(a.canonical).toBe(b.canonical);
  });

  it('same bug, different memory addresses / UUIDs / hashes → identical normalized string', () => {
    const a = normalizeTrace(
      'Segfault at 0x7f3a91bc2000 in worker 550e8400-e29b-41d4-a716-446655440000 (build deadbeef42cafe99)',
    );
    const b = normalizeTrace(
      'Segfault at 0x559b22aa0010 in worker 123e4567-e89b-42d3-a456-426614174000 (build 0badc0ffee123456)',
    );
    expect(a.canonical).toBe(b.canonical);
    expect(a.canonical).toContain('<ADDR>');
    expect(a.canonical).toContain('<UUID>');
    expect(a.canonical).toContain('<HASH>');
  });

  it('same bug, different absolute paths → identical, and the tail filename SURVIVES', () => {
    const a = normalizeTrace('TimeoutError at /home/ci/repo/e2e/checkout.spec.ts:88:41');
    const b = normalizeTrace('TimeoutError at /Users/dev/work/e2e/checkout.spec.ts:12:5');
    expect(a.canonical).toBe(b.canonical);
    expect(a.canonical).toContain('checkout.spec.ts');
    expect(a.canonical).not.toContain('/home/ci');
    expect(a.canonical).not.toContain('repo');
  });

  it('strips Windows-style path prefixes too', () => {
    const a = normalizeTrace('Error in C:\\Users\\dev\\proj\\utils.spec.ts:10:2');
    expect(a.canonical).toContain('utils.spec.ts');
    expect(a.canonical).not.toContain('C:\\');
  });

  it('same bug, different durations and timestamps → identical normalized string', () => {
    const a = normalizeTrace('Request timed out after 30000ms at 2026-07-01T10:00:00.000Z');
    const b = normalizeTrace('Request timed out after 45.5s at 2026-07-03T22:15:09Z');
    expect(a.canonical).toBe(b.canonical);
    expect(a.canonical).toContain('<DURATION>');
    expect(a.canonical).toContain('<TIMESTAMP>');
  });

  it('strips prose-form line numbers (Python tracebacks)', () => {
    const a = normalizeTrace('File "test_api.py", line 77, in test_db_connection');
    const b = normalizeTrace('File "test_api.py", line 91, in test_db_connection');
    expect(a.canonical).toBe(b.canonical);
    expect(a.canonical).toContain('line <N>');
  });

  it('collapses whitespace deterministically', () => {
    const a = normalizeTrace('Error:   boom\n\n\t  at   run()');
    expect(a.canonical).toBe('Error: boom at run()');
  });
});

describe('normalizeTrace — identity is preserved fiercely', () => {
  it('different error classes → different normalized strings', () => {
    const a = normalizeTrace('TimeoutError: operation aborted');
    const b = normalizeTrace('AssertionError: operation aborted');
    expect(a.canonical).not.toBe(b.canonical);
    expect(a.canonical).toContain('TimeoutError');
    expect(b.canonical).toContain('AssertionError');
  });

  it('function and method names survive, including Object.<anonymous>', () => {
    const a = normalizeTrace(
      'at CheckoutPage.pay (/repo/e2e/pages/checkout-page.ts:88:41)\nat Object.<anonymous> (/repo/e2e/checkout.spec.ts:12:3)',
    );
    expect(a.canonical).toContain('CheckoutPage.pay');
    expect(a.canonical).toContain('Object.<anonymous>');
    expect(a.canonical).toContain('checkout-page.ts');
    expect(a.canonical).toContain('checkout.spec.ts');
  });

  it('ordinary words are never eaten by the hex rule', () => {
    const a = normalizeTrace('database access declined for cafeteria beefeater');
    expect(a.canonical).toBe('database access declined for cafeteria beefeater');
  });

  it('HTTP status codes and assertion values are identity — different values → different canonicals', () => {
    const serverError = normalizeTrace('AssertionError: expected 200 but got 500');
    const forbidden = normalizeTrace('AssertionError: expected 200 but got 403');
    expect(serverError.canonical).not.toBe(forbidden.canonical);
    expect(serverError.canonical).toBe('AssertionError: expected 200 but got 500');
    expect(serverError.tokens.has('500')).toBe(true);
  });

  it('numbers embedded in identifiers survive (utf8, base64, sha256, oauth2)', () => {
    const a = normalizeTrace('Error: invalid utf8 in base64 payload during oauth2 sha256 check');
    expect(a.canonical).toBe('Error: invalid utf8 in base64 payload during oauth2 sha256 check');
    expect(a.tokens.has('base64')).toBe(true);
    expect(a.tokens.has('sha256')).toBe(true);
  });
});

describe('normalizeTrace — token set', () => {
  it('excludes placeholder tokens but keeps identity tokens', () => {
    const { tokens } = normalizeTrace(
      'TimeoutError: Timeout 30000ms exceeded at /repo/e2e/checkout.spec.ts:88:41',
    );
    expect(tokens.has('TimeoutError')).toBe(true);
    expect(tokens.has('exceeded')).toBe(true);
    expect(tokens.has('<DURATION>')).toBe(false);
    expect(tokens.has('<N>')).toBe(false);
  });

  it('trims edge punctuation without destroying interior structure', () => {
    const { tokens } = normalizeTrace('Error: (in "setup") Object.<anonymous> failed');
    expect(tokens.has('Error')).toBe(true);
    expect(tokens.has('in')).toBe(true);
    expect(tokens.has('setup')).toBe(true);
    expect(tokens.has('Object.<anonymous>')).toBe(true);
  });
});

describe('NORMALIZATION_RULES table', () => {
  it('is exported, documented, and ordered so earlier rules protect later ones', () => {
    const names = NORMALIZATION_RULES.map((r) => r.name);
    expect(names).toEqual([
      'iso-timestamp',
      'uuid',
      'hex-address',
      'long-hex',
      'duration',
      'path-prefix',
      'line-col',
      'prose-line-number',
    ]);
    // timestamps must be consumed before line-col can mangle "10:00:00"
    expect(names.indexOf('iso-timestamp')).toBeLessThan(names.indexOf('line-col'));
    // uuid segments must be consumed before long-hex eats them piecemeal
    expect(names.indexOf('uuid')).toBeLessThan(names.indexOf('long-hex'));
    for (const rule of NORMALIZATION_RULES) {
      expect(rule.description.length).toBeGreaterThan(10);
    }
  });
});
