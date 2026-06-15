# SemanticCache

**A semantic caching layer & proxy for LLM APIs — "Redis, but for AI responses."**

SemanticCache sits in front of an LLM (Gemini by default) and makes repeated **and
semantically similar** requests near-instant and free. An exact-match cache only catches
*identical* prompts; SemanticCache also recognizes when a new prompt **means the same thing**
as one it has already answered — "How do I reset my password?" and "I forgot my password,
what now?" — and serves the cached answer instead of paying the model again.

```
client ──POST /v1/chat──▶ SemanticCache ──(miss only)──▶ Gemini
                              │  exact-match (Redis)  → hit: ~7ms, $0
                              │  semantic (pgvector)  → hit: ~8ms, $0
                              └  miss                 → generate, stream, store
```

---

## 📌 About

**What it is:** a provider-agnostic caching proxy in front of an LLM (Gemini) that serves repeated **and semantically similar** prompts from cache — cutting latency and cost.

**How it works:** each request is normalized + hashed → `O(1)` **Redis exact-match** lookup; on a miss the prompt is embedded (`gemini-embedding-2`, 768-d) and run through a **pgvector ANN search** (HNSW, cosine) — if the nearest entry is similar enough (tunable threshold) it's served; otherwise it calls Gemini, streams the answer back, and stores it. Entries expire by TTL + per-namespace LRU; every call logs tokens + USD spent/saved; idempotent inserts via `UNIQUE(namespace, promptHash)`.

**Benchmark:** 1k mixed requests → 90.3% hit rate, hit p50 7.7 ms vs miss p50 80 ms, ~90% cost saved (reproducible: `npx tsx bench/run.ts`).

**Tech:** TypeScript · Express · Redis · PostgreSQL + pgvector · Prisma · Gemini (`@google/genai`) · prom-client · pino · Vitest + Testcontainers · k6 · Docker.

---

## Why it exists

Every team running an LLM in production hits the same wall: the same questions get asked over
and over, each call costs money and adds latency, and a hash-based cache barely helps because
real users phrase things differently. SemanticCache is the infrastructure layer that fixes
that — caching, vector similarity, eviction, cost accounting, and observability around the model.

It is deliberately **provider-agnostic**: the cache core depends only on an `LLMProvider`
interface. A Gemini adapter is implemented; a second provider is a matter of implementing the
same interface.

---

## Benchmark (reproducible)

The numbers below come from running the **real cache pipeline** (`src/cache/core.ts`) against
**real Postgres + pgvector and Redis** (via Testcontainers), driven by a deterministic
bag-of-words mock LLM so the run is `$0` and reproducible. The same pipeline runs against live
Gemini when you set `GEMINI_API_KEY`.

Workload: 1,000 requests, 85% paraphrases of 5 common intents (4 phrasings each) + 15% unique
one-offs — a realistic FAQ/support/assistant traffic shape.

| Metric | Result (threshold 0.7) |
|---|---|
| **Hit rate** | **90.3%** (738 exact + 165 semantic) |
| Generations avoided | 903 / 1000 |
| **Hit latency** p50 / p99 | **7.7 ms** / 40 ms |
| Miss latency p50 / p99 | 80 ms / 179 ms |
| **Cost saved** | **90.3%** ($0.272 saved vs $0.029 spent) |

**The threshold is a real precision/recall trade-off.** At a stricter threshold (0.9) with the
lexical mock, only exact repeats hit (82.2% hit rate, 0 semantic) — fewer but safer reuses. The
production default is `0.92`, tuned for a real embedding model (which scores true paraphrases far
higher than a bag-of-words mock can). Reproduce both:

```bash
npx tsx bench/run.ts                      # default
SEMANTIC_THRESHOLD=0.9 npx tsx bench/run.ts
# or load-test a running server with k6:
BASE_URL=http://localhost:4000 API_KEY=key k6 run bench/load.js
```

> Honest caveat: a semantic cache is **lossy by design** — it may serve a "close enough"
> answer. That risk is controlled by the similarity threshold, per-namespace isolation,
> per-entry TTL, and `x-cache: bypass`. Errors/empty responses are never cached.

