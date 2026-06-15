import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startHarness, control, type Harness } from "./harness.js";
import { MockProvider } from "../../bench/mock-provider.js";

// End-to-end tests of the real CacheCore against real Postgres+pgvector and Redis, using the
// deterministic MockProvider. These prove the behaviours the project is actually about:
// exact hits, semantic hits, miss->store, idempotency, and that hits don't re-call the LLM.

let h: Harness;

beforeAll(async () => {
  // Lower threshold so the lexical mock surfaces semantic hits (see bench notes).
  h = await startHarness({ SEMANTIC_THRESHOLD: "0.7", CACHE_TTL_SECONDS: "3600" });
}, 180_000);

afterAll(async () => {
  await h?.teardown();
});

describe("exact-match cache", () => {
  it("returns a miss then an exact hit for the identical prompt, without re-calling the LLM", async () => {
    const mock = new MockProvider();
    const core = new h.CacheCore(mock);
    const ctx = (p: string) => ({ prompt: p, model: "mock-gen", control: control("exact-ns") });

    const first = await core.resolve(ctx("What is the capital of France?"));
    expect(first.outcome).toBe("miss");
    expect(mock.generateCalls).toBe(1);

    const second = await core.resolve(ctx("What is the capital of France?"));
    expect(second.outcome).toBe("exact_hit");
    expect(second.answer).toBe(first.answer);
    // The whole point: a hit does NOT call the LLM again.
    expect(mock.generateCalls).toBe(1);
  });

  it("treats whitespace/case variants as the same exact entry", async () => {
    const mock = new MockProvider();
    const core = new h.CacheCore(mock);
    const c = control("exact-ns2");

    await core.resolve({ prompt: "Hello World", model: "mock-gen", control: c });
    const variant = await core.resolve({
      prompt: "  hello   world ",
      model: "mock-gen",
      control: c,
    });
    expect(variant.outcome).toBe("exact_hit");
    expect(mock.generateCalls).toBe(1);
  });
});

describe("semantic cache", () => {
  it("serves a semantically-similar prompt from cache (not exact, not a new generation)", async () => {
    const mock = new MockProvider();
    const core = new h.CacheCore(mock);
    const c = control("sem-ns");

    // Seed with one phrasing.
    const seed = await core.resolve({
      prompt: "How do I reset my password?",
      model: "mock-gen",
      control: c,
    });
    expect(seed.outcome).toBe("miss");
    expect(mock.generateCalls).toBe(1);

    // A lexically-overlapping paraphrase should hit semantically (>= 0.7 with the mock).
    const para = await core.resolve({
      prompt: "password reset steps please",
      model: "mock-gen",
      control: c,
    });
    expect(para.outcome).toBe("semantic_hit");
    expect(para.similarity).toBeGreaterThanOrEqual(0.7);
    // Served from cache → no new generation.
    expect(mock.generateCalls).toBe(1);
  });

  it("does NOT serve an unrelated prompt from cache (precision)", async () => {
    const mock = new MockProvider();
    const core = new h.CacheCore(mock);
    const c = control("sem-ns2");

    await core.resolve({ prompt: "How do I reset my password?", model: "mock-gen", control: c });
    const unrelated = await core.resolve({
      prompt: "What are your business hours?",
      model: "mock-gen",
      control: c,
    });
    // Different intent → miss, new generation.
    expect(unrelated.outcome).toBe("miss");
    expect(mock.generateCalls).toBe(2);
  });
});

describe("namespace isolation", () => {
  it("does not cross-serve between namespaces", async () => {
    const mock = new MockProvider();
    const core = new h.CacheCore(mock);
    const prompt = "Shared exact prompt across namespaces";

    const a = await core.resolve({ prompt, model: "mock-gen", control: control("ns-a") });
    expect(a.outcome).toBe("miss");
    const b = await core.resolve({ prompt, model: "mock-gen", control: control("ns-b") });
    // Same text, different namespace → still a miss (isolated caches).
    expect(b.outcome).toBe("miss");
    expect(mock.generateCalls).toBe(2);
  });
});

describe("cache controls", () => {
  it("x-cache bypass forces a fresh generation even with a warm entry", async () => {
    const mock = new MockProvider();
    const core = new h.CacheCore(mock);
    const c = control("bypass-ns");

    await core.resolve({ prompt: "cached q", model: "mock-gen", control: c });
    expect(mock.generateCalls).toBe(1);

    const bypassed = await core.resolve({
      prompt: "cached q",
      model: "mock-gen",
      control: control("bypass-ns", { bypassRead: true }),
    });
    expect(bypassed.outcome).toBe("miss");
    expect(mock.generateCalls).toBe(2);
  });

  it("no-store serves reads but does not persist new entries", async () => {
    const mock = new MockProvider();
    const core = new h.CacheCore(mock);

    const first = await core.resolve({
      prompt: "ephemeral q",
      model: "mock-gen",
      control: control("nostore-ns", { noStore: true }),
    });
    expect(first.outcome).toBe("miss");

    // Because the first wasn't stored, the second is also a miss.
    const second = await core.resolve({
      prompt: "ephemeral q",
      model: "mock-gen",
      control: control("nostore-ns", { noStore: true }),
    });
    expect(second.outcome).toBe("miss");
    expect(mock.generateCalls).toBe(2);
  });
});
