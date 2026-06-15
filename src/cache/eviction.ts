import { Prisma } from "@prisma/client";
import prisma from "../db/index.js";
import { loadEnv } from "../config/env.js";
import { logger } from "../lib/logger.js";

// Capacity-based LRU eviction for the semantic (pgvector) store. TTL handles freshness;
// this handles bounded growth. After a store, if a namespace exceeds its capacity we delete
// the least-recently-used entries (oldest lastHitAt) down to the limit.
//
// Two cheap correctness choices:
//  - We also opportunistically purge already-expired rows here, so the table doesn't grow
//    with dead entries between TTL boundaries (the ANN query already filters them out, but
//    deleting keeps the index small).
//  - Eviction is best-effort: a failure is logged, never thrown, so it can't break a request.

/** Delete expired rows in a namespace. Returns count removed. */
export async function purgeExpired(namespace: string): Promise<number> {
  const removed = await prisma.$executeRaw(Prisma.sql`
    DELETE FROM "cache_entries"
    WHERE "namespace" = ${namespace}
      AND "expiresAt" IS NOT NULL
      AND "expiresAt" <= now()
  `);
  return removed;
}

/**
 * Enforce per-namespace capacity by evicting least-recently-used entries. Returns the
 * number of entries evicted (0 if under capacity). Best-effort: catches and logs errors.
 */
export async function enforceCapacity(namespace: string): Promise<number> {
  const max = loadEnv().CACHE_MAX_ENTRIES_PER_NAMESPACE;
  try {
    await purgeExpired(namespace);

    const countRows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM "cache_entries" WHERE "namespace" = ${namespace}
    `);
    const count = Number(countRows[0]?.count ?? 0n);
    if (count <= max) return 0;

    const overBy = count - max;
    // Delete the `overBy` least-recently-used rows. Subquery picks the LRU ids; the outer
    // DELETE removes them. ctid is unique per row; we match on id (our PK).
    const evicted = await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "cache_entries"
      WHERE "id" IN (
        SELECT "id" FROM "cache_entries"
        WHERE "namespace" = ${namespace}
        ORDER BY "lastHitAt" ASC
        LIMIT ${overBy}
      )
    `);
    if (evicted > 0) {
      logger.debug({ namespace, evicted, count, max }, "LRU eviction");
    }
    return evicted;
  } catch (err) {
    logger.error({ err, namespace }, "eviction failed (non-fatal)");
    return 0;
  }
}
