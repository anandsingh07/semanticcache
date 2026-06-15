import { describe, it, expect, beforeEach } from "vitest";
import {
  generationCostUsd,
  embeddingCostUsd,
  _resetPricingWarnings,
} from "../../src/providers/pricing.js";

describe("generationCostUsd", () => {
  beforeEach(() => _resetPricingWarnings());

  it("prices gemini-2.5-flash correctly", () => {
    // 1M input @ $0.30 + 1M output @ $2.50 = $2.80
    expect(generationCostUsd("gemini-2.5-flash", 1_000_000, 1_000_000)).toBeCloseTo(2.8, 6);
  });

  it("prices gemini-2.5-pro correctly", () => {
    // 1M input @ $1.25 + 1M output @ $10 = $11.25
    expect(generationCostUsd("gemini-2.5-pro", 1_000_000, 1_000_000)).toBeCloseTo(11.25, 6);
  });

  it("scales linearly with token count", () => {
    const small = generationCostUsd("gemini-2.5-flash", 1000, 500);
    const big = generationCostUsd("gemini-2.5-flash", 2000, 1000);
    expect(big).toBeCloseTo(small * 2, 10);
  });

  it("returns 0 for an unknown model (graceful)", () => {
    expect(generationCostUsd("totally-made-up", 1000, 1000)).toBe(0);
  });
});

describe("embeddingCostUsd", () => {
  beforeEach(() => _resetPricingWarnings());

  it("prices embeddings on input tokens only", () => {
    // 1M input @ $0.15 = $0.15
    expect(embeddingCostUsd("gemini-embedding-2", 1_000_000)).toBeCloseTo(0.15, 6);
  });

  it("returns 0 for an unknown embedding model", () => {
    expect(embeddingCostUsd("made-up-embed", 1_000_000)).toBe(0);
  });
});
