import { z } from "zod";
import { AgentName, Severity } from "./common.js";
import { Finding } from "./finding.js";

export const DropReason = z.enum(["duplicate", "not-supported-by-code", "out-of-scope", "low-value"]);
export type DropReason = z.infer<typeof DropReason>;

/** LLM output of the judge (one entry per input finding, merged duplicates share one entry). */
export const JudgedFinding = Finding.extend({
  /** Index into the judge input's flat finding list; merged findings list every index. */
  sourceIndexes: z.array(z.number().int().nonnegative()).min(1),
  sourceAgents: z.array(AgentName).min(1),
  kept: z.boolean(),
  dropReason: DropReason.optional(),
  finalSeverity: Severity,
});
export type JudgedFinding = z.infer<typeof JudgedFinding>;

export const JudgeOutput = z.object({
  findings: z.array(JudgedFinding),
  /** ≤ 120 words, no verdict wording (the verdict is decided in code). */
  summary: z.string().max(1200),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;
