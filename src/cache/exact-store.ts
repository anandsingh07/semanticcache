import type { Redis } from "ioredis";
import { loadEnv } from "../config/env.js";

// Exact-match cache, backed by Redis. This is the O(1) fast path: identical requests
// (after normalization) never pay for an embedding or a generation. Keyed by the SHA-256
// from normalize.ts, namespaced so tenants/use-cases don't collide.
//
// Stored value is the full cached answer + the metadata needed to (a) serve it and (b)
// account for the cost it avoided.

export interface ExactCacheValue {
  answer: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD this answer originally cost to generate (what a hit saves). */
  costUsd: number;
}

function redisKey(namespace: string, hash: string): string {
  return `sc:exact:${namespace}:${hash}`;
}

export class ExactStore {
  private readonly ttlSeconds: number;

  constructor(private readonly redis: Redis) {
    this.ttlSeconds = loadEnv().CACHE_TTL_SECONDS;
  }

  /** Returns the cached value or null on a miss. */
  async get(namespace: string, hash: string): Promise<ExactCacheValue | null> {
    const raw = await this.redis.get(redisKey(namespace, hash));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ExactCacheValue;
    } catch {
      // Corrupt entry — treat as a miss and let it be overwritten.
      return null;
    }
  }

  /**
   * Store an answer. Honors the configured TTL (0 = no expiry). Never call this for an
   * error/empty answer — the caller (negative-cache guard) is responsible for that check.
   */
  async set(namespace: string, hash: string, value: ExactCacheValue): Promise<void> {
    const key = redisKey(namespace, hash);
    const payload = JSON.stringify(value);
    if (this.ttlSeconds > 0) {
      await this.redis.set(key, payload, "EX", this.ttlSeconds);
    } else {
      await this.redis.set(key, payload);
    }
  }

  /** Remove an entry (used by tests and explicit invalidation). */
  async delete(namespace: string, hash: string): Promise<void> {
    await this.redis.del(redisKey(namespace, hash));
  }
}

/**
 * Negative-cache guard: decide whether an answer is safe to cache. We never cache empty
 * responses or obvious error/refusal markers — caching those would poison the cache and
 * keep serving a failure for the whole TTL.
 */
export function isCacheable(answer: string): boolean {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return false;
  return true;
}
