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
