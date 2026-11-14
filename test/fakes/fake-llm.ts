import type { LlmClient, LlmUsage, StructuredRequest, StructuredResult } from "../../src/core/ports.js";
import { MODEL } from "../../src/llm/models.js";

export type Responder = (req: StructuredRequest<unknown>) => unknown | Promise<unknown>;

/**
 * LlmClient that returns programmed outputs and records every request.
 * Outputs are validated with the request's schema, exactly like the real client.
 */
export class FakeLlm implements LlmClient {
  readonly calls: StructuredRequest<unknown>[] = [];

  constructor(
    private readonly responder: Responder,
    private readonly usage: Partial<LlmUsage> = {},
  ) {}

  async callStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    const raw = await this.responder(req as StructuredRequest<unknown>);
    const output = req.schema.parse(raw);
    return {
      output,
      usage: {
        model: MODEL,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...this.usage,
      },
      stopReason: "end_turn",
      latencyMs: 1,
    };
  }

  callsFor(label: StructuredRequest<unknown>["label"]) {
    return this.calls.filter((c) => c.label === label);
  }
}

/** Convenience: respond by label with fixed values. */
export const byLabel =
  (map: Partial<Record<StructuredRequest<unknown>["label"], unknown | ((req: StructuredRequest<unknown>) => unknown)>>): Responder =>
  (req) => {
    const v = map[req.label];
    if (v === undefined) throw new Error(`FakeLlm: no response programmed for ${req.label}`);
    return typeof v === "function" ? (v as (r: StructuredRequest<unknown>) => unknown)(req) : v;
  };
