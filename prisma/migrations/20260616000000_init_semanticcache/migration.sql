-- SemanticCache initial schema.
-- Requires the pgvector extension. The docker-compose image (pgvector/pgvector) ships it;
-- on a managed Postgres you may need a superuser to run CREATE EXTENSION once.
CREATE EXTENSION IF NOT EXISTS vector;

-- =========================================================================
-- cache_entries
-- =========================================================================
CREATE TABLE "cache_entries" (
    "id"           TEXT NOT NULL,
    "namespace"    TEXT NOT NULL,
    "promptHash"   TEXT NOT NULL,
    "prompt"       TEXT,
    "model"        TEXT NOT NULL,
    "answer"       TEXT NOT NULL,
    "embedding"    vector(768),
    "inputTokens"  INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd"      DECIMAL(12,8) NOT NULL DEFAULT 0,
    "hits"         INTEGER NOT NULL DEFAULT 0,
    "lastHitAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"    TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cache_entries_pkey" PRIMARY KEY ("id")
);

-- Exact-match idempotency: a given (namespace, promptHash) exists at most once.
CREATE UNIQUE INDEX "cache_entries_namespace_promptHash_key"
    ON "cache_entries" ("namespace", "promptHash");

CREATE INDEX "cache_entries_namespace_expiresAt_idx"
    ON "cache_entries" ("namespace", "expiresAt");

CREATE INDEX "cache_entries_namespace_lastHitAt_idx"
    ON "cache_entries" ("namespace", "lastHitAt");

-- Approximate-nearest-neighbour index for cosine similarity search.
-- HNSW gives good recall/latency without the IVFFlat "must train on data first" caveat.
-- vector_cosine_ops pairs with the <=> cosine-distance operator used in queries.
CREATE INDEX "cache_entries_embedding_hnsw_idx"
    ON "cache_entries"
    USING hnsw ("embedding" vector_cosine_ops);

-- =========================================================================
-- usage_events
-- =========================================================================
CREATE TABLE "usage_events" (
    "id"           TEXT NOT NULL,
    "namespace"    TEXT NOT NULL,
    "kind"         TEXT NOT NULL,
    "model"        TEXT NOT NULL,
    "inputTokens"  INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd"      DECIMAL(12,8) NOT NULL DEFAULT 0,
    "hitType"      TEXT,
    "latencyMs"    INTEGER NOT NULL DEFAULT 0,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "usage_events_namespace_createdAt_idx"
    ON "usage_events" ("namespace", "createdAt");

CREATE INDEX "usage_events_kind_createdAt_idx"
    ON "usage_events" ("kind", "createdAt");
