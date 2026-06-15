import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { apiKeys, loadEnv } from "../config/env.js";

// API-key auth. Clients send the key as `Authorization: Bearer <key>` or `x-api-key: <key>`.
// Comparison is timing-safe to avoid leaking key length/prefix via response timing.
// If no keys are configured, auth is disabled (dev only — the server logs a warning).

function extractKey(req: Request): string | null {
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const x = req.header("x-api-key");
  if (x) return x.trim();
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const keys = apiKeys(loadEnv());
  if (keys.length === 0) {
    next(); // auth disabled
    return;
  }
  const provided = extractKey(req);
  if (!provided) {
    res.status(401).json({ error: "missing API key" });
    return;
  }
  const ok = keys.some((k) => safeEqual(k, provided));
  if (!ok) {
    res.status(401).json({ error: "invalid API key" });
    return;
  }
  next();
}
