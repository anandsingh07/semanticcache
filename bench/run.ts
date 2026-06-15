// Self-contained benchmark of the REAL cache pipeline.
//
// Spins up real Postgres (pgvector) + Redis via Testcontainers, runs the actual CacheCore
// against a deterministic MockProvider with a realistic mixed workload, and prints the
// honest headline numbers: hit rate, latency split (hit vs miss), $ saved, generations
// avoided. These are the numbers quoted in the README — reproduce them with:
//
//   npx tsx bench/run.ts
//
// (Needs Docker running. Uses the mock LLM so it costs $0 and is deterministic; the same
// pipeline runs against real Gemini when you point the server at GEMINI_API_KEY.)

import { execSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { MockProvider } from "./mock-provider.js";

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

function pickPrompt(rng: () => number): string {
  if (rng() < 0.15) {
    return `Unique question ${Math.floor(rng() * 1e9)}: explain topic ${Math.floor(rng() * 1e6)}`;
  }
  const intent = INTENTS[Math.floor(rng() * INTENTS.length)];
  return intent[Math.floor(rng() * intent.length)];
}

// Deterministic PRNG so the benchmark is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
}

async function main(): Promise<void> {
  const N = Number(process.env.BENCH_N || 1000);
  console.log(`Starting containers (Postgres+pgvector, Redis)…`);

  const pg = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withDatabase("semcache")
    .withUsername("semcache")
    .withPassword("semcache")
    .start();
  const redis = await new RedisContainer("redis:7-alpine").start();

  const databaseUrl = pg.getConnectionUri();
  const redisUrl = redis.getConnectionUrl();

  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.NODE_ENV = "test";
  process.env.GEMINI_API_KEY = "mock";
  process.env.SEMANTIC_THRESHOLD = process.env.SEMANTIC_THRESHOLD || "0.9";

  console.log("Applying migrations…");
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });

  // Import AFTER env is set so loadEnv() picks up the container URLs.
  const { CacheCore } = await import("../src/cache/core.js");
  const { closeRedis } = await import("../src/lib/redis.js");
  const prismaMod = await import("../src/db/index.js");

  const mock = new MockProvider({ dimensions: 768, generateLatencyMs: 40 });
  const core = new CacheCore(mock);
  const control = { bypassRead: false, noStore: false, namespace: "bench", threshold: null };

  const rng = mulberry32(42);
  const hitLatencies: number[] = [];
  const missLatencies: number[] = [];
  const outcomes = { exact_hit: 0, semantic_hit: 0, miss: 0, error: 0 };
  let savedUsd = 0;
  let spentUsd = 0;

  console.log(`Running ${N} requests (85% paraphrased intents + 15% unique)…`);
  for (let i = 0; i < N; i++) {
    const prompt = pickPrompt(rng);
    const t0 = performance.now();
    const r = await core.resolve({ prompt, model: "mock-gen", control });
    const dt = performance.now() - t0;
    outcomes[r.outcome]++;
    if (r.outcome === "miss") {
      missLatencies.push(dt);
      spentUsd += r.costUsd;
    } else if (r.outcome === "semantic_hit" || r.outcome === "exact_hit") {
      hitLatencies.push(dt);
      savedUsd += r.costUsd;
    }
  }

  const hits = outcomes.exact_hit + outcomes.semantic_hit;
  const hitRate = hits / N;

  const result = {
    requests: N,
    workload: "85% paraphrased intents (5 intents x 4 phrasings) + 15% unique",
    threshold: Number(process.env.SEMANTIC_THRESHOLD),
    outcomes,
    hitRate: Number((hitRate * 100).toFixed(1)) + "%",
    generationsAvoided: hits,
    embedCalls: mock.embedCalls,
    generateCalls: mock.generateCalls,
    latencyMs: {
      hit_p50: Number(percentile(hitLatencies, 50).toFixed(2)),
      hit_p99: Number(percentile(hitLatencies, 99).toFixed(2)),
      miss_p50: Number(percentile(missLatencies, 50).toFixed(2)),
      miss_p99: Number(percentile(missLatencies, 99).toFixed(2)),
    },
    costUsd: {
      spent: Number(spentUsd.toFixed(6)),
      saved: Number(savedUsd.toFixed(6)),
      savedPct:
        spentUsd + savedUsd > 0
          ? Number(((savedUsd / (spentUsd + savedUsd)) * 100).toFixed(1)) + "%"
          : "n/a",
    },
  };

  console.log("\n=== SemanticCache benchmark ===");
  console.log(JSON.stringify(result, null, 2));

  await prismaMod.prisma.$disconnect();
  await closeRedis();
  await redis.stop();
  await pg.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
