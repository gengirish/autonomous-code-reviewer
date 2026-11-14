import type { ReviewContext } from "../../schemas/index.js";
import { capped, isTestPath, ranges, safe } from "./util.js";

const MAX_LINES = 25;

/** Per changed source file: its paired tests, whether any of them changed in this PR, and uncovered added lines. */
export function coverageHints(ctx: ReviewContext): string[] {
  const changed = new Set(ctx.files.map((f) => f.path));
  const changedTests = ctx.files.filter((f) => isTestPath(f.path)).map((f) => f.path);
  const pairs = new Map(ctx.testPairs.map((p) => [p.source, p.tests]));
  const uncovered = new Map((ctx.coverage ?? []).map((c) => [c.path, new Set(c.uncoveredLines)]));
  const out: string[] = [];

  out.push(
    changedTests.length > 0
      ? `- test files changed in this PR: ${changedTests.map((p) => safe(p)).join(", ")}`
      : "- no test files changed in this PR",
  );

  for (const f of ctx.files) {
    if (isTestPath(f.path) || f.addedLines.length === 0 || f.status === "removed") continue;
    const tests = pairs.get(f.path) ?? [];
    const touched = tests.filter((t) => changed.has(t));
    let line: string;
    if (tests.length === 0) line = `- ${safe(f.path)}: no paired test file found`;
    else if (touched.length > 0) line = `- ${safe(f.path)}: paired tests changed in this PR (${touched.map((t) => safe(t)).join(", ")})`;
    else line = `- ${safe(f.path)}: paired tests exist (${tests.map((t) => safe(t)).join(", ")}) but none changed in this PR`;

    const miss = uncovered.get(f.path);
    if (miss) {
      const notCovered = f.addedLines.filter((n) => miss.has(n));
      line += notCovered.length > 0 ? `; added lines not covered by tests: ${ranges(notCovered)}` : "; all added lines covered";
    }
    out.push(line);
  }
  if (!ctx.coverage) out.push("- no coverage data was provided for this run");
  return capped(out, MAX_LINES);
}
