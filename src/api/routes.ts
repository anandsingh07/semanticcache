import { Router } from "express";
import type { CacheCore } from "../cache/core.js";
import { chatRequestSchema } from "./schema.js";
import { logger } from "../lib/logger.js";

// Proxy routes. /v1/chat (JSON) and /v1/chat/stream (SSE) are the drop-in surface; the rest
// are stats endpoints powered by the UsageEvent ledger.

export function buildRouter(core: CacheCore): Router {
  const router = Router();

  // --- Non-streaming chat ---
  router.post("/v1/chat", async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const control = core.buildControl(req);
    const result = await core.resolve({
      prompt: parsed.data.prompt,
      model: parsed.data.model ?? defaultModel(),
      params: parsed.data.params,
      control,
    });
    // Surface cache outcome so clients/tests can see hit vs miss without parsing the body.
    res.setHeader("x-cache-outcome", result.outcome);
    if (result.similarity !== undefined) {
      res.setHeader("x-cache-similarity", result.similarity.toFixed(4));
    }
    res.json({
      answer: result.answer,
      model: result.model,
      outcome: result.outcome,
      similarity: result.similarity,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      },
    });
  });

  // --- Streaming chat (Server-Sent Events) ---
  router.post("/v1/chat/stream", async (req, res) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten().fieldErrors });
      return;
    }
    const control = core.buildControl(req);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
      const gen = core.resolveStream({
        prompt: parsed.data.prompt,
        model: parsed.data.model ?? defaultModel(),
        params: parsed.data.params,
        control,
      });
      let final;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          final = next.value;
          break;
        }
        res.write(`data: ${JSON.stringify({ delta: next.value.delta })}\n\n`);
      }
      // Final event carries the outcome + usage.
      res.write(
        `event: done\ndata: ${JSON.stringify({
          outcome: final.outcome,
          model: final.model,
          similarity: final.similarity,
          usage: {
            inputTokens: final.inputTokens,
            outputTokens: final.outputTokens,
            costUsd: final.costUsd,
          },
        })}\n\n`,
      );
      res.end();
    } catch (err) {
      logger.error({ err }, "stream failed");
      // If headers already sent, emit an SSE error event; otherwise a JSON 502.
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: "generation failed" })}\n\n`);
        res.end();
      } else {
        res.status(502).json({ error: "generation failed" });
      }
    }
  });

  return router;
}

function defaultModel(): string {
  // Imported lazily to keep this module test-friendly.
  return process.env.GEMINI_GENERATION_MODEL ?? "gemini-2.5-flash";
}
