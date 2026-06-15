// k6 load test for SemanticCache.
//
// Replays a realistic mixed workload against the running proxy and reports the headline
// numbers: hit rate, p50/p95/p99 latency split by cache outcome, and (via /stats/summary
// at the end) dollars saved. Run with:
//
//   BASE_URL=http://localhost:4000 API_KEY=yourkey k6 run bench/load.js
//
// The workload is intentionally cache-friendly-but-realistic: a small pool of "intents",
// each expressed several different ways (paraphrases), plus some unique one-offs. This is
// what a real FAQ/support/assistant traffic pattern looks like — and exactly where semantic
// caching wins over exact-match.

import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const API_KEY = __ENV.API_KEY || "";

const exactHits = new Counter("sc_exact_hits");
const semanticHits = new Counter("sc_semantic_hits");
const misses = new Counter("sc_misses");
const latHit = new Trend("sc_latency_hit_ms", true);
const latMiss = new Trend("sc_latency_miss_ms", true);

// Pool of intents, each with several paraphrases. Semantic caching should collapse the
// paraphrases onto the first generation per intent.
const INTENTS = [
  [
    "How do I reset my password?",
    "I forgot my password, what should I do?",
    "Can you help me recover my account password?",
    "password reset steps please",
  ],
  [
    "What are your business hours?",
    "When are you open?",
    "What time do you close today?",
    "tell me your opening hours",
  ],
  [
    "How can I cancel my subscription?",
    "I want to stop my subscription, how?",
    "cancel my plan please",
    "how do I unsubscribe from the service",
  ],
  [
    "Do you offer refunds?",
    "What's your refund policy?",
    "can I get my money back?",
    "how do refunds work here",
  ],
  [
    "How do I contact support?",
    "What's the best way to reach your team?",
    "I need to talk to a human, how?",
    "support contact details",
  ],
];

export const options = {
  scenarios: {
    mixed: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 10),
      duration: __ENV.DURATION || "60s",
    },
  },
};

function pickPrompt() {
  // 85% of traffic is paraphrases of known intents (cacheable); 15% unique one-offs.
  if (Math.random() < 0.15) {
    return `Unique question #${Math.floor(Math.random() * 1e9)}: explain ${Math.random()
      .toString(36)
      .slice(2)}`;
  }
  const intent = INTENTS[Math.floor(Math.random() * INTENTS.length)];
  return intent[Math.floor(Math.random() * intent.length)];
}

export default function () {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const res = http.post(
    `${BASE_URL}/v1/chat`,
    JSON.stringify({ prompt: pickPrompt() }),
    { headers },
  );

  check(res, { "status 200": (r) => r.status === 200 });

  const outcome = res.headers["X-Cache-Outcome"];
  if (outcome === "exact_hit") {
    exactHits.add(1);
    latHit.add(res.timings.duration);
  } else if (outcome === "semantic_hit") {
    semanticHits.add(1);
    latHit.add(res.timings.duration);
  } else if (outcome === "miss") {
    misses.add(1);
    latMiss.add(res.timings.duration);
  }
}

export function handleSummary(data) {
  // Pull final dollar savings from the proxy's own ledger.
  const headers = {};
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  let summary = {};
  try {
    const r = http.get(`${BASE_URL}/stats/summary`, { headers });
    summary = JSON.parse(r.body);
  } catch (_e) {
    summary = { error: "could not fetch /stats/summary" };
  }
  const out = {
    workload: "85% paraphrased intents + 15% unique",
    serverSummary: summary,
    k6Counters: {
      exactHits: data.metrics.sc_exact_hits?.values?.count || 0,
      semanticHits: data.metrics.sc_semantic_hits?.values?.count || 0,
      misses: data.metrics.sc_misses?.values?.count || 0,
    },
    latencyMs: {
      hit_p50: data.metrics.sc_latency_hit_ms?.values?.["p(50)"],
      hit_p99: data.metrics.sc_latency_hit_ms?.values?.["p(99)"],
      miss_p50: data.metrics.sc_latency_miss_ms?.values?.["p(50)"],
      miss_p99: data.metrics.sc_latency_miss_ms?.values?.["p(99)"],
    },
  };
  return {
    stdout: "\n" + JSON.stringify(out, null, 2) + "\n",
    "bench/last-result.json": JSON.stringify(out, null, 2),
  };
}
