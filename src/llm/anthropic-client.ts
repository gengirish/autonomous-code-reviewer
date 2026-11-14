import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { AgentRefusedError, PermanentError, SchemaError } from "../core/errors.js";
import { logger as rootLogger, type Logger } from "../core/logger.js";
import type { LlmClient, LlmUsage, StructuredRequest, StructuredResult } from "../core/ports.js";
import { MAX_TOKENS, MODEL } from "./models.js";

/** Beta that enables `fallbacks: "default"` (server-side refusal fallback). */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicLlmClientOptions {
  /** Injected SDK client (tests pass one with a fake `fetch`). Default: `new Anthropic({ maxRetries: 2 })`, created lazily. */
  client?: Anthropic;
  logger?: Logger;
  /** Use the beta namespace with server-side refusal fallbacks. Default true. */
  fallbacks?: boolean;
}

/**
 * Result of our own parse step. The SDK's `parse()` runs the output format's `parse`
 * on every text block and throws on invalid JSON or a Zod failure, which would hide
 * `stop_reason` (a refusal or truncation would surface as a parse error). So the format
 * we pass never throws: it reports the outcome and keeps the raw text for the retry.
 */
type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string; raw: string };

/** The parts of a (beta or non-beta) parsed message we read. Both SDK types satisfy it. */
interface ParsedResponse<T> {
  model: string;
  stop_reason: string | null;
  stop_details: { category: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
  };
  parsed_output: ParseOutcome<T> | null;
}

const MAX_ISSUES = 8;
const MAX_ERROR_CHARS = 1_500;

/**
 * Structured outputs only support a subset of JSON Schema. `zodOutputFormat` already
 * moves unsupported constraints (minLength/maxLength, minimum/maximum/exclusiveMinimum,
 * maxItems, unsupported formats) into the property `description` and sets
 * `additionalProperties: false`, so the request is accepted; the constraints are then
 * enforced client-side by the Zod schema (our `parse` below). One JSON schema per Zod
 * schema object, so the bytes sent are identical across calls (cache prefix).
 */
const jsonSchemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();

