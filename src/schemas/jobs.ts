import { z } from "zod";
import { AgentName, PrRef, Sha } from "./common.js";

/** Body POSTed by action/ai-review.yml to /hooks/pr. */
export const HookBody = PrRef.extend({ baseSha: Sha, headSha: Sha });
export type HookBody = z.infer<typeof HookBody>;

/**
 * Deterministic run ID. BullMQ rejects custom job IDs containing ":", so we use "__".
 * Owner/repo characters allowed by GitHub ([A-Za-z0-9._-]) never contain "__"-ambiguity that matters
 * for uniqueness because the SHA prefix and PR number are always present.
 */
export function runKey(ref: PrRef, headSha: string): string {
  return `${ref.owner}__${ref.repo}__${ref.pr}__${headSha.slice(0, 12)}`;
}

export const PrepareJob = HookBody.extend({ runId: z.string() });
export type PrepareJob = z.infer<typeof PrepareJob>;

export const AgentJob = z.object({ runId: z.string(), agent: AgentName, chunk: z.number().int().nonnegative() });
export type AgentJob = z.infer<typeof AgentJob>;

export const JudgeJob = z.object({ runId: z.string() });
export type JudgeJob = z.infer<typeof JudgeJob>;

export const PublishJob = z.object({ runId: z.string() });
export type PublishJob = z.infer<typeof PublishJob>;

export const Q = {
  prepare: "acr-prepare",
  agent: "acr-agent",
  judge: "acr-judge",
  publish: "acr-publish",
} as const;
