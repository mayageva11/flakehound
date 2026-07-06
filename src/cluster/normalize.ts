/**
 * Trace normalization — the heart of the clustering engine.
 *
 * GUIDING PRINCIPLE: PREFER FALSE-SPLIT OVER FALSE-MERGE.
 * If two different bugs merge into one cluster, an engineer reading
 * "one cluster = one bug" misses a real defect — the tool fails its mission.
 * If one bug splits into two clusters, the cost is a duplicate resolved by
 * eye. Therefore every rule below strips only tokens that are UNAMBIGUOUSLY
 * volatile (they change between runs of the same bug). Anything that might
 * carry the bug's identity — error class names, function/method names,
 * filenames, the structural shape of the message — is preserved fiercely.
 * When in doubt: normalize less, split more.
 */

export interface NormalizationRule {
  name: string;
  /** Why this token is unambiguously volatile. */
  description: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Applied in order — earlier rules protect later ones (e.g. timestamps are
 * replaced before the line-number rule can mangle "10:00:00", UUIDs before
 * the long-hex rule can eat their segments).
 */
export const NORMALIZATION_RULES: readonly NormalizationRule[] = [
  {
    name: 'iso-timestamp',
    description: 'Wall-clock timestamps differ on every run.',
    pattern:
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    replacement: '<TIMESTAMP>',
  },
  {
    name: 'uuid',
    description: 'Generated identifiers differ on every run.',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: '<UUID>',
  },
  {
    name: 'hex-address',
    description: 'Memory addresses differ on every process.',
    pattern: /\b0x[0-9a-f]+\b/gi,
    replacement: '<ADDR>',
  },
  {
    name: 'long-hex',
    description:
      'Long hex tokens (git SHAs, content hashes) differ per build. Requires ≥8 chars and at least one digit so ordinary words are never matched.',
    pattern: /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi,
    replacement: '<HASH>',
  },
  {
    name: 'duration',
    description: 'Elapsed times differ on every run (1234ms, 4.1s, 2 min).',
    pattern: /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m|min|mins|minutes|h)\b/gi,
    replacement: '<DURATION>',
  },
  {
    name: 'path-prefix',
    description:
      'Absolute directory prefixes differ per machine/checkout. The tail FILENAME is kept — it is part of the bug identity.',
    pattern: /(?:[A-Za-z]:)?(?:[\\/][\w.@+~-]+)+[\\/](?=[\w.@+~-]+)/g,
    replacement: '',
  },
  {
    name: 'line-col',
    description:
      'Line/column suffixes (:123:45) shift with every unrelated edit above them. The ":<N>" placeholder keeps the frame shape.',
    pattern: /:\d+/g,
    replacement: ':<N>',
  },
  {
    name: 'prose-line-number',
    description:
      'Prose-form line references ("line 123", Python tracebacks) shift with every unrelated edit — same volatility as the :123 form in rule line-col. Deliberately narrow: OTHER standalone numbers (HTTP status codes, assertion values, ports) are identity, not noise — stripping them would collapse a 500-error trace and a 403-error trace into one cluster, a false merge the guiding principle forbids.',
    pattern: /\bline \d+\b/gi,
    replacement: 'line <N>',
  },
];

const PLACEHOLDERS = new Set([
  '<TIMESTAMP>',
  '<UUID>',
  '<ADDR>',
  '<HASH>',
  '<DURATION>',
  '<N>',
]);

export interface NormalizedTrace {
  /** Canonical string: structurally identical failures are byte-identical. */
  canonical: string;
  /**
   * Token set for the similarity metric. Placeholder tokens are EXCLUDED:
   * they mark volatility, not identity — two unrelated traces both
   * containing <N> and <DURATION> must not look more similar for it
   * (that would push toward false merges).
   */
  tokens: ReadonlySet<string>;
}

export function normalizeTrace(raw: string): NormalizedTrace {
  let canonical = raw;
  for (const rule of NORMALIZATION_RULES) {
    canonical = canonical.replace(rule.pattern, rule.replacement);
  }
  canonical = canonical.replace(/\s+/g, ' ').trim();

  const tokens = new Set<string>();
  for (const word of canonical.split(' ')) {
    const token = trimPunctuation(word);
    if (token !== '' && !PLACEHOLDERS.has(token)) tokens.add(token);
  }
  return { canonical, tokens };
}

/**
 * Trim non-identifier punctuation from token edges only ("(login.test.ts)" →
 * "login.test.ts", "Error:" → "Error") while keeping interior structure and
 * angle brackets ("Object.<anonymous>" survives intact).
 */
function trimPunctuation(word: string): string {
  return word.replace(/^[^\w<$#]+/, '').replace(/[^\w>$.]+$/, '');
}