---

## How it works

Every request flows through one pipeline (used by both the JSON and streaming endpoints):

1. **Normalize** the prompt (NFKC, whitespace, case) and hash it with the model + generation
   params → a SHA-256 cache key.
2. **Exact path** — `O(1)` Redis lookup. Identical requests return immediately, with **no
   embedding cost** (embeddings aren't free).
3. **Embed** the prompt (`gemini-embedding-2`, 768-dim).
4. **Semantic path** — approximate-nearest-neighbour search in **pgvector** (HNSW index,
   cosine). If the top match's similarity ≥ threshold → serve it.
5. **Miss** — call Gemini, stream the answer to the client, then store the entry (Redis + pgvector)
   and record the spend.

**Correctness & cost are first-class:**
- **Idempotency** via a `UNIQUE (namespace, promptHash)` constraint — concurrent identical
  inserts collapse to one row (proven in the integration tests).
- **Eviction**: per-entry TTL + per-namespace LRU capacity eviction.
- **Cost accounting**: every embed/generate logs tokens + USD; every hit logs the USD it
  *avoided*. Exposed via Prometheus and `/stats/summary`.
- **Namespaces** isolate caches so unrelated contexts never cross-match.

---

## API

All endpoints under `/v1` require an API key when `API_KEYS` is set
(`Authorization: Bearer <key>` or `x-api-key`).

### `POST /v1/chat`
```bash
curl -s localhost:4000/v1/chat \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_KEY' \
  -d '{"prompt":"How do I reset my password?"}'
```
```jsonc
{
  "answer": "...",
  "model": "gemini-2.5-flash",
  "outcome": "semantic_hit",       // exact_hit | semantic_hit | miss
  "similarity": 0.94,              // present on semantic hits
  "usage": { "inputTokens": 7, "outputTokens": 120, "costUsd": 0.0003 }
}
```
The cache outcome is also returned as the `x-cache-outcome` response header.

### `POST /v1/chat/stream`
Server-Sent Events. Streams `data: {"delta":"..."}` chunks, then a final
`event: done` with the outcome + usage. On a hit the full cached answer arrives as one chunk.

### Per-request controls (headers)
| Header | Effect |
|---|---|
| `x-cache: bypass` | Ignore cached answers (force a fresh call); still stores the result |
| `x-cache: no-store` | May serve a hit, but don't store this result |
| `x-cache: off` | Both of the above (pure passthrough) |
| `x-cache-namespace: <ns>` | Isolate this request's cache (default from `DEFAULT_NAMESPACE`) |
| `x-similarity-threshold: <0..1>` | Override the semantic threshold for this request |

### Stats & ops
- `GET /` — a small read-only live stats dashboard (hit rate, $ saved, latency by outcome).
- `GET /stats/summary?namespace=` — hit rate, counts, $ spent/saved, tokens saved.
- `GET /stats/latency?namespace=` — p50/p95/p99 latency by outcome.
- `GET /metrics` — Prometheus metrics.
- `GET /health/live` / `GET /health/ready` — liveness / deep readiness (Postgres + Redis + key).

---

## Quick start

```bash
# 1. Bring up Postgres (pgvector) + Redis + the proxy
#    Create a .env from the "Configuration" block below, then paste your GEMINI_API_KEY
GEMINI_API_KEY=xxxx docker compose up --build

# — or run locally against your own datastores —
npm install
# create a .env from the "Configuration" block below
npx prisma migrate deploy
npm run dev
```

Get a Gemini key at <https://aistudio.google.com/app/apikey>. Only the proxy reads it; it is
never logged.

---

## Tech

TypeScript (ESM) · Express · **Redis** (exact cache + rate limiting) · **Postgres + pgvector**
(semantic ANN search, HNSW) · Prisma 6 (raw SQL for vector ops) · **Gemini** (`@google/genai`) ·
prom-client · pino · Vitest + Testcontainers · k6 · multi-stage non-root Docker.

### Tests
```bash
npm run test               # 39 unit tests (normalization, cosine, pricing, controls, vector literal)
npm run test:integration   # 9 integration tests vs real pgvector + Redis (Testcontainers; needs Docker)
```
The integration suite proves the behaviours that matter: exact/semantic hits don't re-call the
LLM, unrelated prompts miss, namespaces isolate, concurrent identical inserts stay idempotent,
and LRU eviction bounds growth.

---

## Configuration

Key environment variables:

| Var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Your Gemini key (proxy-only) |
| `GEMINI_GENERATION_MODEL` | `gemini-2.5-flash` | Model used on a miss |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-2` | Embedding model |
| `EMBEDDING_DIMENSIONS` | `768` | Must match the `vector(N)` column |
| `SEMANTIC_THRESHOLD` | `0.92` | Cosine similarity required for a semantic hit |
| `CACHE_TTL_SECONDS` | `86400` | Entry TTL (0 = no expiry) |
| `CACHE_MAX_ENTRIES_PER_NAMESPACE` | `10000` | LRU capacity per namespace |
| `API_KEYS` | — | Comma-separated keys (empty = auth off, dev only) |

Create a `.env` file in the project root with the following (copy this block):

```dotenv
NODE_ENV=development

# --- Datastores ---
# Postgres must have the pgvector extension available. The migration runs
#   CREATE EXTENSION IF NOT EXISTS vector;
# The provided docker-compose uses the pgvector/pgvector image which ships it.
# Use 127.0.0.1 on Windows if localhost fails (IPv6 vs IPv4).
DATABASE_URL=postgresql://semcache:semcache@127.0.0.1:5432/semcache
REDIS_URL=redis://127.0.0.1:6379
PORT=4000

# --- Gemini ---
# Get a key at https://aistudio.google.com/app/apikey and paste it here.
# Only the proxy process reads this; it is never logged.
GEMINI_API_KEY=
# Generation model used on a cache MISS. gemini-2.5-flash is the cost default.
GEMINI_GENERATION_MODEL=gemini-2.5-flash
# Embedding model + dimensionality used for semantic similarity.
GEMINI_EMBEDDING_MODEL=gemini-embedding-2
EMBEDDING_DIMENSIONS=768

# --- Cache behaviour ---
# Cosine similarity threshold for a SEMANTIC hit (0..1). Higher = safer / fewer hits.
SEMANTIC_THRESHOLD=0.92
# Default TTL for cache entries (seconds). 0 = no expiry.
CACHE_TTL_SECONDS=86400
# Max entries per namespace before LRU eviction kicks in.
CACHE_MAX_ENTRIES_PER_NAMESPACE=10000
# Default namespace when a request omits x-cache-namespace.
DEFAULT_NAMESPACE=default

# --- Auth & security ---
# Comma-separated API keys clients must send as Authorization: Bearer <key>
# (or x-api-key). Leave empty to DISABLE auth (dev only; logs a warning at startup).
API_KEYS=
# Per-IP rate limit on the proxy API.
RATE_LIMIT_MAX=120
RATE_LIMIT_WINDOW_MS=60000
# Max request body size.
MAX_BODY_BYTES=1048576
# Store the raw prompt text in the DB (useful for debugging; disable to reduce PII).
STORE_PROMPT_TEXT=true

# --- Observability ---
LOG_LEVEL=info
```

> **Pricing note:** cost accounting uses the per-model rates in
> [`src/providers/pricing.ts`](src/providers/pricing.ts), verified against Google's published
> pricing on 2026-06-16. Update that one file if pricing changes; an unpriced model is recorded
> at `$0` with a one-time warning rather than breaking the cache.

---

## What's intentionally out of scope (v1)

- **More providers than Gemini** — the interface is provider-agnostic; only the Gemini adapter
  ships.
- **Distributed/sharded vector index** — a single Postgres handles the benchmark comfortably;
  scaling out (per-namespace shards, or an external ANN store like Qdrant) is the documented
  next step.
- **Mid-stream cache writes** — on a miss the answer streams to the client and is stored once
  complete.

---

## License

MIT
