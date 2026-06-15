import { Prisma } from "@prisma/client";
import prisma from "./index.js";

// pgvector access layer. Prisma can't type the `vector(768)` column, so every read/write
// that touches `embedding` goes through raw, PARAMETERIZED SQL here (no string
// interpolation of user data — the vector literal is the only thing we format, and it's
// built from numbers we validate).
//
// Cosine distance operator: `<=>`. similarity = 1 - distance. The HNSW index created in the
// migration (vector_cosine_ops) makes the ORDER BY embedding <=> $query LIMIT k an ANN scan.

/** Format a number[] as a pgvector literal: "[0.1,0.2,...]". Validates finiteness. */
export function toVectorLiteral(vec: number[]): string {
  for (const v of vec) {
    if (!Number.isFinite(v)) throw new Error("embedding contains a non-finite value");
  }
  return `[${vec.join(",")}]`;
}

export interface NearestRow {
  id: string;
  namespace: string;
  promptHash: string;
  prompt: string | null;
  model: string;
  answer: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string; // Decimal comes back as string from raw query
  /** cosine similarity in [-1,1], already converted from distance. */
  similarity: number;
  expiresAt: Date | null;
}

/**
 * Nearest-neighbour search within a namespace, excluding expired entries. Returns the top
 * `k` by cosine similarity (highest first). Uses the HNSW index via `<=>`.
 */
export async function findNearest(
  namespace: string,
  queryVector: number[],
  k = 1,
): Promise<NearestRow[]> {
  const literal = toVectorLiteral(queryVector);
  // `::vector` casts the parameter; the rest are bound parameters. `now()` filters TTL.
  const rows = await prisma.$queryRaw<NearestRow[]>(Prisma.sql`
    SELECT
      "id", "namespace", "promptHash", "prompt", "model", "answer",
      "inputTokens", "outputTokens", "costUsd"::text AS "costUsd",
      1 - ("embedding" <=> ${literal}::vector) AS "similarity",
      "expiresAt"
    FROM "cache_entries"
    WHERE "namespace" = ${namespace}
      AND "embedding" IS NOT NULL
      AND ("expiresAt" IS NULL OR "expiresAt" > now())
    ORDER BY "embedding" <=> ${literal}::vector
    LIMIT ${k}
  `);
  return rows;
}

export interface InsertEntryInput {
  id: string;
  namespace: string;
  promptHash: string;
  prompt: string | null;
  model: string;
  answer: string;
  embedding: number[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  expiresAt: Date | null;
}

/**
 * Insert (or upsert on namespace+promptHash) a cache entry with its embedding. The unique
 * constraint makes concurrent inserts of the same exact prompt idempotent — the second one
 * updates instead of creating a duplicate (same DB-constraint idempotency as CronHive).
 */
export async function insertEntry(input: InsertEntryInput): Promise<void> {
  const literal = toVectorLiteral(input.embedding);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "cache_entries"
      ("id", "namespace", "promptHash", "prompt", "model", "answer", "embedding",
       "inputTokens", "outputTokens", "costUsd", "hits", "lastHitAt", "expiresAt", "createdAt")
    VALUES
      (${input.id}, ${input.namespace}, ${input.promptHash}, ${input.prompt}, ${input.model},
       ${input.answer}, ${literal}::vector, ${input.inputTokens}, ${input.outputTokens},
       ${input.costUsd}::decimal, 0, now(), ${input.expiresAt}, now())
    ON CONFLICT ("namespace", "promptHash") DO UPDATE SET
      "answer" = EXCLUDED."answer",
      "embedding" = EXCLUDED."embedding",
      "model" = EXCLUDED."model",
      "inputTokens" = EXCLUDED."inputTokens",
      "outputTokens" = EXCLUDED."outputTokens",
      "costUsd" = EXCLUDED."costUsd",
      "expiresAt" = EXCLUDED."expiresAt"
  `);
}

/** Bump hit counter + recency for LRU/analytics after serving a semantic hit. */
export async function recordHit(id: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "cache_entries"
    SET "hits" = "hits" + 1, "lastHitAt" = now()
    WHERE "id" = ${id}
  `);
}
