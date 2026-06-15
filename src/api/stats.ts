import { Router } from "express";
import prisma from "../db/index.js";

// Read-only stats from the UsageEvent ledger. Powers the README numbers and the optional
// stats page. Everything here is a real aggregate over recorded events — nothing fabricated.

export function buildStatsRouter(): Router {
  const router = Router();

  // Overall summary: hit rate, $ spent, $ saved, counts by outcome.
  router.get("/stats/summary", async (req, res) => {
    const namespace = (req.query.namespace as string | undefined)?.trim();
    const where = namespace ? { namespace } : {};

    const [byKind, byHitType] = await Promise.all([
      prisma.usageEvent.groupBy({
        by: ["kind"],
        where,
        _count: { id: true },
        _sum: { costUsd: true, outputTokens: true },
      }),
      prisma.usageEvent.groupBy({
        by: ["hitType"],
        where: { ...where, kind: "hit" },
        _count: { id: true },
        _sum: { costUsd: true },
      }),
    ]);

    const counts = { embed: 0, generate: 0, hit: 0 };
    let spentUsd = 0;
    let savedUsd = 0;
    let tokensSaved = 0;
    for (const row of byKind) {
      const n = row._count.id;
      const cost = Number(row._sum.costUsd ?? 0);
      if (row.kind === "hit") {
        counts.hit = n;
        savedUsd += cost;
        tokensSaved += Number(row._sum.outputTokens ?? 0);
      } else if (row.kind === "generate") {
        counts.generate = n;
        spentUsd += cost;
      } else if (row.kind === "embed") {
        counts.embed = n;
        spentUsd += cost;
      }
    }

    // Hit rate = hits / (hits + generations). Generations are the misses that reached Gemini.
    const lookups = counts.hit + counts.generate;
    const hitRate = lookups > 0 ? counts.hit / lookups : 0;

    const hits = { exact: 0, semantic: 0 };
    for (const row of byHitType) {
      if (row.hitType === "exact") hits.exact = row._count.id;
      else if (row.hitType === "semantic") hits.semantic = row._count.id;
    }

    res.json({
      namespace: namespace ?? "all",
      hitRate: Number(hitRate.toFixed(4)),
      hits,
      counts,
      costUsd: {
        spent: Number(spentUsd.toFixed(6)),
        saved: Number(savedUsd.toFixed(6)),
      },
      tokensSaved,
    });
  });

  // Latency percentiles by outcome, computed from recorded latencyMs.
  router.get("/stats/latency", async (req, res) => {
    const namespace = (req.query.namespace as string | undefined)?.trim();
    const where = namespace ? { namespace } : {};
    const events = await prisma.usageEvent.findMany({
      where,
      select: { kind: true, hitType: true, latencyMs: true },
      take: 50_000,
      orderBy: { createdAt: "desc" },
    });

    // Bucket by served-outcome: exact / semantic / miss(generate).
    const buckets: Record<string, number[]> = { exact: [], semantic: [], miss: [] };
    for (const e of events) {
      if (e.kind === "hit" && e.hitType) buckets[e.hitType]?.push(e.latencyMs);
      else if (e.kind === "generate") buckets.miss.push(e.latencyMs);
    }
    const out: Record<string, { count: number; p50: number; p95: number; p99: number }> = {};
    for (const [k, arr] of Object.entries(buckets)) {
      out[k] = {
        count: arr.length,
        p50: percentile(arr, 50),
        p95: percentile(arr, 95),
        p99: percentile(arr, 99),
      };
    }
    res.json(out);
  });

  return router;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
