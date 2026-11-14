import Anthropic from "@anthropic-ai/sdk";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { StructuredRequest } from "../../../src/core/ports.js";
import { AgentRefusedError, PermanentError, SchemaError } from "../../../src/core/errors.js";
import { AnthropicLlmClient, FALLBACK_BETA, MAX_TOKENS, MODEL } from "../../../src/llm/index.js";
import { AgentReport } from "../../../src/schemas/index.js";
import { aReport } from "../../fakes/builders.js";

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Reply = { status?: number; json: unknown };

/** Fake `fetch` for the SDK: records each request and returns the scripted replies in order. */
function fakeFetch(replies: Reply[]) {
  const requests: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = replies.shift();
    if (!reply) throw new Error("fakeFetch: no reply scripted");
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", "request-id": "req_test" },
    });
  };
  return { fetch, requests };
}

const message = (o: { text?: string; stop_reason?: string; stop_details?: unknown; usage?: Record<string, unknown> } = {}) => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: MODEL,
  content: o.text === undefined ? [] : [{ type: "text", text: o.text, citations: null }],
  stop_reason: o.stop_reason ?? "end_turn",
  stop_sequence: null,
  stop_details: o.stop_details ?? null,
  usage: {
    input_tokens: 120,
    output_tokens: 80,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: null,
    ...o.usage,
  },
});

const apiError = (status: number, type: string) => ({ status, json: { type: "error", error: { type, message: `${type} happened` } } });

const silent = pino({ level: "silent" });

function setup(replies: Reply[], opts: { fallbacks?: boolean } = {}) {
  const f = fakeFetch(replies);
  const client = new Anthropic({ apiKey: "test", fetch: f.fetch, maxRetries: 0 });
  return { llm: new AnthropicLlmClient({ client, logger: silent, ...opts }), requests: f.requests };
}

const request = (o: Partial<StructuredRequest<AgentReport>> = {}): StructuredRequest<AgentReport> => ({
  label: "security",
  runId: "run-1",
  system: "SHARED SYSTEM",
  userContent: "<pr_context>diff</pr_context>",
  cacheUserContent: true,
  roleInstructions: "ROLE: security",
  schema: AgentReport,
  effort: "medium",
  ...o,
});

const valid = JSON.stringify(aReport());

