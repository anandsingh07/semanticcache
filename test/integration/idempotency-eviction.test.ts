import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startHarness, type Harness } from "./harness.js";

// Proves two DB-level guarantees directly against pgvector:
//  1. The unique (namespace, promptHash) constraint makes concurrent inserts of the same
//     exact prompt idempotent — one row, not duplicates (the CronHive fire-slot trick).
//  2. LRU capacity eviction removes least-recently-used entries down to the limit.

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ CACHE_MAX_ENTRIES_PER_NAMESPACE: "5" });
}, 180_000);

afterAll(async () => {
  await h?.teardown();
});

function vec(seed: number): number[] {
  // Deterministic 768-dim unit-ish vector.
  const v = new Array<number>(768).fill(0);
  v[seed % 768] = 1;
  v[(seed * 7) % 768] = 0.5;
  return v;
}

describe("insert idempotency", () => {
  it("concurrent identical inserts produce exactly one row", async () => {
    const ns = "idem-ns";
    const promptHash = "samehash";
    const mk = (i: number) =>
      h.vector.insertEntry({
        id: `id-${i}`,
        namespace: ns,
        promptHash,
        prompt: "p",
        model: "m",
        answer: `answer-${i}`,
        embedding: vec(1),
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.001,
        expiresAt: null,
      });

    // Fire 10 inserts of the same (namespace, promptHash) concurrently.
    await Promise.all(Array.from({ length: 10 }, (_, i) => mk(i)));

    const rows = await h.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "cache_entries" WHERE "namespace" = $1 AND "promptHash" = $2`,
      ns,
      promptHash,
    );
    expect(Number(rows[0].count)).toBe(1);
  });
});

describe("LRU eviction", () => {
  it("evicts least-recently-used entries beyond the per-namespace cap", async () => {
    const ns = "evict-ns";
    // Cap is 5 (set in beforeAll). Insert 8 distinct entries.
    for (let i = 0; i < 8; i++) {
      await h.vector.insertEntry({
        id: `e-${i}`,
        namespace: ns,
        promptHash: `h-${i}`,
        prompt: `p-${i}`,
        model: "m",
        answer: `a-${i}`,
        embedding: vec(i + 10),
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.001,
        expiresAt: null,
      });
      // Stagger lastHitAt so eviction order is well-defined (older i = older entry).
      await h.prisma.$executeRawUnsafe(
        `UPDATE "cache_entries" SET "lastHitAt" = now() - (interval '1 second' * $1) WHERE "id" = $2`,
        8 - i,
        `e-${i}`,
      );
    }

    const { enforceCapacity } = await import("../../src/cache/eviction.js");
    const evicted = await enforceCapacity(ns);
    expect(evicted).toBe(3); // 8 - 5

    const rows = await h.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "cache_entries" WHERE "namespace" = $1`,
      ns,
    );
    expect(Number(rows[0].count)).toBe(5);

    // The 3 oldest (e-0, e-1, e-2) should be gone; the 5 newest remain.
    const remaining = await h.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "cache_entries" WHERE "namespace" = $1 ORDER BY "id"`,
      ns,
    );
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain("e-0");
    expect(ids).not.toContain("e-1");
    expect(ids).not.toContain("e-2");
    expect(ids).toContain("e-7");
  });
});
