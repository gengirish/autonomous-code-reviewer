import type { ReviewContext } from "../../schemas/index.js";
import { addedLines, capped, isTestPath, safe } from "./util.js";

const MAX_LINES = 15;

const FORMATTERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Prettier", re: /(^|\/)(\.prettierrc[^/]*|prettier\.config\.[^/]+)$/ },
  { name: "Biome", re: /(^|\/)biome\.jsonc?$/ },
  { name: "dprint", re: /(^|\/)\.?dprint\.jsonc?$/ },
  { name: "Black", re: /(^|\/)(pyproject\.toml)$/, },
  { name: "Ruff", re: /(^|\/)\.?ruff\.toml$/ },
  { name: "EditorConfig", re: /(^|\/)\.editorconfig$/ },
  { name: "rustfmt", re: /(^|\/)\.?rustfmt\.toml$/ },
];

const DEBUG_LEFTOVER = /\bconsole\.(?:log|debug)\s*\(|^\s*debugger\s*;?\s*$|^\s*print\s*\(|\b(?:TODO|FIXME|XXX|HACK)\b/;

/** Which lint/format configs the repo has (decides whether formatting is out of scope) plus leftover-debugging lines. */
export function styleHints(ctx: ReviewContext): string[] {
  const out: string[] = [];
  const formatters = new Set<string>();
  for (const c of ctx.lintConfigs) {
    for (const f of FORMATTERS) {
      if (!f.re.test(c.path)) continue;
      // pyproject.toml only counts as a formatter config when it configures one.
      if (f.name === "Black" && !/\[tool\.(?:black|ruff\.format)\]/.test(c.text)) continue;
      formatters.add(f.name);
    }
  }
  if (ctx.files.some((f) => f.language === "go")) formatters.add("gofmt (Go)");

  if (ctx.lintConfigs.length === 0) {
    out.push("- no lint or formatter config was found in the repository context");
  } else {
    out.push(`- lint/format configs present: ${ctx.lintConfigs.map((c) => safe(c.path)).join(", ")}`);
  }
  out.push(
    formatters.size > 0
      ? `- formatter configured (${[...formatters].sort().join(", ")}): formatting is out of scope`
      : "- no formatter detected: flag formatting only where it clearly hurts readability, as a nit",
  );

  const leftovers = addedLines(ctx.files)
    .filter((l) => !isTestPath(l.file) && DEBUG_LEFTOVER.test(l.text))
    .map((l) => `- debug output or TODO/FIXME added at ${safe(l.file)}:${l.line}`);
  return capped([...out, ...leftovers], MAX_LINES);
}
