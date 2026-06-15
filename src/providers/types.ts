// Provider-agnostic interface. The cache core depends only on this, never on Gemini
// directly, so a second provider can be added by implementing LLMProvider — the design's
// "interface is provider-agnostic; Gemini adapter implemented" promise, kept honest.

export interface EmbedResult {
  /** The embedding vector. Length === configured EMBEDDING_DIMENSIONS. */
  vector: number[];
  model: string;
  inputTokens: number;
  /** USD spent on this embedding call. */
  costUsd: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** USD spent on this generation call. */
  costUsd: number;
}

/** One streamed chunk of generated text. */
export interface GenerateStreamChunk {
  /** Incremental text delta. */
  delta: string;
}

/** Returned once a stream completes, carrying the full text + usage for caching/accounting. */
export interface GenerateStreamFinal {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LLMProvider {
  readonly name: string;

  /** Embed a single piece of text for similarity search. */
  embed(text: string): Promise<EmbedResult>;

  /** Non-streaming generation (used internally / for simple requests). */
  generate(prompt: string, model?: string): Promise<GenerateResult>;

  /**
   * Streaming generation. Yields text deltas; the async generator's return value is the
   * final aggregate (full text + usage) so the caller can cache it once complete.
   */
  generateStream(
    prompt: string,
    model?: string,
  ): AsyncGenerator<GenerateStreamChunk, GenerateStreamFinal, void>;
}

/** Thrown when a provider call fails (network, auth, quota, safety block). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    /** True when retrying could plausibly succeed (5xx, network). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
