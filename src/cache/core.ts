import { randomUUID } from "node:crypto";
import { loadEnv } from "../config/env.js";
import { logger } from "../lib/logger.js";
import {
  evictionsTotal,
  requestDuration,
  requestsTotal,
  semanticSimilarity,
} from "../lib/metrics.js";
import type { LLMProvider, GenerateStreamChunk } from "../providers/types.js";
import { getRedis } from "../lib/redis.js";
import { ExactStore, isCacheable, type ExactCacheValue } from "./exact-store.js";
import { cacheKeyHash, type CacheKeyParts } from "./normalize.js";
import { parseCacheControl, type CacheControl } from "./cache-control.js";
import type { Request } from "express";
import { findNearest, insertEntry, recordHit } from "../db/vector.js";
import { enforceCapacity } from "./eviction.js";
import { recordSaving, recordSpend } from "./usage.js";

// The cache core. Orchestrates the full lookup pipeline once, used by both the
// non-streaming and streaming endpoints:
//
//   1. exact-match (Redis)         -> hit: serve, log saving, done
//   2. embed prompt (Gemini)       -> always needed for the semantic path
//   3. semantic ANN (pgvector)     -> >= threshold: serve, log saving, done
//   4. miss: generate (Gemini)     -> serve, then store in both tiers, log spend
//
// `bypassRead` skips steps 1 & 3; `noStore` skips the store at the end.

export type Outcome = "exact_hit" | "semantic_hit" | "miss" | "error";

export interface ResolveContext {
  prompt: string;
  model: string;
  params?: Record<string, unknown>;
  control: CacheControl;
}

export interface ResolveResult {
  outcome: Outcome;
  answer: string;
  model: string;
  /** Cosine similarity of the served semantic hit, if applicable. */
  similarity?: number;
  inputTokens: number;
  outputTokens: number;
  /** USD spent (miss) or saved (hit) by this request. */
  costUsd: number;
}

export class CacheCore {
  private readonly exact: ExactStore;
  private readonly threshold: number;
  private readonly ttlSeconds: number;
  private readonly storePromptText: boolean;

  constructor(private readonly provider: LLMProvider) {
    const env = loadEnv();
    this.exact = new ExactStore(getRedis());
    this.threshold = env.SEMANTIC_THRESHOLD;
    this.ttlSeconds = env.CACHE_TTL_SECONDS;
    this.storePromptText = env.STORE_PROMPT_TEXT;
  }

  buildControl(req: Request): CacheControl {
    return parseCacheControl(req);
  }

  /** Non-streaming resolve: returns the full answer (from cache or freshly generated). */
  async resolve(ctx: ResolveContext): Promise<ResolveResult> {
    const start = performance.now();
    const keyParts: CacheKeyParts = {
      prompt: ctx.prompt,
      model: ctx.model,
      params: ctx.params,
    };
    const hash = cacheKeyHash(keyParts);
    const ns = ctx.control.namespace;
    const threshold = ctx.control.threshold ?? this.threshold;

    try {
      // 1. Exact match.
      if (!ctx.control.bypassRead) {
        const exact = await this.exact.get(ns, hash);
        if (exact) {
          const latencyMs = Math.round(performance.now() - start);
          await recordSaving({
            namespace: ns,
            model: exact.model,
            hitType: "exact",
            outputTokens: exact.outputTokens,
            costUsd: exact.costUsd,
            latencyMs,
          });
          this.finish("exact_hit", ns, start);
          return this.fromExact("exact_hit", exact);
        }
      }

      // 2. Embed for semantic search (needed even on a write-only path so we can store).
      const embedStart = performance.now();
      const embed = await this.provider.embed(ctx.prompt);
      await recordSpend({
        namespace: ns,
        kind: "embed",
        model: embed.model,
        inputTokens: embed.inputTokens,
        outputTokens: 0,
        costUsd: embed.costUsd,
        latencyMs: Math.round(performance.now() - embedStart),
      });

      // 3. Semantic match.
      if (!ctx.control.bypassRead) {
        const nearest = await findNearest(ns, embed.vector, 1);
        const top = nearest[0];
        if (top) {
          semanticSimilarity.observe(top.similarity);
          if (top.similarity >= threshold) {
            const latencyMs = Math.round(performance.now() - start);
            const costUsd = Number(top.costUsd);
            await recordHit(top.id);
            await recordSaving({
              namespace: ns,
              model: top.model,
              hitType: "semantic",
              outputTokens: top.outputTokens,
              costUsd,
              latencyMs,
            });
            this.finish("semantic_hit", ns, start);
            return {
              outcome: "semantic_hit",
              answer: top.answer,
              model: top.model,
              similarity: top.similarity,
              inputTokens: top.inputTokens,
              outputTokens: top.outputTokens,
              costUsd,
            };
          }
        }
      }

      // 4. Miss — generate.
      const genStart = performance.now();
      const gen = await this.provider.generate(ctx.prompt, ctx.model);
      await recordSpend({
        namespace: ns,
        kind: "generate",
        model: gen.model,
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        costUsd: gen.costUsd,
        latencyMs: Math.round(performance.now() - genStart),
      });

      if (!ctx.control.noStore && isCacheable(gen.text)) {
        await this.store(ns, hash, ctx.prompt, embed.vector, {
          answer: gen.text,
          model: gen.model,
          inputTokens: gen.inputTokens,
          outputTokens: gen.outputTokens,
          costUsd: gen.costUsd,
        });
      }

      this.finish("miss", ns, start);
      return {
        outcome: "miss",
        answer: gen.text,
        model: gen.model,
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        costUsd: gen.costUsd,
      };
    } catch (err) {
      requestsTotal.inc({ outcome: "error", namespace: ns });
      requestDuration.observe({ outcome: "error" }, (performance.now() - start) / 1000);
      logger.error({ err, namespace: ns }, "resolve failed");
      throw err;
    }
  }