describe("AnthropicLlmClient", () => {
  it("parses a structured reply and maps usage (null cache fields → 0)", async () => {
    const { llm } = setup([{ json: message({ text: valid }) }]);
    const res = await llm.callStructured(request());
    expect(res.output).toEqual(aReport());
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({ model: MODEL, inputTokens: 120, outputTokens: 80, cacheReadTokens: 5000, cacheWriteTokens: 0 });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends the cache layout and Opus 5.5-safe parameters", async () => {
    const { llm, requests } = setup([{ json: message({ text: valid }) }]);
    await llm.callStructured(request());
    const { body, headers } = requests[0]!;

    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(MAX_TOKENS);
    expect(body.system).toBe("SHARED SYSTEM");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "<pr_context>diff</pr_context>", cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "ROLE: security" },
    ]);
    const outputConfig = body.output_config as { effort: string; format: { type: string; schema: Record<string, unknown>; parse?: unknown } };
    expect(outputConfig.effort).toBe("medium");
    expect(outputConfig.format.type).toBe("json_schema");
    expect(outputConfig.format.schema.additionalProperties).toBe(false);
    expect(outputConfig.format).not.toHaveProperty("parse");
    for (const banned of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "tools"]) expect(body).not.toHaveProperty(banned);

    // Fallbacks are on by default: beta namespace (anthropic-beta header) + fallbacks: "default".
    expect(headers.get("anthropic-beta")).toContain(FALLBACK_BETA);
    expect(body.fallbacks).toBe("default");
  });

  it("uses the plain namespace without fallbacks when disabled, and omits optional parts", async () => {
    const { llm, requests } = setup([{ json: message({ text: valid }) }], { fallbacks: false });
    await llm.callStructured(request({ cacheUserContent: false, roleInstructions: undefined, effort: "high" }));
    const { body, headers } = requests[0]!;
    expect(headers.get("anthropic-beta")).toBeNull();
    expect(body).not.toHaveProperty("fallbacks");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "<pr_context>diff</pr_context>" }] }]);
    expect((body.output_config as { effort: string }).effort).toBe("high");
  });

  it("produces a byte-identical request prefix for identical inputs", async () => {
    const { llm, requests } = setup([{ json: message({ text: valid }) }, { json: message({ text: valid }) }]);
    await llm.callStructured(request({ roleInstructions: "ROLE: style", label: "style" }));
    await llm.callStructured(request({ roleInstructions: "ROLE: coverage", label: "coverage" }));
    const strip = (b: Record<string, unknown>) => JSON.stringify({ ...b, messages: (b.messages as unknown[]).slice(0, 1) });
    expect(strip(requests[0]!.body)).toBe(strip(requests[1]!.body));
  });

  it("throws AgentRefusedError on a refusal before trying to parse", async () => {
    const { llm } = setup([{ json: message({ text: "I can't help with that.", stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }) }]);
    const err = await llm.callStructured(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentRefusedError);
    expect(err).toMatchObject({ label: "security", category: "cyber" });
  });

  it("refusal without stop_details has a null category", async () => {
    const { llm } = setup([{ json: message({ stop_reason: "refusal" }) }]);
    await expect(llm.callStructured(request())).rejects.toMatchObject({ category: null });
  });

  it("throws a retryable (non-permanent) error on max_tokens", async () => {
    const { llm } = setup([{ json: message({ text: '{"agent":"secu', stop_reason: "max_tokens" }) }]);
    const err = await llm.callStructured(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentError);
    expect((err as Error).message).toMatch(/max_tokens/);
  });

  it("retries once with a correction turn, then throws SchemaError", async () => {
    const invalid = JSON.stringify({ ...aReport(), findings: [{ ...aReport().findings[0], confidence: 3 }] });
    const { llm, requests } = setup([{ json: message({ text: invalid }) }, { json: message({ text: "not json" }) }]);
    await expect(llm.callStructured(request())).rejects.toBeInstanceOf(SchemaError);
    expect(requests).toHaveLength(2);

    const retry = requests[1]!.body.messages as Array<{ role: string; content: unknown }>;
    expect(retry.map((m) => m.role)).toEqual(["user", "system", "assistant", "user"]);
    expect(retry.slice(0, 2)).toEqual(requests[0]!.body.messages);
    expect(retry[2]!.content).toBe(invalid);
    expect(String(retry[3]!.content)).toMatch(/findings\.0\.confidence/);
  });

  it("succeeds on the retry and sums usage across both calls", async () => {
    const { llm } = setup([{ json: message({ text: "{}" }) }, { json: message({ text: valid, usage: { cache_creation_input_tokens: 10 } }) }]);
    const res = await llm.callStructured(request());
    expect(res.output).toEqual(aReport());
    expect(res.usage).toMatchObject({ inputTokens: 240, outputTokens: 160, cacheReadTokens: 10_000, cacheWriteTokens: 10 });
  });

  it("treats a reply with no text block as invalid output (retry, then SchemaError)", async () => {
    const { llm, requests } = setup([{ json: message() }, { json: message() }]);
    await expect(llm.callStructured(request())).rejects.toBeInstanceOf(SchemaError);
    const retry = requests[1]!.body.messages as Array<{ role: string; content: unknown }>;
    expect(retry[2]).toEqual({ role: "assistant", content: "(empty reply)" });
  });

  it("wraps a 400 as PermanentError", async () => {
    const { llm } = setup([apiError(400, "invalid_request_error")]);
    const err = await llm.callStructured(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err).not.toBeInstanceOf(AgentRefusedError);
    expect((err as Error).cause).toBeInstanceOf(Anthropic.BadRequestError);
  });

  it("rethrows rate limits and 5xx unchanged so the queue retries", async () => {
    const rl = setup([apiError(429, "rate_limit_error")]);
    await expect(rl.llm.callStructured(request())).rejects.toBeInstanceOf(Anthropic.RateLimitError);
    const ise = setup([apiError(529, "overloaded_error")]);
    const err = await ise.llm.callStructured(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.InternalServerError);
    expect(err).not.toBeInstanceOf(PermanentError);
  });
});
