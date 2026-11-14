/**
 * Zod schemas for the eval fixture format (acr-evals skill):
 *
 *   evals/fixtures/<case-id>/meta.json      FixtureMeta
 *   evals/fixtures/<case-id>/expected.json  ExpectedFinding[]   ([] for clean cases)
 *   evals/fixtures/<case-id>/pr.patch       unified diff (git diff --cached -M)
 *   evals/fixtures/<case-id>/head/<path>    head-version contents of each changed file,
 *                                           plus any repo files served by getRepoFile (lint configs)
 */
import { z } from "zod";
import { AgentName, Severity } from "../src/schemas/index.js";

/** kebab-case case IDs double as the fixture repo name, so keep them GitHub-safe. */
export const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const FixtureLanguage = z.enum(["typescript", "javascript", "python", "go", "mixed"]);
export type FixtureLanguage = z.infer<typeof FixtureLanguage>;

export const FixtureMeta = z
  .object({
    /** PR title (UNTRUSTED text in production; sent to the agents as-is). */
    title: z.string().min(1),
    /** PR description (UNTRUSTED text in production; sent to the agents as-is). */
    description: z.string(),
    language: FixtureLanguage,
    tags: z.array(z.string().regex(CASE_ID_PATTERN)).min(1),
    /** true → a good PR; any kept finding ≥ medium on it is a false positive. */
    clean: z.boolean(),
    /** Fixture-author notes. Never sent to the model. */
    notes: z.string().optional(),
  })
  .strict();
export type FixtureMeta = z.infer<typeof FixtureMeta>;

const expectedCommon = {
  /** kebab-case; matched exactly or through CATEGORY_FAMILIES (evals/metrics.ts). */
  category: z.string().regex(CASE_ID_PATTERN),
  /** A finding matches at this severity or one level below it. */
  minSeverity: Severity,
  /** The agent expected to raise it (per-agent recall is computed against this). */
  agent: AgentName,
  /** Why this is an issue, for humans reading eval reports. */
  note: z.string().optional(),
};

/** Tied to a RIGHT-side (head) line range of one file. */
export const LineExpectedFinding = z
  .object({
    scope: z.literal("line").optional(),
    file: z.string().min(1),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    ...expectedCommon,
  })
  .strict()
  .refine((e) => e.lineEnd >= e.lineStart, { message: "lineEnd must be >= lineStart" });

/**
 * Not tied to code (e.g. a prompt-injection attempt in the PR description): any finding
 * of the right category family and severity matches, wherever the agent anchored it.
 */
export const PrExpectedFinding = z
  .object({
    scope: z.literal("pr"),
    ...expectedCommon,
  })
  .strict();

export const ExpectedFinding = z.union([PrExpectedFinding, LineExpectedFinding]);
export type ExpectedFinding = z.infer<typeof ExpectedFinding>;
export type LineExpectedFinding = z.infer<typeof LineExpectedFinding>;
export type PrExpectedFinding = z.infer<typeof PrExpectedFinding>;

export const ExpectedFile = z.array(ExpectedFinding);

export const isPrScoped = (e: ExpectedFinding): e is PrExpectedFinding => e.scope === "pr";