  /**
   * Streaming resolve. On a cache hit, yields the cached answer as a single chunk (it's
   * already complete). On a miss, streams Gemini deltas live, then stores the full answer
   * once the stream completes. Returns the final result for accounting/headers.
   */
  async *resolveStream(
    ctx: ResolveContext,
  ): AsyncGenerator<GenerateStreamChunk, ResolveResult, void> {
    const start = performance.now();
    const keyParts: CacheKeyParts = {
      prompt: ctx.prompt,
      model: ctx.model,
      params: ctx.params,
    };
    const hash = cacheKeyHash(keyParts);
    const ns = ctx.control.namespace;
    const threshold = ctx.control.threshold ?? this.threshold;

    // 1. Exact.
    if (!ctx.control.bypassRead) {
      const exact = await this.exact.get(ns, hash);
      if (exact) {
        yield { delta: exact.answer };
        const latencyMs = Math.round(performance.now() - start);
        await recordSaving({
          namespace: ns,
          model: exact.model,
          hitType: "exact",
          outputTokens: exact.outputTokens,
          costUsd: exact.costUsd,
          latencyMs,
        });
        this.finish("exact_hit", ns, start);
        return this.fromExact("exact_hit", exact);
      }
    }

    // 2. Embed.
    const embedStart = performance.now();
    const embed = await this.provider.embed(ctx.prompt);
    await recordSpend({
      namespace: ns,
      kind: "embed",
      model: embed.model,
      inputTokens: embed.inputTokens,
      outputTokens: 0,
      costUsd: embed.costUsd,
      latencyMs: Math.round(performance.now() - embedStart),
    });

    // 3. Semantic.
    if (!ctx.control.bypassRead) {
      const nearest = await findNearest(ns, embed.vector, 1);
      const top = nearest[0];
      if (top) {
        semanticSimilarity.observe(top.similarity);
        if (top.similarity >= threshold) {
          yield { delta: top.answer };
          const latencyMs = Math.round(performance.now() - start);
          const costUsd = Number(top.costUsd);
          await recordHit(top.id);
          await recordSaving({
            namespace: ns,
            model: top.model,
            hitType: "semantic",
            outputTokens: top.outputTokens,
            costUsd,
            latencyMs,
          });
          this.finish("semantic_hit", ns, start);
          return {
            outcome: "semantic_hit",
            answer: top.answer,
            model: top.model,
            similarity: top.similarity,
            inputTokens: top.inputTokens,
            outputTokens: top.outputTokens,
            costUsd,
          };
        }
      }
    }

    // 4. Miss — stream generation, accumulate, store on completion.
    const genStart = performance.now();
    const stream = this.provider.generateStream(ctx.prompt, ctx.model);
    let final;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        final = next.value;
        break;
      }
      yield next.value;
    }
    await recordSpend({
      namespace: ns,
      kind: "generate",
      model: final.model,
      inputTokens: final.inputTokens,
      outputTokens: final.outputTokens,
      costUsd: final.costUsd,
      latencyMs: Math.round(performance.now() - genStart),
    });

    if (!ctx.control.noStore && isCacheable(final.text)) {
      await this.store(ns, hash, ctx.prompt, embed.vector, {
        answer: final.text,
        model: final.model,
        inputTokens: final.inputTokens,
        outputTokens: final.outputTokens,
        costUsd: final.costUsd,
      });
    }

    this.finish("miss", ns, start);
    return {
      outcome: "miss",
      answer: final.text,
      model: final.model,
      inputTokens: final.inputTokens,
      outputTokens: final.outputTokens,
      costUsd: final.costUsd,
    };
  }

  /** Write an entry to both tiers (Redis exact + pgvector semantic) and enforce capacity. */
  private async store(
    namespace: string,
    hash: string,
    prompt: string,
    embedding: number[],
    value: ExactCacheValue,
  ): Promise<void> {
    const expiresAt =
      this.ttlSeconds > 0 ? new Date(Date.now() + this.ttlSeconds * 1000) : null;
    await this.exact.set(namespace, hash, value);
    await insertEntry({
      id: randomUUID(),
      namespace,
      promptHash: hash,
      prompt: this.storePromptText ? prompt : null,
      model: value.model,
      answer: value.answer,
      embedding,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      costUsd: value.costUsd,
      expiresAt,
    });
    const evicted = await enforceCapacity(namespace);
    if (evicted > 0) evictionsTotal.inc(evicted);
  }

  private fromExact(outcome: "exact_hit", v: ExactCacheValue): ResolveResult {
    return {
      outcome,
      answer: v.answer,
      model: v.model,
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      costUsd: v.costUsd,
    };
  }

  private finish(outcome: Outcome, namespace: string, start: number): void {
    requestsTotal.inc({ outcome, namespace });
    requestDuration.observe({ outcome }, (performance.now() - start) / 1000);
  }
}
