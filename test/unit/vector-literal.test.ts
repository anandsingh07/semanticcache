import { describe, it, expect } from "vitest";
import { toVectorLiteral } from "../../src/db/vector.js";
import { isCacheable } from "../../src/cache/exact-store.js";

describe("toVectorLiteral", () => {
  it("formats a vector as a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });

  it("handles negative and integer values", () => {
    expect(toVectorLiteral([-1, 0, 2])).toBe("[-1,0,2]");
  });

  it("throws on a non-finite value (would corrupt the column)", () => {
    expect(() => toVectorLiteral([1, NaN, 3])).toThrow(/non-finite/);
    expect(() => toVectorLiteral([1, Infinity])).toThrow(/non-finite/);
  });
});

describe("isCacheable (negative-cache guard)", () => {
  it("caches non-empty answers", () => {
    expect(isCacheable("a real answer")).toBe(true);
  });

  it("does not cache empty/whitespace answers", () => {
    expect(isCacheable("")).toBe(false);
    expect(isCacheable("   \n ")).toBe(false);
  });
});
