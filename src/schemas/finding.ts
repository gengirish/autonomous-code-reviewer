import { z } from "zod";
import { AgentName, Severity } from "./common.js";

/**
 * One issue raised by a specialist agent. This is also the LLM output shape
 * (inside AgentReport), so keep it simple. If structured outputs reject a
 * constraint, derive a relaxed wire schema in src/llm; don't loosen this one.
 */
export const Finding = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  severity: Severity,
  /** kebab-case, e.g. "sql-injection", "missing-test" */
  category: z.string().min(1),
  title: z.string().min(1).max(120),
  rationale: z.string().min(1),
  /** Exact code quoted from the context that the finding is about. */
  evidence: z.string(),
  suggestion: z.string().optional(),
  confidence: z.number().min(0).max(1),
});
export type Finding = z.infer<typeof Finding>;

/** The structured output of every specialist agent. One schema for all four. */
export const AgentReport = z.object({
  agent: AgentName,
  summary: z.string().max(600),
  findings: z.array(Finding).max(25),
});
export type AgentReport = z.infer<typeof AgentReport>;

/** A finding after the deterministic post-checks in src/agents/base.ts. */
export const CheckedFinding = Finding.extend({
  agent: AgentName,
  /** false → line is not on a RIGHT-side hunk line; summary only, never inline. */
  commentable: z.boolean(),
  /** true → `evidence` was not found in the hunk/symbol text; confidence already halved. */
  unverified: z.boolean(),
});
export type CheckedFinding = z.infer<typeof CheckedFinding>;
