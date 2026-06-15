import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

// Single Prometheus registry for the proxy. Every metric here is actually recorded somewhere
// in the request path (honesty rule — no declared-but-dead metrics).

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** Total requests, labeled by outcome: exact_hit | semantic_hit | miss | error. */
export const requestsTotal = new Counter({
  name: "semanticcache_requests_total",
  help: "Total proxy requests by outcome",
  labelNames: ["outcome", "namespace"] as const,
  registers: [registry],
});

/** End-to-end request latency, split by outcome so cached vs uncached is visible. */
export const requestDuration = new Histogram({
  name: "semanticcache_request_duration_seconds",
  help: "Request duration in seconds by outcome",
  labelNames: ["outcome"] as const,
  // Buckets span sub-ms cache hits to multi-second Gemini calls.
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

/** USD spent on real Gemini calls (embed + generate). */
export const costSpentUsd = new Counter({
  name: "semanticcache_cost_spent_usd_total",
  help: "Cumulative USD spent on Gemini API calls",
  labelNames: ["kind"] as const,
  registers: [registry],
});

/** USD saved by serving cache hits instead of calling Gemini. */
export const costSavedUsd = new Counter({
  name: "semanticcache_cost_saved_usd_total",
  help: "Cumulative USD saved by cache hits",
  labelNames: ["hit_type"] as const,
  registers: [registry],
});

/** Tokens that would have been generated but were served from cache. */
export const tokensSaved = new Counter({
  name: "semanticcache_tokens_saved_total",
  help: "Output tokens saved by cache hits",
  registers: [registry],
});

/** Best semantic similarity observed per lookup (helps tune the threshold). */
export const semanticSimilarity = new Histogram({
  name: "semanticcache_semantic_similarity",
  help: "Top cosine similarity per semantic lookup",
  buckets: [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.92, 0.95, 0.98, 1.0],
  registers: [registry],
});

/** Entries evicted (LRU + expiry). */
export const evictionsTotal = new Counter({
  name: "semanticcache_evictions_total",
  help: "Cache entries evicted",
  registers: [registry],
});

/** Liveness/readiness as a gauge for scraping. */
export const upGauge = new Gauge({
  name: "semanticcache_up",
  help: "1 when the proxy considers itself ready",
  registers: [registry],
});
