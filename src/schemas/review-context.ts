import { z } from "zod";
import { Sha } from "./common.js";

/** FROZEN in phase 2. Changing this breaks agents, evals and fixtures; update all three together. */

export const SymbolInfo = z.object({
  kind: z.string(), // tree-sitter node type, e.g. "function_declaration"
  name: z.string(),
  startLine: z.number().int().positive(), // 1-based, RIGHT side
  endLine: z.number().int().positive(),
  body: z.string(),
});
export type SymbolInfo = z.infer<typeof SymbolInfo>;

export const Hunk = z.object({
  rightStart: z.number().int().nonnegative(), // 0 for deletion-only hunks
  rightEnd: z.number().int().nonnegative(),
  /** Raw hunk text including the @@ header and +/-/space prefixes. */
  text: z.string(),
  symbol: SymbolInfo.optional(),
});
export type Hunk = z.infer<typeof Hunk>;

export const ContextFile = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  language: z.string().nullable(), // "typescript" | "tsx" | "javascript" | "python" | "go" | null
  status: z.enum(["added", "modified", "renamed", "removed", "copied", "changed", "unchanged"]),
  /** RIGHT-side line numbers that may carry inline comments (added + context lines). Sorted. */
  commentableLines: z.array(z.number().int().positive()),
  /** RIGHT-side added lines. Sorted. */
  addedLines: z.array(z.number().int().positive()),
  hunks: z.array(Hunk),
  imports: z.array(z.string()),
  exports: z.array(z.string()),
});
export type ContextFile = z.infer<typeof ContextFile>;

export const ReviewContext = z.object({
  runId: z.string(),
  owner: z.string(),
  repo: z.string(),
  pr: z.number().int().positive(),
  headSha: Sha,
  baseSha: Sha,
  /** UNTRUSTED: author-controlled text. */
  title: z.string(),
  /** UNTRUSTED: author-controlled text. */
  description: z.string(),
  files: z.array(ContextFile),
  repoMap: z.array(z.object({ path: z.string(), symbols: z.array(z.string()), imports: z.array(z.string()) })),
  testPairs: z.array(z.object({ source: z.string(), tests: z.array(z.string()) })),
  lintConfigs: z.array(z.object({ path: z.string(), text: z.string() })),
  coverage: z.array(z.object({ path: z.string(), uncoveredLines: z.array(z.number().int().positive()) })).optional(),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  chunk: z.object({ index: z.number().int().nonnegative(), total: z.number().int().positive() }),
});
export type ReviewContext = z.infer<typeof ReviewContext>;
