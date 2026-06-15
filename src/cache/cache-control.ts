import type { Request } from "express";
import { loadEnv } from "../config/env.js";

// Per-request cache controls, expressed via headers so the proxy stays a drop-in:
//   x-cache: bypass     -> ignore any cached answer; always call Gemini (still stores result)
//   x-cache: no-store   -> may serve a hit, but do NOT store this request's result
//   x-cache: off        -> both: ignore cache AND don't store (pure passthrough)
//   x-cache-namespace   -> isolate this request's cache from others (default from env)
//   x-similarity-threshold -> override the semantic threshold for this request (0..1)

export interface CacheControl {
  /** Skip reading from the cache (force a miss path). */
  bypassRead: boolean;
  /** Skip writing the result to the cache. */
  noStore: boolean;
  namespace: string;
  /** Per-request semantic threshold override, or null to use the configured default. */
  threshold: number | null;
}

export function parseCacheControl(req: Request): CacheControl {
  const env = loadEnv();
  const raw = (req.header("x-cache") ?? "").toLowerCase().trim();
  const directives = new Set(raw.split(/[\s,]+/).filter(Boolean));

  const off = directives.has("off");
  const bypassRead = off || directives.has("bypass");
  const noStore = off || directives.has("no-store");

  const ns = (req.header("x-cache-namespace") ?? "").trim();
  const namespace = ns.length > 0 ? ns : env.DEFAULT_NAMESPACE;

  let threshold: number | null = null;
  const t = req.header("x-similarity-threshold");
  if (t !== undefined) {
    const parsed = Number(t);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) threshold = parsed;
  }

  return { bypassRead, noStore, namespace, threshold };
}
