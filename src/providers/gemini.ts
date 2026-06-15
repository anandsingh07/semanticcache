import { GoogleGenAI } from "@google/genai";
import { loadEnv } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { embeddingCostUsd, generationCostUsd } from "./pricing.js";
import {
  type EmbedResult,
  type GenerateResult,
  type GenerateStreamChunk,
  type GenerateStreamFinal,
  type LLMProvider,
  ProviderError,
} from "./types.js";

// Gemini adapter built on @google/genai (v1.52). API shapes verified against the SDK's
// runtime surface and Google's docs (2026-06-16):
//   - new GoogleGenAI({ apiKey })
//   - ai.models.embedContent({ model, contents, config: { outputDimensionality } })
//       -> response.embeddings[0].values
//   - ai.models.generateContent({ model, contents })
//       -> response.text ; usage in response.usageMetadata
//   - ai.models.generateContentStream({ model, contents }) -> async iterable of chunks
//
// gemini-embedding-2 takes task instructions in the prompt (no taskType param), default
// dim 3072, supported 128..3072 (we use 768 — recommended balance vs index size).

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";

  private readonly client: GoogleGenAI;
  private readonly embeddingModel: string;
  private readonly defaultGenerationModel: string;
  private readonly dimensions: number;

  constructor() {
    const env = loadEnv();
    if (!env.GEMINI_API_KEY) {
      // Construct anyway so the app can boot; calls will throw a clear error.
      logger.warn("GeminiProvider created without GEMINI_API_KEY; live calls will fail.");
    }
    this.client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    this.embeddingModel = env.GEMINI_EMBEDDING_MODEL;
    this.defaultGenerationModel = env.GEMINI_GENERATION_MODEL;
    this.dimensions = env.EMBEDDING_DIMENSIONS;
  }

  async embed(text: string): Promise<EmbedResult> {
    try {
      const res = await this.client.models.embedContent({
        model: this.embeddingModel,
        contents: text,
        config: { outputDimensionality: this.dimensions },
      });
      const values = res.embeddings?.[0]?.values;
      if (!values || values.length === 0) {
        throw new ProviderError("Gemini returned an empty embedding");
      }
      if (values.length !== this.dimensions) {
        // A dimension mismatch would silently break the vector(768) column / ANN index.
        throw new ProviderError(
          `embedding dimension mismatch: got ${values.length}, expected ${this.dimensions}`,
        );
      }
      // Embedding token usage isn't always returned; estimate from chars when absent.
      const inputTokens =
        (res as { usageMetadata?: { promptTokenCount?: number } }).usageMetadata
          ?.promptTokenCount ?? estimateTokens(text);
      return {
        vector: values,
        model: this.embeddingModel,
        inputTokens,
        costUsd: embeddingCostUsd(this.embeddingModel, inputTokens),
      };
    } catch (err) {
      throw wrapProviderError("embed", err);
    }
  }

  async generate(prompt: string, model?: string): Promise<GenerateResult> {
    const useModel = model ?? this.defaultGenerationModel;
    try {
      const res = await this.client.models.generateContent({
        model: useModel,
        contents: prompt,
      });
      const text = res.text ?? "";
      const usage = res.usageMetadata;
      const inputTokens = usage?.promptTokenCount ?? estimateTokens(prompt);
      const outputTokens = usage?.candidatesTokenCount ?? estimateTokens(text);
      return {
        text,
        model: useModel,
        inputTokens,
        outputTokens,
        costUsd: generationCostUsd(useModel, inputTokens, outputTokens),
      };
    } catch (err) {
      throw wrapProviderError("generate", err);
    }
  }

  async *generateStream(
    prompt: string,
    model?: string,
  ): AsyncGenerator<GenerateStreamChunk, GenerateStreamFinal, void> {
    const useModel = model ?? this.defaultGenerationModel;
    let full = "";
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const stream = await this.client.models.generateContentStream({
        model: useModel,
        contents: prompt,
      });
      for await (const chunk of stream) {
        const delta = chunk.text ?? "";
        if (delta) {
          full += delta;
          yield { delta };
        }
        // Usage metadata arrives on the final chunk(s); keep the latest.
        const usage = chunk.usageMetadata;
        if (usage) {
          inputTokens = usage.promptTokenCount ?? inputTokens;
          outputTokens = usage.candidatesTokenCount ?? outputTokens;
        }
      }
    } catch (err) {
      throw wrapProviderError("generateStream", err);
    }
    if (inputTokens === 0) inputTokens = estimateTokens(prompt);
    if (outputTokens === 0) outputTokens = estimateTokens(full);
    return {
      text: full,
      model: useModel,
      inputTokens,
      outputTokens,
      costUsd: generationCostUsd(useModel, inputTokens, outputTokens),
    };
  }
}

/**
 * Rough token estimate (~4 chars/token) used only when the API omits usage metadata, so
 * cost accounting degrades gracefully instead of recording nothing.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function wrapProviderError(op: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  // Treat 5xx / network blips as retryable; auth/4xx as not.
  const retryable = /\b(5\d\d|ECONNRESET|ETIMEDOUT|ENOTFOUND|unavailable|overloaded)\b/i.test(
    msg,
  );
  return new ProviderError(`gemini ${op} failed: ${msg}`, err, retryable);
}
