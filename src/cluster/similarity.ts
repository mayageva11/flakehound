export type TokenSet = ReadonlySet<string>;

/**
 * Pairwise similarity between normalized traces, in [0, 1].
 * Kept behind an interface so a smarter metric (e.g. embedding-based)
 * can be swapped in later without touching the clustering algorithm.
 */
export interface SimilarityMetric {
  compare(a: TokenSet, b: TokenSet): number;
}

/** Token-based Jaccard similarity: |A ∩ B| / |A ∪ B|. */
export class JaccardSimilarity implements SimilarityMetric {
  compare(a: TokenSet, b: TokenSet): number {
    if (a.size === 0 && b.size === 0) return 1; // both empty ⇒ identical
    if (a.size === 0 || b.size === 0) return 0;

    let intersection = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const token of small) {
      if (large.has(token)) intersection += 1;
    }
    return intersection / (a.size + b.size - intersection);
  }
}

/** The token slices a weighted comparison needs — NormalizedTrace satisfies this. */
export interface WeightedTokens {
  tokens: TokenSet;
  headTokens: TokenSet;
}

/**
 * Weighted Jaccard: Σ min(wA(t), wB(t)) / Σ max(wA(t), wB(t)) over the token
 * union, where a token weighs `headWeight` when it comes from the trace HEAD
 * (error class + message) and 1 when it only appears in stack frames.
 *
 * Rationale: deep frames are frequently shared library internals (test runner,
 * HTTP client), so uniform weighting lets two UNRELATED failures look similar —
 * false-merge pressure, the one failure mode the tool must avoid. Weighting the
 * head makes the bug's identity dominate. When every token is a head token
 * (single-line traces) this reduces EXACTLY to plain Jaccard, so behavior on
 * message-only failures is unchanged.
 */
export class WeightedJaccardSimilarity {
  constructor(private readonly headWeight: number = 2) {}

  compare(a: WeightedTokens, b: WeightedTokens): number {
    if (a.tokens.size === 0 && b.tokens.size === 0) return 1;
    if (a.tokens.size === 0 || b.tokens.size === 0) return 0;

    const weightIn = (side: WeightedTokens, token: string): number =>
      side.tokens.has(token) ? (side.headTokens.has(token) ? this.headWeight : 1) : 0;

    let minSum = 0;
    let maxSum = 0;
    const union = new Set([...a.tokens, ...b.tokens]);
    for (const token of union) {
      const wa = weightIn(a, token);
      const wb = weightIn(b, token);
      minSum += Math.min(wa, wb);
      maxSum += Math.max(wa, wb);
    }
    return maxSum === 0 ? 1 : minSum / maxSum;
  }
}
