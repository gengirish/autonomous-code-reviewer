---
name: acr-llm
description: >-
  How ACR calls Claude: the src/llm client wrapper, model and effort settings,
  structured outputs with Zod, the prompt-caching layout shared by the four agents,
  refusal handling and fallbacks, typed errors and retries, and recording usage and
  cost per call. Use when editing src/llm/, changing a model or effort setting,
  debugging cache misses, refusals, schema failures or cost, or writing any new Claude call.
---

# LLM layer (src/llm)

For SDK details beyond this file, load the global **`claude-api`** skill (TypeScript
section) and verify against the installed `@anthropic-ai/sdk`. **Don't guess SDK method
names.** The collection's older copy of `claude-api` was deliberately not installed here.

## Settings (src/llm/models.ts): the only place model strings live

```ts
export const MODEL = "claude-opus-5-5";
export const AGENT_EFFORT = "medium" as const;   // SAME for all 4 agents (see caching)
export const JUDGE_EFFORT = "high" as const;
export const MAX_TOKENS = 16_000;                // non-streaming; agents stay well under this
```

Opus 5.5 specifics that bite:
- Thinking is always on. **Don't send `thinking: {type: "disabled"}` or `budget_tokens`** (both
  return 400). Depth is controlled by `output_config.effort`. The default is `medium`, so set
  it explicitly anyway.
- **No forced `tool_choice`** (`any`/`tool` return 400). We use structured outputs instead.
- No assistant prefill (400). No `temperature`/`top_p`.

## Structured call (src/llm/client.ts)

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const client = new Anthropic();   // ANTHROPIC_API_KEY from env

const res = await client.messages.parse({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  system: SHARED_SYSTEM,                                   // frozen string from prompts/_shared.md
  output_config: { effort: AGENT_EFFORT, format: zodOutputFormat(AgentReport) },
  messages: [
    { role: "user", content: [{ type: "text", text: renderedContext, cache_control: { type: "ephemeral" } }] },
    { role: "system", content: rolePrompt },               // mid-conversation system message: agent role
  ],
});
if (res.stop_reason === "refusal") throw new AgentRefusedError(res.stop_details?.category ?? null);
if (res.stop_reason === "max_tokens") throw new Error("agent output truncated");
const report = res.parsed_output;                          // null if parsing failed → one retry, then fail
```

Expose it as `callStructured({ system, context, role, schema, effort })` behind an
`LlmClient` interface so tests and evals can swap in `FakeLlm` (`acr-testing`).

## Caching layout: why the request looks like that

The four agents see the **same** PR context. Prompt caching is a byte-exact **prefix** match
over `system → messages`, so:

1. `system` = shared, frozen text (no dates or IDs). Identical for all 4.
2. First user message = rendered ReviewContext with the `cache_control` breakpoint. Identical for all 4.
3. **Agent-specific instructions come after the breakpoint**, as a mid-conversation
   `role: "system"` message (supported on Opus 5.5; it must follow a user message and be last).
4. The same `output_config.format` (one AgentReport schema) and **the same top-level effort**
   for all four. A different top-level `effort` per agent invalidates the messages cache, so the
   context gets re-written four times. If per-agent effort is ever needed, use the per-message
   effort system message (beta `mid-conversation-output-config-2026-07-01`) instead of a
   top-level change, and measure it.

**Warm-up:** a `max_tokens: 0` pre-warm is **rejected together with `output_config.format`**,
so don't use one. Start all four in parallel and check `usage.cache_read_input_tokens` on the
eval set. If most parallel calls miss, stagger the calls: start one agent, then the other
three once it returns. Decide from measured cost and latency, not assumptions.

Verify with `usage.cache_creation_input_tokens` / `cache_read_input_tokens`. If reads stay at
0, something in the prefix is varying: diff two request bodies (unsorted JSON, a timestamp,
or a different schema object).

## Refusals and fallbacks

The Security agent reviews exploit-shaped code, so safety-classifier refusals
(`stop_reason: "refusal"`, `stop_details.category` e.g. `cyber`) are a real possibility.
- Always check `stop_reason` before reading output.
- Server-side fallback: `betas: ["server-side-fallback-2026-07-01"]` with `fallbacks: "default"`
  on the **beta** messages namespace. In phase 3, check whether the installed SDK offers
  `client.beta.messages.parse`. If it doesn't, call `client.beta.messages.create` with
  `output_config.format` and parse with the Zod schema yourself.
- If it's still refused, the agent job fails as unrecoverable. The judge proceeds and the
  summary says "Security review unavailable for this change".
- Log refusal categories per run. A pattern of them is an eval-set signal.

## Errors

Most specific first: `Anthropic.BadRequestError` → `UnrecoverableError` (don't retry);
`Anthropic.RateLimitError` / `Anthropic.InternalServerError` / `Anthropic.APIConnectionError`
→ rethrow so BullMQ backs off. Set the SDK `maxRetries: 2` and keep the default timeout.
BullMQ attempts provide the outer retry.

## Usage and cost (src/llm/cost.ts)

Persist `usage` per call (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, model, agent, runId) to `LlmCall` (`acr-database`).

```ts
// Opus 5.5 per 1M tokens: input $4, output $20, cache read $0.20, 5-min cache write = 1.25 × input
// Source: claude-api skill model table (cached 2026-11-03). Re-check pricing before quoting numbers.
```

The review summary footer can show `cost ≈ $x.xx` only when `ACR_SHOW_COST=1` (demo).
