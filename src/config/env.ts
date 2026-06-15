import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),

  // --- Gemini ---
  /** Empty in dev is allowed; the proxy refuses live generation and says so clearly. */
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_GENERATION_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default("gemini-embedding-2"),
  /** Embedding vector length. Must match the vector(N) column in the migration. */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(768),

  // --- Cache behaviour ---
  /** Cosine similarity threshold for a semantic hit. */
  SEMANTIC_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
  /** Entry TTL in seconds. 0 disables expiry. */
  CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(86_400),
  /** Per-namespace capacity before LRU eviction. */
  CACHE_MAX_ENTRIES_PER_NAMESPACE: z.coerce.number().int().positive().default(10_000),
  DEFAULT_NAMESPACE: z.string().min(1).default("default"),

  // --- Auth & security ---
  /** Comma-separated API keys. Empty = auth disabled (dev only). */
  API_KEYS: z.string().default(""),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_048_576),
  STORE_PROMPT_TEXT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  // --- Observability ---
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  cached = parsed.data;
  return cached;
}

/** Parsed list of valid API keys (empty array = auth disabled). */
export function apiKeys(env: Env): string[] {
  return env.API_KEYS.split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
