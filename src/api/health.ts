import { Router } from "express";
import prisma from "../db/index.js";
import { getRedis } from "../lib/redis.js";
import { loadEnv } from "../config/env.js";
import { upGauge } from "../lib/metrics.js";

// Liveness vs readiness:
//   /health/live  -> process is up (no dependency checks). For restart decisions.
//   /health/ready -> Postgres reachable + Redis reachable + Gemini key present.
//                    For load-balancer "send traffic?" decisions.

export function buildHealthRouter(): Router {
  const router = Router();

  router.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/health/ready", async (_req, res) => {
    const env = loadEnv();
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    // Postgres.
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = { ok: true };
    } catch (err) {
      checks.postgres = { ok: false, detail: (err as Error).message };
    }

    // Redis.
    try {
      const pong = await getRedis().ping();
      checks.redis = { ok: pong === "PONG" };
    } catch (err) {
      checks.redis = { ok: false, detail: (err as Error).message };
    }

    // Gemini key (presence only — we don't burn a call on every health check).
    checks.gemini = env.GEMINI_API_KEY
      ? { ok: true }
      : { ok: false, detail: "GEMINI_API_KEY not set" };

    const ready = Object.values(checks).every((c) => c.ok);
    upGauge.set(ready ? 1 : 0);
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks });
  });

  return router;
}
