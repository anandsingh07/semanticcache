import { describe, it, expect } from "vitest";
import {
  normalizePrompt,
  stableStringify,
  cacheKeyHash,
} from "../../src/cache/normalize.js";

describe("normalizePrompt", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizePrompt("  hello   world \n")).toBe("hello world");
  });

  it("lowercases", () => {
    expect(normalizePrompt("Hello WORLD")).toBe("hello world");
  });

  it("applies NFKC normalization", () => {
    // Full-width chars fold to ASCII under NFKC.
    expect(normalizePrompt("ＡＢＣ")).toBe("abc");
  });

  it("keeps punctuation (it can change meaning)", () => {
    expect(normalizePrompt("let's eat, grandma")).toBe("let's eat, grandma");
  });
});

describe("stableStringify", () => {
  it("sorts object keys so order doesn't matter", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("handles nested objects and arrays", () => {
    const x = { z: [3, { q: 1, p: 2 }], a: 1 };
    const y = { a: 1, z: [3, { p: 2, q: 1 }] };
    expect(stableStringify(x)).toBe(stableStringify(y));
  });

  it("distinguishes different values", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe("cacheKeyHash", () => {
  it("is identical for equivalent prompts (whitespace/case)", () => {
    const a = cacheKeyHash({ prompt: "Hello  World", model: "m" });
    const b = cacheKeyHash({ prompt: "hello world", model: "m" });
    expect(a).toBe(b);
  });

  it("differs when the model differs", () => {
    const a = cacheKeyHash({ prompt: "x", model: "m1" });
    const b = cacheKeyHash({ prompt: "x", model: "m2" });
    expect(a).not.toBe(b);
  });

  it("differs when params differ", () => {
    const a = cacheKeyHash({ prompt: "x", model: "m", params: { temperature: 0 } });
    const b = cacheKeyHash({ prompt: "x", model: "m", params: { temperature: 1 } });
    expect(a).not.toBe(b);
  });

  it("is independent of param key order", () => {
    const a = cacheKeyHash({ prompt: "x", model: "m", params: { a: 1, b: 2 } });
    const b = cacheKeyHash({ prompt: "x", model: "m", params: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("produces a 64-char hex sha256", () => {
    const h = cacheKeyHash({ prompt: "x", model: "m" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
