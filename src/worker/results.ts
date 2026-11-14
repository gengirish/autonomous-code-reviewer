import { z } from "zod";
import { AgentName, AgentReport, CheckedFinding, JudgedFinding, PrRef, ReviewEvent, Sha } from "../schemas/index.js";

/**
 * Job return values. They travel through Redis as JSON, so the consumer (judge, publish)
 * Zod-parses them like any other boundary.
 */
export const Superseded = z.object({ superseded: z.literal(true) });
export type Superseded = z.infer<typeof Superseded>;
export const SUPERSEDED: Superseded = { superseded: true };

export const AgentResultOk = z.object({
  superseded: z.literal(false),
  agent: AgentName,
  chunk: z.number().int().nonnegative(),
  report: AgentReport,
  checked: z.array(CheckedFinding),
  costUsd: z.number().nonnegative(),
});
export type AgentResultOk = z.infer<typeof AgentResultOk>;
export const AgentResult = z.discriminatedUnion("superseded", [Superseded, AgentResultOk]);
export type AgentResult = z.infer<typeof AgentResult>;

export const ReviewComment = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  startLine: z.number().int().positive().optional(),
  side: z.literal("RIGHT"),
  body: z.string(),
});

export const JudgeResultOk = z.object({
  superseded: z.literal(false),
  ref: PrRef,
  headSha: Sha,
  event: ReviewEvent,
  body: z.string(),
  comments: z.array(ReviewComment),
  /** Indexes into `judged`. */
  inlineFindingIndexes: z.array(z.number().int().nonnegative()),
  judged: z.array(JudgedFinding),
  failedAgents: z.array(AgentName),
  /** Agents + judge. */
  costUsd: z.number().nonnegative(),
  chunks: z.number().int().positive(),
});
export type JudgeResultOk = z.infer<typeof JudgeResultOk>;
export const JudgeResult = z.discriminatedUnion("superseded", [Superseded, JudgeResultOk]);
export type JudgeResult = z.infer<typeof JudgeResult>;

export const PublishResultOk = z.object({
  superseded: z.literal(false),
  reviewId: z.number().int(),
  inlinePosted: z.number().int().nonnegative(),
  /** true when a review for this SHA already existed (nothing was posted). */
  existing: z.boolean(),
});
export type PublishResultOk = z.infer<typeof PublishResultOk>;
export type PublishResult = Superseded | PublishResultOk;
