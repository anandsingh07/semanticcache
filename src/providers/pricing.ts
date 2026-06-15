// Gemini API pricing, USD per 1,000,000 tokens.
//
// Verified against Google's published pricing on 2026-06-16. Pricing changes over time —
// this is the single place to update it, and it is the source of truth for all cost/savings
// accounting in the cache. Sources:
//   https://ai.google.dev/gemini-api/docs/pricing
//   https://developer.puter.com/tutorials/gemini-api-pricing/  (Jun 2026 breakdown)
//
// If a model is not listed, cost is computed as 0 and a warning is logged once — the cache
// still works, it just can't price that model until you add it here.

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

const PER_MILLION = 1_000_000;

export const GENERATION_PRICING: Record<string, ModelPrice> = {
  "gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 10.0 },
  "gemini-2.5-flash": { inputPerM: 0.3, outputPerM: 2.5 },
  "gemini-2.5-flash-lite": { inputPerM: 0.1, outputPerM: 0.4 },
};

// Embedding models are billed on input tokens only (no generated output).
export const EMBEDDING_PRICING: Record<string, ModelPrice> = {
  // gemini-embedding-2 / -001 input pricing (per 1M input tokens).
  "gemini-embedding-2": { inputPerM: 0.15, outputPerM: 0 },
  "gemini-embedding-001": { inputPerM: 0.15, outputPerM: 0 },
};

const unknownModelsWarned = new Set<string>();

function priceLookup(
  table: Record<string, ModelPrice>,
  model: string,
): ModelPrice | null {
  return table[model] ?? null;
}

/** Cost in USD of a generation call. Returns 0 for an unpriced model. */
export function generationCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = priceLookup(GENERATION_PRICING, model);
  if (!price) {
    warnUnknown("generation", model);
    return 0;
  }
  return (
    (inputTokens / PER_MILLION) * price.inputPerM +
    (outputTokens / PER_MILLION) * price.outputPerM
  );
}

/** Cost in USD of an embedding call (input tokens only). */
export function embeddingCostUsd(model: string, inputTokens: number): number {
  const price = priceLookup(EMBEDDING_PRICING, model);
  if (!price) {
    warnUnknown("embedding", model);
    return 0;
  }
  return (inputTokens / PER_MILLION) * price.inputPerM;
}

function warnUnknown(kind: string, model: string): void {
  const key = `${kind}:${model}`;
  if (unknownModelsWarned.has(key)) return;
  unknownModelsWarned.add(key);
  // Lazy import to avoid a cycle (logger imports env, not pricing).
  void import("../lib/logger.js").then(({ logger }) =>
    logger.warn(
      { kind, model },
      "no pricing entry for model; cost will be recorded as $0 until added to pricing.ts",
    ),
  );
}

/** Exposed for tests: reset the one-time warning memo. */
export function _resetPricingWarnings(): void {
  unknownModelsWarned.clear();
}
