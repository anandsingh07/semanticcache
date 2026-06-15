// Cosine similarity in plain JS. pgvector does the heavy lifting in the DB for ANN search,
// but we use this for: (a) unit-testing the similarity logic deterministically without a DB,
// and (b) a defensive re-check of the top candidate the DB returns.

/** Dot product of two equal-length vectors. */
export function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Euclidean (L2) norm. */
export function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

/**
 * Cosine similarity in [-1, 1] (1 = identical direction). Returns 0 if either vector is
 * zero-length (undefined direction) rather than NaN, so callers never compare against NaN.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch ${a.length} vs ${b.length}`);
  }
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

/**
 * pgvector's `<=>` operator returns cosine DISTANCE (0 = identical, 2 = opposite).
 * similarity = 1 - distance. This helper keeps the conversion in one documented place.
 */
export function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}
