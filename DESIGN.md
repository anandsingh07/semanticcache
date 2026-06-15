# SemanticCache — Design Document

> **A semantic caching layer & proxy for LLM APIs.** "Redis, but for AI responses."
> It sits in front of the Gemini API and makes repeated *and semantically similar* requests
> near-instant and free by recognizing when a new prompt **means the same thing** as one it
> has already answered.
>
> _Third flagship project: **AI infrastructure** — completing the arc with CronHive
> (distributed scheduling) and ChainPulse (event-streaming pipeline). This is the
> performance + cost + correctness story._

---

## 1. The problem (why this exists)

Every team putting an LLM into production hits the same wall: the same questions get asked over
and over, each call costs money and adds latency, and an exact-match cache barely helps because
real users phrase things differently. "How do I reset my password?" and "I forgot my password,
what now?" are the *same question* but a hash-based cache treats them as two distinct misses.

**SemanticCache solves that.** It's a drop-in proxy in front of Gemini:

- Your app points at SemanticCache instead of calling Google directly.
- On each request it embeds the prompt and does a **vector similarity search** over what it has
  already answered. If a stored prompt is similar enough (above a tunable threshold), it returns
  that cached answer in **milliseconds, for $0** — no Gemini call.
- On a miss it calls Gemini, returns the answer (streaming), and stores it for next time.

The result, which the README leads with as hard numbers: **higher hit rate than exact-match
caching, p99 latency collapses on hits, and real dollars saved** — all measured by a load test,
not claimed.

---

## 2. Why this is the strongest FAANG/MNC signal

- **It's a genuine systems/infra problem**, not a CRUD app: caching semantics, vector
  similarity, eviction policy (TTL + LRU), latency-tail management, and a real correctness
  trade-off — *when is "similar enough" actually safe to reuse?* That tension is what makes it
  interview-grade.
- **The AI is intrinsic, not bolted on.** Embeddings + similarity *are* the mechanism. But it
  isn't a chatbot — it's infrastructure that happens to use AI, which is exactly the
  in-demand-but-rare combination.
- **It's measurable.** Hit rate, p50/p99 latency (cached vs uncached), tokens saved, USD saved.
  A portfolio repo that leads with verifiable numbers is the most credible kind.
- **It completes the portfolio arc** and reuses everything already built (Redis, prom-client,
  pino, Docker, Testcontainers, the BullMQ-grade reliability discipline):
  - CronHive → distributed scheduling / correctness
  - ChainPulse → streaming / data pipeline
  - **SemanticCache → AI infrastructure / performance & cost**

---

## 3. Scope (what we build vs. deliberately skip)

### In scope (v1)
- **Proxy API** — `POST /v1/chat` (and a streaming `POST /v1/chat/stream`) that mirrors a small,
  clean request shape and forwards misses to Gemini.
- **Exact-match fast path** — SHA-256 of the normalized prompt (+ model + params) → O(1) Redis
  lookup. Catches identical requests with zero embedding cost.
- **Semantic slow path** — embed the prompt (Gemini `gemini-embedding-2`) → **vector similarity
  search** → return cached answer if cosine similarity ≥ threshold.
- **Vector store** — **pgvector** (Postgres extension) for similarity search with an ANN index
  (IVFFlat/HNSW). Postgres keeps it one-dependency-simpler and matches the other projects.