function outputFormat<T>(schema: z.ZodType<T>) {
  let jsonSchema = jsonSchemaCache.get(schema);
  if (!jsonSchema) {
    jsonSchema = zodOutputFormat(schema).schema;
    jsonSchemaCache.set(schema, jsonSchema);
  }
  return {
    type: "json_schema" as const,
    schema: jsonSchema,
    parse: (text: string): ParseOutcome<T> => {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        return { ok: false, error: `Output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, raw: text };
      }
      const result = schema.safeParse(json);
      if (result.success) return { ok: true, value: result.data };
      const issues = result.error.issues
        .slice(0, MAX_ISSUES)
        .map((i) => `- ${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
      const more = result.error.issues.length > MAX_ISSUES ? `\n- … and ${result.error.issues.length - MAX_ISSUES} more` : "";
      return { ok: false, error: `${issues.join("\n")}${more}`, raw: text };
    },
  };
}

const correctionMessage = (error: string): string =>
  [
    "Your previous reply did not satisfy the required output schema:",
    error.slice(0, MAX_ERROR_CHARS),
    "",
    "Reply again with a single JSON object that satisfies the schema. Keep the same content and fix only what these errors describe (for example shorten an over-long string, drop the lowest-value array items to stay within a maximum, or keep numbers inside their range).",
  ].join("\n");

function mapError(err: unknown, label: string): unknown {
  // Retrying the identical request cannot fix these: fail the job without BullMQ retries.
  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.UnprocessableEntityError
  ) {
    return new PermanentError(`${label}: Anthropic API ${err.status ?? "?"}: ${err.message}`, { cause: err });
  }
  // RateLimitError, InternalServerError (5xx), APIConnectionError(+Timeout), anything else:
  // rethrow unchanged so BullMQ backs off and retries.
  return err;
}

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
  model: b.model,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

/** The real LlmClient: one structured-output Messages API call (plus at most one schema-correction retry). */
export class AnthropicLlmClient implements LlmClient {
  private sdk: Anthropic | undefined;
  private readonly log: Logger;
  private readonly fallbacks: boolean;

  constructor(opts: AnthropicLlmClientOptions = {}) {
    this.sdk = opts.client;
    this.log = opts.logger ?? rootLogger;
    this.fallbacks = opts.fallbacks ?? true;
  }

  /** Lazy so that importing/constructing never needs ANTHROPIC_API_KEY. */
  private get client(): Anthropic {
    this.sdk ??= new Anthropic({ maxRetries: 2 });
    return this.sdk;
  }

  async callStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = performance.now();
    const format = outputFormat(req.schema);

    // Cache layout (acr-llm): system → user context (breakpoint) → role system message.
    // Everything up to and including the user block is identical across the four agents.
    const userBlock: Anthropic.TextBlockParam = {
      type: "text",
      text: req.userContent,
      ...(req.cacheUserContent ? { cache_control: { type: "ephemeral" as const } } : {}),
    };
    // SystemMessageParam (`role: "system"`) is part of MessageParam in SDK 1.8: no cast needed.
    // It must follow a user message and be last or followed by an assistant turn.
    const base: Anthropic.MessageParam[] = [
      { role: "user", content: [userBlock] },
      ...(req.roleInstructions ? [{ role: "system" as const, content: req.roleInstructions }] : []),
    ];

    const first = await this.send(req, base, format);
    let usage = toUsage(first);
    const outcome = this.check(req, first);
    if (outcome.ok) return this.done(req, outcome.value, usage, first, started, 1);

    // One correction round: echo the invalid reply as the assistant turn, then a user turn
    // describing the validation error. [user, system?, assistant, user] keeps the mid-conversation
    // system message valid (followed by an assistant turn) and the request ending on a user turn
    // (no prefill). The cached prefix up to the context block is unchanged.
    this.log.warn({ label: req.label, runId: req.runId, stopReason: first.stop_reason }, "llm output failed schema validation; retrying once");
    const retryMessages: Anthropic.MessageParam[] = [
      ...base,
      { role: "assistant", content: outcome.raw.trim() || "(empty reply)" },
      { role: "user", content: correctionMessage(outcome.error) },
    ];
    const second = await this.send(req, retryMessages, format);
    usage = addUsage(usage, toUsage(second));
    const retried = this.check(req, second);
    if (retried.ok) return this.done(req, retried.value, usage, second, started, 2);

    this.log.error({ label: req.label, runId: req.runId }, "llm output failed schema validation after retry");
    throw new SchemaError(`${req.label}: output failed schema validation after one retry:\n${retried.error.slice(0, MAX_ERROR_CHARS)}`);
  }

  private async send<T>(
    req: StructuredRequest<T>,
    messages: Anthropic.MessageParam[],
    format: ReturnType<typeof outputFormat<T>>,
  ): Promise<ParsedResponse<T>> {
    // Opus 5.5: thinking is always on (no `thinking`, no budget), no temperature/top_p,
    // no forced tool_choice, no prefill. Depth is `output_config.effort`.
    const params = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: req.system,
      messages,
      output_config: { effort: req.effort, format },
    };
    try {
      if (this.fallbacks) {
        // SDK 1.8 has client.beta.messages.parse, accepting `betas`, `fallbacks` and
        // `output_config.format`. On a decline the API re-runs the call on the default
        // fallback model inside the same request; a final refusal still ends in stop_reason "refusal".
        return await this.client.beta.messages.parse({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
      }
      return await this.client.messages.parse(params);
    } catch (err) {
      throw mapError(err, req.label);
    }
  }

  /** Stop-reason checks come before reading any output. */
  private check<T>(req: StructuredRequest<T>, res: ParsedResponse<T>): ParseOutcome<T> {
    if (res.stop_reason === "refusal") {
      const category = res.stop_details?.category ?? null;
      this.log.warn({ label: req.label, runId: req.runId, category }, "llm refused");
      throw new AgentRefusedError(req.label, category);
    }
    if (res.stop_reason === "max_tokens") {
      // Plain Error: retryable by BullMQ.
      throw new Error(`${req.label}: output truncated at max_tokens (${MAX_TOKENS})`);
    }
    if (res.stop_reason === "model_context_window_exceeded") {
      throw new PermanentError(`${req.label}: request exceeds the model context window`);
    }
    return res.parsed_output ?? { ok: false, error: "The reply contained no JSON text output.", raw: "" };
  }

  private done<T>(
    req: StructuredRequest<T>,
    output: T,
    usage: LlmUsage,
    res: ParsedResponse<T>,
    started: number,
    attempts: number,
  ): StructuredResult<T> {
    const latencyMs = Math.round(performance.now() - started);
    const stopReason = res.stop_reason ?? "unknown";
    this.log.info(
      {
        label: req.label,
        runId: req.runId,
        model: usage.model,
        stopReason,
        attempts,
        latencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      "llm call",
    );
    return { output, usage, stopReason, latencyMs };
  }
}

function toUsage(res: ParsedResponse<unknown>): LlmUsage {
  return {
    // With fallbacks the reply may be served by another model; record who actually served it.
    model: res.model || MODEL,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
  };
}
