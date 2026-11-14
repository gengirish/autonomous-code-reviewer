import { builtinModules } from "node:module";
import { posix } from "node:path";
import type { ReviewContext } from "../../schemas/index.js";
import { addedLines, capped, isTestPath, safe } from "./util.js";

const MAX_LINES = 25;

const IMPORT_SPECIFIERS = [
  /\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[\w$*{}\s,]+\s+from\s+["']([^"']+)["']/g,
  /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^\s*from\s+([\w.]+)\s+import\b/g,
  /^\s*import\s+([\w.]+)\s*(?:as\s+\w+\s*)?$/g,
];

const DECLARATION =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)|^(?:async\s+)?def\s+([A-Za-z_]\w*)|^class\s+([A-Za-z_]\w*)|^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/;

const BUILTINS = new Set(builtinModules);
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go)$/;

export function importsIn(text: string): string[] {
  const found: string[] = [];
  for (const re of IMPORT_SPECIFIERS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) if (m[1]) found.push(m[1]);
  }
  return found;
}

/** Relative specifier → repo path without extension or trailing /index; null for packages and aliases. */
export function resolveImport(fromPath: string, spec: string): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  return joined.replace(SOURCE_EXT, "").replace(/\/index$/, "");
}

const stripExt = (p: string): string => p.replace(SOURCE_EXT, "").replace(/\/index$/, "");

/** Top-level module of a path: `src/db/users.ts` → `src/db`, `lib/x.ts` → `lib`, `pkg/a/b.go` → `pkg`. */
export function moduleOf(path: string): string {
  const parts = path.split("/");
  if (parts.length >= 3 && ["src", "lib", "app", "packages", "internal", "cmd"].includes(parts[0] as string)) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts.length >= 2 ? (parts[0] as string) : "(root)";
}

const packageName = (spec: string): string | null => {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/") || spec.startsWith("~") || spec.startsWith("#")) return null;
  const bare = spec.replace(/^node:/, "");
  if (BUILTINS.has(bare) || BUILTINS.has(bare.split("/")[0] as string)) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
};

/** New imports in added lines (cross-module edges, possible cycles, internals, new packages) and possible duplicate utilities. */
export function architectureHints(ctx: ReviewContext): string[] {
  const changed = new Set(ctx.files.map((f) => f.path));

  // Existing module graph, from the repo map plus the head imports of the changed files.
  const moduleEdges = new Set<string>();
  /** Edges contributed by files this PR does not touch: an edge here is not new coupling. */
  const priorEdges = new Set<string>();
  const packageUsers = new Map<string, Set<string>>();
  const addEdges = (path: string, imports: readonly string[]) => {
    for (const spec of imports) {
      const target = resolveImport(path, spec);
      if (target) {
        const a = moduleOf(path);
        const b = moduleOf(target);
        if (a !== b) {
          moduleEdges.add(`${a}→${b}`);
          if (!changed.has(path)) priorEdges.add(`${a}→${b}`);
        }
      }
      const pkg = packageName(spec);
      if (pkg) packageUsers.set(pkg, (packageUsers.get(pkg) ?? new Set()).add(path));
    }
  };
  for (const r of ctx.repoMap) addEdges(r.path, r.imports);
  for (const f of ctx.files) addEdges(f.path, f.imports);

  const out: string[] = [];
  const seen = new Set<string>();
  const declared: Array<{ name: string; file: string; line: number }> = [];

  for (const l of addedLines(ctx.files)) {
    if (isTestPath(l.file)) continue;
    for (const spec of importsIn(l.text)) {
      const at = `${safe(l.file)}:${l.line}`;
      const target = resolveImport(l.file, spec);
      if (target) {
        const a = moduleOf(l.file);
        const b = moduleOf(target);
        if (/(^|\/)(internal|_[^/]*)(\/|$)/.test(target.slice(b.length)) && a !== b) {
          out.push(`- import of another module's internals: ${safe(a)} → ${safe(stripExt(target))} at ${at}`);
        }
        if (a !== b && !priorEdges.has(`${a}→${b}`) && !seen.has(`${a}→${b}`)) {
          seen.add(`${a}→${b}`);
          const reverse = moduleEdges.has(`${b}→${a}`) ? `; ${safe(b)} already imports ${safe(a)} (possible cycle)` : "";
          out.push(`- new cross-module import: ${safe(a)} → ${safe(b)} at ${at}${reverse}`);
        }
        continue;
      }
      const pkg = packageName(spec);
      if (pkg && !seen.has(`pkg:${pkg}`)) {
        seen.add(`pkg:${pkg}`);
        const others = [...(packageUsers.get(pkg) ?? [])].filter((p) => p !== l.file);
        if (others.length === 0) out.push(`- external package not imported elsewhere in the repo map: ${safe(pkg, 80)} at ${at}`);
      }
    }
    const d = DECLARATION.exec(l.text);
    const name = d?.[1] ?? d?.[2] ?? d?.[3] ?? d?.[4];
    if (name && name.length >= 4) declared.push({ name, file: l.file, line: l.line });
  }

  for (const d of declared) {
    const elsewhere = ctx.repoMap.filter((r) => !changed.has(r.path) && r.symbols.includes(d.name)).map((r) => r.path);
    if (elsewhere.length > 0) {
      out.push(`- ${safe(d.name, 60)} declared at ${safe(d.file)}:${d.line} also exists in ${elsewhere.slice(0, 3).map((p) => safe(p)).join(", ")} (possible duplicate)`);
    }
  }
  return capped(out, MAX_LINES);
}