- **Eviction & freshness** — per-entry **TTL** + **LRU**-style eviction by capacity; configurable
  similarity **threshold** and **namespaces** (so two tenants/use-cases don't cross-contaminate).
- **Cost & savings accounting** — every Gemini call logs input/output tokens and computed USD;
  every cache hit logs the USD it *avoided*. Cumulative "dollars saved" is a first-class metric.
- **Observability** — Prometheus metrics (hit rate, latency histograms split cached/uncached,
  tokens & cost saved), pino structured logs, `/health` (liveness + readiness incl. Gemini reachability).
- **Safety/hardening** — API-key auth (timing-safe), per-key rate limiting, request validation,
  payload size limits, redaction of prompts in logs by default.
- **Benchmark harness** — a `k6` (or Node) script that replays a realistic mixed workload
  (exact dupes + paraphrases + unique) and prints hit rate, p50/p99 cached vs uncached, $ saved.
- **Tests** — Vitest unit (normalization, cosine, threshold logic, cost math, eviction) +
  integration (Testcontainers Postgres+pgvector & Redis: real hit/miss/eviction/idempotency).
- **Docker** — multi-stage non-root image + `docker compose up` (proxy + postgres/pgvector + redis).
- **Optional tiny dashboard** — a single read-only stats page (hit rate, $ saved, recent
  hits/misses). Honest: only shows what's actually measured.

### Deliberately out of scope (and why)
- **Multi-provider adapters beyond Gemini** — the code uses a `Provider` interface so a second
  provider *could* slot in, but only Gemini is implemented. (Claimed honestly: "Gemini adapter
  implemented; interface is provider-agnostic.")
- **Distributed/sharded vector index** — single Postgres is plenty for a portfolio benchmark;
  the README notes how it would scale (per-namespace shards, external ANN like Qdrant) as a next step.
- **Streaming *cache writes* mid-stream** — on a miss we stream to the client and assemble the
  full answer, then store it once complete (simpler + correct).

> **Honesty rule (carried from CronHive/ChainPulse):** README claims only what the code does.
> Numbers, not adjectives. No fabricated panels or invented benchmarks.

---

## 4. Architecture

```
   client app
       │  POST /v1/chat            (points here instead of at Google)
       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │                    SemanticCache proxy (Node/Express)         │
  │                                                              │
  │  auth + rate limit + validate                                 │
  │        │                                                      │
  │        ▼                                                      │
  │  1) normalize prompt → SHA-256 key                            │
  │        │  exact hit? ───────────────► return (Redis)  ⚡ $0    │
  │        ▼  miss                                                │
  │  2) embed prompt (Gemini gemini-embedding-2, 768-d)           │
  │        │                                                      │
  │        ▼                                                      │
  │  3) pgvector ANN search within namespace                      │
  │        │  cosine ≥ threshold? ──────► return (semantic hit) ⚡  │
  │        ▼  miss                                                │
  │  4) call Gemini generate (stream) ──► return to client        │
  │        │                                                      │
  │        ▼  on completion                                       │
  │  5) store {promptHash, embedding, answer, model, tokens, ttl} │
  │     + record UsageEvent (cost spent)                          │
  └───────────────┬───────────────────────────┬─────────────────┘
                  │                            │
          ┌───────▼────────┐          ┌────────▼─────────┐
          │  Redis          │          │ Postgres+pgvector │
          │  exact-match KV │          │ semantic entries  │
          │  rate-limit     │          │ + ANN index       │
          │  LRU metadata   │          │ usage/cost log    │
          └────────────────┘          └──────────────────┘
                  ▲
                  │ /metrics  /health
            Prometheus / load balancer
```

**Single service** (the proxy) plus Redis + Postgres/pgvector. Optional read-only stats page can
be the same service or a tiny Next.js front (decided at build time; default = a simple static page
served by the proxy to keep it one deployable).

### Request lifecycle (the part interviewers will probe)
1. **Normalize** — trim, collapse whitespace, lowercase-fold where safe, include `model` +
   generation params in the key so different settings don't collide.
2. **Exact path** — Redis `GET sha256(...)`. Hit → return immediately, log a $0 hit. (No embedding
   cost on exact dupes — important: embedding isn't free.)
3. **Embed** — `gemini-embedding-2`, `outputDimensionality: 768` (verified against Google docs;
   768 is the recommended balance of quality vs index size; default is 3072).
4. **Semantic search** — pgvector cosine distance, ANN index, filtered by `namespace`, `LIMIT 1`.
   If `1 - distance ≥ threshold` → semantic hit; return cached answer + log avoided cost.
5. **Miss** — call Gemini generation (default `gemini-2.5-flash` for cost; configurable), stream
   to client.
6. **Store** — write the entry (prompt hash, embedding, answer, model, token counts, expiry), and
   a `UsageEvent` for the spend. Eviction enforces capacity (LRU) and TTL.

### Correctness & safety of reuse (the hard question)
- **Tunable threshold** with a sane default (e.g. 0.92 cosine) — documented trade-off:
  higher = safer/fewer hits, lower = more hits/more risk of a wrong reuse.
- **Namespaces** isolate caches so unrelated contexts never match.
- **Per-entry TTL** so stale answers expire.
- **Bypass + no-store controls** per request (`x-cache: bypass`) for cases that must hit Gemini.
- **Negative-cache guard**: never cache error/refusal/empty responses.
- This *is* a lossy cache by design; the README states that plainly and shows the threshold's
  effect on the hit-rate/precision curve from the benchmark.

---

## 5. Data model (Prisma + pgvector sketch)

```prisma
// pgvector enabled via migration: CREATE EXTENSION IF NOT EXISTS vector;

model CacheEntry {
  id            String   @id @default(cuid())
  namespace     String                         // tenant / use-case isolation
  promptHash    String                         // sha256(normalized prompt + model + params)
  prompt        String                         // stored for debugging (redactable)
  model         String
  answer        String
  // embedding stored via Unsupported("vector(768)") + raw SQL ANN query
  inputTokens   Int
  outputTokens  Int
  costUsd       Decimal                        // what this answer cost to generate
  hits          Int      @default(0)           // for LRU + analytics
  lastHitAt     DateTime @default(now())
  expiresAt     DateTime
  createdAt     DateTime @default(now())

  @@unique([namespace, promptHash])            // exact-match idempotency
  @@index([namespace, expiresAt])
}

model UsageEvent {
  id           String   @id @default(cuid())
  namespace    String
  kind         String    // "embed" | "generate" | "hit"
  model        String
  inputTokens  Int       @default(0)
  outputTokens Int       @default(0)
  costUsd      Decimal   @default(0)            // spent (embed/generate) or saved (hit)
  hitType      String?   // "exact" | "semantic" | null
  latencyMs    Int
  createdAt    DateTime @default(now())
  @@index([namespace, createdAt])
}
```

`@@unique([namespace, promptHash])` gives exact-match idempotency the same DB-constraint way
CronHive used `@@unique` for fire-slot idempotency. The `vector(768)` column + ANN index are
created via a hand-written migration (Prisma stores it as `Unsupported`, similarity queries run
as raw parameterized SQL — the documented pgvector pattern).

---

## 6. Tech stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node + TypeScript (ESM)** | Same as CronHive/ChainPulse; your strongest area |
| API | **Express** | Same as the other projects; small, well-understood |
| Exact cache + rate limit | **Redis** | O(1) hash hits, token-bucket limits, LRU metadata |
| Vector store | **Postgres + pgvector** | One fewer dependency; real ANN; matches your stack |
| ORM | **Prisma 6** | Same as the other projects (raw SQL for vector ops) |
| AI | **Gemini** (`@google/genai`) | `gemini-embedding-2` (768-d) for embeds, `gemini-2.5-flash` default for generation; key in `.env` (`GEMINI_API_KEY`) |
| Metrics | **prom-client** | Same observability story |
| Logging | **pino** | Same as the other two |
| Tests | **Vitest + Testcontainers** | Real Postgres+pgvector & Redis in integration tests |
| Load test | **k6** (script + README numbers) | Produces the headline benchmark |
| Container | **multi-stage Dockerfile + docker-compose** | One-command `up` (proxy + pgvector + redis) |

### Verified API facts (grounded, not guessed)
- Embeddings: `ai.models.embedContent({ model: 'gemini-embedding-2', contents, config: { outputDimensionality: 768 } })`; supported dims 128–3072 (recommended 768/1536/3072), default 3072; for `gemini-embedding-2` task instructions go in the prompt rather than a `taskType` param. ([Google AI embeddings docs](https://ai.google.dev/gemini-api/docs/embeddings))
- Generation pricing for cost math (per 1M tokens): **Gemini 2.5 Flash** $0.30 in / $2.50 out; **2.5 Pro** $1.25 in / $10.00 out; **2.5 Flash-Lite** $0.10 in / $0.40 out. Pricing constants live in one config module and are cited in code comments so they're easy to update. ([Gemini pricing breakdown](https://developer.puter.com/tutorials/gemini-api-pricing/))
- Exact model IDs and request/response shapes will be re-verified against the official docs at the moment of writing the adapter (same "never guess the API" discipline used throughout).

---

## 7. Build phases (executed after you approve this doc)

1. **Phase 0 — Scaffold.** TS/ESM project, Express server, env config, Prisma + pgvector migration (`CREATE EXTENSION vector`, `CacheEntry`, `UsageEvent`), Redis client, Docker compose, lint/test wiring, `.env.example`.
2. **Phase 1 — Gemini adapter.** `Provider` interface; Gemini embed (`gemini-embedding-2`, 768-d) + generate (`gemini-2.5-flash`); token/cost accounting; graceful error handling. Verified against live docs.
3. **Phase 2 — Exact cache path.** Prompt normalization, SHA-256 keying, Redis store/lookup, negative-cache guard, `x-cache: bypass`.
4. **Phase 3 — Semantic path.** Embed → pgvector ANN search (raw SQL, namespace-filtered) → threshold decision → store-on-miss; cosine util; threshold config.
5. **Phase 4 — Eviction & TTL.** Per-entry TTL, LRU-by-capacity eviction, namespace isolation, hit-count + lastHitAt updates.
6. **Phase 5 — Streaming + proxy API.** `/v1/chat` and `/v1/chat/stream`; stream Gemini misses to the client, assemble + store on completion.
7. **Phase 6 — Observability + hardening.** prom-client metrics (hit rate, cached/uncached latency histograms, tokens/$ saved), pino logs with prompt redaction, deep `/health`, API-key auth, rate limiting, validation, payload limits.
8. **Phase 7 — Benchmark.** k6 mixed-workload script; capture real hit rate, p50/p99 cached vs uncached, $ saved → put the actual numbers in the README.
9. **Phase 8 — Tests + Docker + README + (optional) stats page.** Vitest unit + Testcontainers integration; CI; multi-stage non-root Docker; one-command compose; honest, benchmark-led README; optional read-only stats page.

Single local commit at the end (you push), same as CronHive/ChainPulse.

---

## 8. The portfolio story this completes

> **CronHive** — distributed job scheduler: exactly-once firing, leader election, safe locking.
> **ChainPulse** — real-time event-streaming pipeline: Redis Streams, backpressure, idempotent writes.
> **SemanticCache** — AI infrastructure: semantic caching proxy that cuts LLM latency & cost, with measured results.

Distributed-systems correctness, data-pipeline engineering, and applied-AI infrastructure —
three distinct, verifiable signals from one consistent engineer, each leading with real numbers.

---

_Sources for the grounded API/pricing facts above:_
- [Embeddings | Gemini API | Google AI for Developers](https://ai.google.dev/gemini-api/docs/embeddings)
- [Gemini Embedding 2 — Google Developers Blog](https://developers.googleblog.com/building-with-gemini-embedding-2/)
- [Gemini API Pricing breakdown (Jun 2026)](https://developer.puter.com/tutorials/gemini-api-pricing/)
