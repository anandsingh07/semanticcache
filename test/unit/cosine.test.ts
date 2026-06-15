import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  dot,
  norm,
  distanceToSimilarity,
} from "../../src/cache/cosine.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("is 1 for parallel vectors of different magnitude", () => {
    expect(cosineSimilarity([1, 0], [5, 0])).toBeCloseTo(1, 10);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("is -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1, 10);
  });

  it("returns 0 (not NaN) when a vector is zero-length", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension/);
  });
});

describe("dot / norm", () => {
  it("computes dot product", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
  it("computes L2 norm", () => {
    expect(norm([3, 4])).toBe(5);
  });
});

describe("distanceToSimilarity", () => {
  it("converts pgvector cosine distance to similarity", () => {
    expect(distanceToSimilarity(0)).toBe(1); // identical
    expect(distanceToSimilarity(1)).toBe(0); // orthogonal
    expect(distanceToSimilarity(2)).toBe(-1); // opposite
  });
});
