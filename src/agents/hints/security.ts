import type { ReviewContext } from "../../schemas/index.js";
import { looksLikeInjection, scanDangerousApis, scanSqlBuilding } from "./code-patterns.js";
import { scanSecrets } from "./secrets.js";
import { addedLines, capped, isTestPath, safe } from "./util.js";

const MAX_LINES = 25;

const DEP_MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Gemfile|Cargo\.toml)$/;
const DEP_LINE = /^\s*"(@?[\w./-]+)"\s*:\s*"([^"]+)"|^\s*([A-Za-z][\w.-]*)\s*(?:==|>=|~=|<=|>|<)|^\s*require\s+([\w./-]+)\s+v/;
const VERSION_SPEC = /^(?:[~^<>=v\s]*\d|\*|latest|next|workspace:|npm:)/;
const NON_REGISTRY = /^(?:git\+|git:|github:|https?:|file:|link:)|\.git(?:#|$)|^[\w-]+\/[\w.-]+(?:#|$)/;

/** Secrets, dangerous sinks, SQL string building, dependency additions and reviewer-steering text. */
export function securityHints(ctx: ReviewContext): string[] {
  const lines = addedLines(ctx.files);
  const where = (file: string, line: number) => `${safe(file)}:${line}${isTestPath(file) ? " (test path)" : ""}`;
  const out: string[] = [];

  for (const h of scanSecrets(lines)) out.push(`- possible secret (${h.kind}) at ${where(h.file, h.line)}`);
  for (const h of scanSqlBuilding(lines)) out.push(`- ${h.kind} at ${where(h.file, h.line)}`);
  for (const h of scanDangerousApis(lines)) out.push(`- dangerous API: ${h.kind} at ${where(h.file, h.line)}`);

  for (const l of lines) {
    if (!DEP_MANIFEST.test(l.file)) continue;
    const m = DEP_LINE.exec(l.text);
    const name = m?.[1] ?? m?.[3] ?? m?.[4];
    if (!name || /^(name|version|description|main|type|scripts|license)$/.test(name)) continue;
    const spec = m?.[2];
    // package.json: only "name": "<version or source>" pairs, not scripts or other fields.
    if (spec !== undefined && !VERSION_SPEC.test(spec) && !NON_REGISTRY.test(spec)) continue;
    const source = spec && NON_REGISTRY.test(spec) ? " from a non-registry source" : "";
    out.push(`- dependency added or changed${source}: ${safe(name, 80)} at ${where(l.file, l.line)}`);
  }

  // Reported by location only: the text itself stays in <pr_context>, never in this system message.
  if (looksLikeInjection(ctx.title)) out.push("- the PR title contains wording that addresses an automated reviewer");
  if (looksLikeInjection(ctx.description)) out.push("- the PR description contains wording that addresses an automated reviewer");
  for (const l of lines) {
    if (looksLikeInjection(l.text)) out.push(`- wording that addresses an automated reviewer at ${where(l.file, l.line)}`);
  }

  return capped(out, MAX_LINES);
}
