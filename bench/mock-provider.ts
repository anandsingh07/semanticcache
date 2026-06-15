import type {
  EmbedResult,
  GenerateResult,
  GenerateStreamChunk,
  GenerateStreamFinal,
  LLMProvider,
} from "../src/providers/types.js";

// Deterministic mock provider for benchmarking + integration tests WITHOUT a live Gemini
// key. It produces:
//   - a stable, semantically-meaningful embedding per text (bag-of-words hashed into a
//     fixed-dim vector), so paraphrases of the same intent land close in cosine space;
//   - a fixed answer + token counts per prompt;
//   - a configurable simulated latency for generation (to model the "slow miss" the cache
//     avoids), and ~0 latency for embeddings.
//
// This lets the benchmark measure the cache's OWN behaviour (hit rate, latency separation,
// $ saved) honestly — the numbers come from running the real cache code against a stand-in
// LLM, not from fabricated figures.

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "do", "i", "you", "to", "my", "how", "can", "what",
  "your", "of", "for", "me", "please", "with", "and", "in", "on", "it",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface MockOptions {
  dimensions?: number;
  generateLatencyMs?: number;
  inputPerM?: number;
  outputPerM?: number;
}

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  private readonly dim: number;
  private readonly genLatency: number;
  private readonly inputPerM: number;
  private readonly outputPerM: number;
  /** Counts real generations — i.e. cache misses that reached the "LLM". */
  generateCalls = 0;
  embedCalls = 0;

  constructor(opts: MockOptions = {}) {
    this.dim = opts.dimensions ?? 768;
    this.genLatency = opts.generateLatencyMs ?? 40;
    this.inputPerM = opts.inputPerM ?? 0.3;
    this.outputPerM = opts.outputPerM ?? 2.5;
  }

  async embed(text: string): Promise<EmbedResult> {
    this.embedCalls++;
    const vec = new Array<number>(this.dim).fill(0);
    const words = tokenize(text);
    for (const w of words) {
      // Each word contributes to a few dimensions; shared words -> similar vectors.
      const h = hashStr(w);
      vec[h % this.dim] += 1;
      vec[(h >>> 8) % this.dim] += 0.5;
    }
    // L2 normalize so cosine is meaningful.
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    const inputTokens = Math.max(1, words.length);
    return {
      vector: vec,
      model: "mock-embed",
      inputTokens,
      costUsd: (inputTokens / 1_000_000) * 0.15,
    };
  }

  async generate(prompt: string, model = "mock-gen"): Promise<GenerateResult> {
    this.generateCalls++;
    await sleep(this.genLatency);
    const inputTokens = Math.max(1, tokenize(prompt).length);
    const outputTokens = 120; // fixed-size answer
    return {
      text: `Answer to: ${prompt.slice(0, 60)}`,
      model,
      inputTokens,
      outputTokens,
      costUsd:
        (inputTokens / 1_000_000) * this.inputPerM +
        (outputTokens / 1_000_000) * this.outputPerM,
    };
  }

  async *generateStream(
    prompt: string,
    model = "mock-gen",
  ): AsyncGenerator<GenerateStreamChunk, GenerateStreamFinal, void> {
    const res = await this.generate(prompt, model);
    // Emit in a few chunks to exercise the streaming path.
    const words = res.text.split(" ");
    for (const w of words) yield { delta: w + " " };
    return {
      text: res.text,
      model: res.model,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      costUsd: res.costUsd,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
