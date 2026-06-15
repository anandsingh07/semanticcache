import "express-async-errors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { loadEnv, apiKeys } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { registry } from "./lib/metrics.js";
import { requireApiKey } from "./lib/auth.js";
import { CacheCore } from "./cache/core.js";
import { GeminiProvider } from "./providers/gemini.js";
import { buildRouter } from "./api/routes.js";
import { buildStatsRouter } from "./api/stats.js";
import { buildHealthRouter } from "./api/health.js";
import { statsPageHtml } from "./api/stats-page.js";

const env = loadEnv();

export function createApp(core?: CacheCore): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: env.MAX_BODY_BYTES }));

  // Health + metrics are unauthenticated (scrapers / load balancers need them).
  app.use(buildHealthRouter());

  app.get("/metrics", async (_req, res) => {
    res.setHeader("Content-Type", registry.contentType);
    res.send(await registry.metrics());
  });

  // Optional read-only stats dashboard (static HTML, fetches /stats/* client-side).
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(statsPageHtml());
  });

  // Rate limit + auth apply to the API surface below.
  const limiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const resolvedCore = core ?? new CacheCore(new GeminiProvider());
  app.use("/v1", limiter, requireApiKey, buildRouter(resolvedCore));
  app.use("/", requireApiKey, buildStatsRouter());

  // Central error handler.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, "unhandled error");
    if (res.headersSent) return;
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

function main(): void {
  if (apiKeys(env).length === 0) {
    logger.warn("API_KEYS is empty — authentication is DISABLED (acceptable in dev only).");
  }
  if (!env.GEMINI_API_KEY) {
    logger.warn("GEMINI_API_KEY is empty — cache misses cannot call Gemini until it is set.");
  }

  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, threshold: env.SEMANTIC_THRESHOLD },
      "SemanticCache proxy listening",
    );
  });
}

import { fileURLToPath } from "node:url";
import { argv } from "node:process";
if (process.argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main();
}
