import { z } from "zod";

/** 40-char lowercase hex git SHA. */
export const Sha = z.string().regex(/^[0-9a-f]{40}$/, "expected a 40-char hex SHA");

export const PrRef = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
});
export type PrRef = z.infer<typeof PrRef>;

export const AgentName = z.enum(["security", "style", "coverage", "architecture"]);
export type AgentName = z.infer<typeof AgentName>;
export const AGENTS: readonly AgentName[] = AgentName.options;

export const Severity = z.enum(["critical", "high", "medium", "low", "nit"]);
export type Severity = z.infer<typeof Severity>;
/** Most severe first. */
export const SEVERITY_ORDER: readonly Severity[] = Severity.options;
export const severityRank = (s: Severity): number => SEVERITY_ORDER.indexOf(s);

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;

export const ReviewEvent = z.enum(["REQUEST_CHANGES", "COMMENT", "APPROVE"]);
export type ReviewEvent = z.infer<typeof ReviewEvent>;
