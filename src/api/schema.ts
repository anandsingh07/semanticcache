import { z } from "zod";

// Request validation for the proxy. Kept small and clean — the proxy's contract is a single
// prompt + optional model + optional params, not the full Gemini request surface.

export const chatRequestSchema = z.object({
  prompt: z.string().min(1, "prompt is required").max(100_000),
  /** Optional generation model override (defaults to GEMINI_GENERATION_MODEL). */
  model: z.string().min(1).optional(),
  /** Optional generation params that participate in the cache key (e.g. temperature). */
  params: z.record(z.unknown()).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
