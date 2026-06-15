import prisma from "../db/index.js";
import { costSavedUsd, costSpentUsd, tokensSaved } from "../lib/metrics.js";
import { logger } from "../lib/logger.js";

// Records spend (embed/generate) and savings (hit) into the UsageEvent ledger AND into the
// Prometheus counters in one place, so the DB ledger and the live metrics never drift.
// Best-effort: a logging failure must not break the request that already succeeded.

export type UsageKind = "embed" | "generate" | "hit";
export type HitType = "exact" | "semantic";

export interface SpendInput {
  namespace: string;
  kind: "embed" | "generate";
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface SavingInput {
  namespace: string;
  model: string;
  hitType: HitType;
  /** Output tokens the cached answer would have re-generated. */
  outputTokens: number;
  /** USD this hit avoided spending. */
  costUsd: number;
  latencyMs: number;
}

export async function recordSpend(input: SpendInput): Promise<void> {
  costSpentUsd.inc({ kind: input.kind }, input.costUsd);
  try {
    await prisma.usageEvent.create({
      data: {
        namespace: input.namespace,
        kind: input.kind,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd: input.costUsd,
        latencyMs: input.latencyMs,
      },
    });
  } catch (err) {
    logger.error({ err }, "failed to write spend UsageEvent (non-fatal)");
  }
}

export async function recordSaving(input: SavingInput): Promise<void> {
  costSavedUsd.inc({ hit_type: input.hitType }, input.costUsd);
  tokensSaved.inc(input.outputTokens);
  try {
    await prisma.usageEvent.create({
      data: {
        namespace: input.namespace,
        kind: "hit",
        model: input.model,
        outputTokens: input.outputTokens,
        costUsd: input.costUsd,
        hitType: input.hitType,
        latencyMs: input.latencyMs,
      },
    });
  } catch (err) {
    logger.error({ err }, "failed to write saving UsageEvent (non-fatal)");
  }
}
