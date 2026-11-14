/**
 * PR files + HEAD contents → one or more ReviewContext chunks (acr-parser).
 *
 * Per file decisions (documented here because the publisher and agents rely on them):
 * - `isSkippedPath` matches → skipped with its reason.
 * - No `patch` → skipped: "no patch (binary or too large)" (or "no textual changes" /
 *   "renamed without content changes" when GitHub reports 0 additions and deletions).
 * - `removed` files are INCLUDED: their hunks (all deletion-only, rightStart = rightEnd = 0) and
 *   language, but no symbols, imports or exports (there is no head version to parse), and no
 *   commentable lines. Deleted code (e.g. a removed auth check) is worth reviewing.
 * - Any other file missing from `contents` → skipped: "head contents unavailable".
 * - Files whose extension has no grammar get diff-only context (language null, no symbols).
 * - Each hunk's symbol is the one around its first added line (falling back to later added
 *   lines when it sits at top level); a hunk with no added lines uses `rightStart`.
 *
 * Files are sorted by path everywhere. Chunking: see `chunk()` below.
 */
import type { BuildReviewContext } from "../core/ports.js";
import type { PrFile } from "../core/ports.js";
import { ReviewContext } from "../schemas/review-context.js";
import type { ContextFile, Hunk } from "../schemas/review-context.js";
import { parsePatch } from "./diff-map.js";
import { languageForPath } from "./languages.js";
import { cmp, renderContext } from "./render.js";
import { isSkippedPath } from "./skip.js";
import { analyzeSource } from "./symbols.js";

export const DEFAULT_MAX_TOKENS_PER_CHUNK = 60_000;
export const MAX_CHUNKS = 4;
/** Symbol bodies longer than this are cut when the context is over budget. */
export const LONG_BODY_LINES = 300;
/** Lines kept from a cut body. */
export const KEPT_BODY_LINES = 20;

export const SKIP_REASONS = {
  noPatch: "no patch (binary or too large)",
  noChanges: "no textual changes",
  pureRename: "renamed without content changes",
  noContents: "head contents unavailable",
  prTooLarge: "PR too large: not reviewed",
  fileTooLarge: "file too large for the token budget: not reviewed",
} as const;

type Skipped = ReviewContext["skipped"][number];

interface BuiltFile {
  file: ContextFile;
  topLevelSymbols: string[];
  changedLines: number;
}

const defaultCount = (text: string): Promise<number> => Promise.resolve(Math.ceil(text.length / 4));

// ───────────────────────────── test pairing ─────────────────────────────

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go)$/;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs"]);

const dirname = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Language family used so `x.py` never pairs with `x.test.ts`. */
function family(path: string): string | null {
  if (/\.[cm]?[jt]sx?$/.test(path)) return "js";
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".go")) return "go";
  return null;
}

/** For a test file, the stem of the source it tests (`x.test.ts` → `x`); null if not a test. */
export function testStem(path: string): string | null {
  const base = basename(path);
  const m =
    /^(.+)\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(base) ??
    /^test_(.+)\.py$/.exec(base) ??
    /^(.+)_test\.(?:py|go)$/.exec(base);
  if (m?.[1]) return m[1];
  if (path.split("/").includes("__tests__") && CODE_EXT.test(base)) return base.replace(CODE_EXT, "");
  return null;
}

/** Changed source files → changed test files that match them (x.ts ↔ x.test.ts, __tests__/x.ts, tests/test_x.py). */
export function pairTests(paths: readonly string[]): ReviewContext["testPairs"] {
  const tests = paths.filter((p) => testStem(p) !== null);
  const sources = paths.filter((p) => testStem(p) === null && family(p) !== null);
  return [...sources].sort(cmp).map((source) => {
    const stem = basename(source).replace(CODE_EXT, "");
    const dir = dirname(source);
    const matched = tests.filter((t) => {
      if (testStem(t) !== stem || family(t) !== family(source)) return false;
      const tdir = dirname(t);
      if (tdir === dir || tdir === (dir ? `${dir}/__tests__` : "__tests__")) return true;
      return t.split("/").slice(0, -1).some((seg) => TEST_DIRS.has(seg));
    });
    return { source, tests: matched.sort(cmp) };
  });
}

// ───────────────────────────── per file ─────────────────────────────

async function buildFile(f: PrFile, contents: Map<string, string>): Promise<BuiltFile | Skipped> {
  const skipReason = isSkippedPath(f.path);
  if (skipReason) return { path: f.path, reason: skipReason };
  if (!f.patch) {
    const noChange = f.additions + f.deletions === 0;
    const reason = !noChange ? SKIP_REASONS.noPatch : f.status === "renamed" ? SKIP_REASONS.pureRename : SKIP_REASONS.noChanges;
    return { path: f.path, reason };
  }
  const parsed = parsePatch(f.patch);
  const language = languageForPath(f.path);
  let symbols: Array<Hunk["symbol"]> = [];
  let imports: string[] = [];
  let exports: string[] = [];
  let topLevelSymbols: string[] = [];
  if (f.status !== "removed") {
    const content = contents.get(f.path);
    if (content === undefined) return { path: f.path, reason: SKIP_REASONS.noContents };
    if (language) {
      // The first added line in a symbol (later added lines if it sits at top level); a hunk
      // without added lines uses rightStart (0 for deletion-only → no symbol).
      const candidates = parsed.hunks.map((h) => (h.addedLines.length > 0 ? h.addedLines : [h.rightStart].filter((n) => n > 0)));
      const analysis = await analyzeSource(language, content, candidates);
      ({ symbols, imports, exports, topLevelSymbols } = analysis);
    }
  }
  const file: ContextFile = {
    path: f.path,
    ...(f.previousPath !== undefined ? { previousPath: f.previousPath } : {}),
    language,
    status: f.status,
    commentableLines: parsed.commentableLines,
    addedLines: parsed.addedLines,
    hunks: parsed.hunks.map((h, i) => {
      const symbol = symbols[i];
      return { rightStart: h.rightStart, rightEnd: h.rightEnd, text: h.text, ...(symbol ? { symbol } : {}) };
    }),
    imports,
    exports,
  };
  return { file, topLevelSymbols, changedLines: f.additions + f.deletions };
}

// ───────────────────────────── budget ─────────────────────────────

function truncateLongBodies(file: ContextFile): ContextFile {
  return {
    ...file,
    hunks: file.hunks.map((h) => {
      const s = h.symbol;
      if (!s || s.endLine - s.startLine + 1 <= LONG_BODY_LINES) return h;
      const lines = s.body.split("\n");
      const kept = lines.slice(0, KEPT_BODY_LINES);
      const hidden = s.endLine - s.startLine + 1 - kept.length;
      return { ...h, symbol: { ...s, body: [...kept, `… (${hidden} more lines not shown)`].join("\n") } };
    }),
  };
}

const topDir = (path: string): string => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");

/**
 * Splits an over-budget context:
 * 1. Files are grouped by top-level directory (groups in path order, root files first).
 * 2. Greedy packing: a group joins the current chunk if it fits, else starts a new chunk; a
 *    group too big for an empty chunk is packed file by file. A single file too big for an
 *    empty chunk is skipped ("file too large…").
 * 3. More than MAX_CHUNKS chunks: keep the MAX_CHUNKS with the most changed lines (ties: earlier
 *    chunk first), in their original order; the rest's files are skipped ("PR too large…").
 * Token costs are measured once per file (render with that file alone minus render with none),
 * so a real token counter is called N + 1 times rather than once per packing step.
 */
async function chunk(
  base: ReviewContext,
  changedLines: Map<string, number>,
  max: number,
  count: (text: string) => Promise<number>,
): Promise<ReviewContext[]> {
  const emptyCost = await count(renderContext({ ...base, files: [] }));
  const cost = new Map<string, number>();
  for (const f of base.files) {
    cost.set(f.path, Math.max(0, (await count(renderContext({ ...base, files: [f] }))) - emptyCost));
  }
  const costOf = (f: ContextFile): number => cost.get(f.path) ?? 0;

  const groups = new Map<string, ContextFile[]>();
  for (const f of base.files) {
    const key = topDir(f.path);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => cmp(a, b)).map(([, fs]) => fs);

  const chunks: ContextFile[][] = [];
  const extraSkipped: Skipped[] = [];
  let cur: ContextFile[] = [];
  let curCost = emptyCost;
  const close = () => {
    if (cur.length > 0) chunks.push(cur);
    cur = [];
    curCost = emptyCost;
  };
  for (const group of ordered) {
    const groupCost = group.reduce((sum, f) => sum + costOf(f), 0);
    if (curCost + groupCost <= max) {
      cur.push(...group);
      curCost += groupCost;
      continue;
    }
    if (emptyCost + groupCost <= max) {
      close();
      cur.push(...group);
      curCost += groupCost;
      continue;
    }
    for (const f of group) {
      if (emptyCost + costOf(f) > max) {
        extraSkipped.push({ path: f.path, reason: SKIP_REASONS.fileTooLarge });
        continue;
      }
      if (curCost + costOf(f) > max) close();
      cur.push(f);
      curCost += costOf(f);
    }
  }
  close();

  let kept = chunks;
  if (chunks.length > MAX_CHUNKS) {
    const weight = (c: ContextFile[]) => c.reduce((sum, f) => sum + (changedLines.get(f.path) ?? 0), 0);
    const keepIdx = new Set(
      chunks
        .map((c, i) => ({ i, w: weight(c) }))
        .sort((a, b) => b.w - a.w || a.i - b.i)
        .slice(0, MAX_CHUNKS)
        .map((x) => x.i),
    );
    kept = chunks.filter((_, i) => keepIdx.has(i));
    chunks.forEach((c, i) => {
      if (!keepIdx.has(i)) for (const f of c) extraSkipped.push({ path: f.path, reason: SKIP_REASONS.prTooLarge });
    });
  }

  const skipped = sortSkipped([...base.skipped, ...extraSkipped]);
  if (kept.length === 0) return [{ ...base, files: [], skipped, chunk: { index: 0, total: 1 } }];
  return kept.map((files, index) => ({
    ...base,
    files: [...files].sort((a, b) => cmp(a.path, b.path)),
    skipped,
    chunk: { index, total: kept.length },
  }));
}

const sortSkipped = (s: Skipped[]): Skipped[] => [...s].sort((a, b) => cmp(a.path, b.path) || cmp(a.reason, b.reason));

// ───────────────────────────── entry point ─────────────────────────────

export const buildReviewContext: BuildReviewContext = async (input) => {
  const max = input.maxTokensPerChunk ?? DEFAULT_MAX_TOKENS_PER_CHUNK;
  const count = input.countTokens ?? defaultCount;

  const skipped: Skipped[] = [];
  const built: BuiltFile[] = [];
  for (const f of [...input.files].sort((a, b) => cmp(a.path, b.path))) {
    const r = await buildFile(f, input.contents);
    if ("reason" in r) skipped.push(r);
    else built.push(r);
  }

  const live = built.filter((b) => b.file.status !== "removed");
  const base: ReviewContext = {
    runId: input.runId,
    owner: input.ref.owner,
    repo: input.ref.repo,
    pr: input.ref.pr,
    headSha: input.meta.headSha,
    baseSha: input.meta.baseSha,
    title: input.meta.title,
    description: input.meta.body,
    files: built.map((b) => b.file),
    // v1: the changed files only. The skill's "plus the files they import (one hop)" needs
    // contents we don't fetch yet; add it here when the prepare step fetches them.
    repoMap: live
      .filter((b) => b.file.language !== null)
      .map((b) => ({ path: b.file.path, symbols: b.topLevelSymbols, imports: b.file.imports })),
    testPairs: pairTests(live.map((b) => b.file.path)),
    lintConfigs: [...input.lintConfigs.entries()].map(([path, text]) => ({ path, text })).sort((a, b) => cmp(a.path, b.path)),
    skipped: sortSkipped(skipped),
    chunk: { index: 0, total: 1 },
  };

  let contexts: ReviewContext[];
  if ((await count(renderContext(base))) <= max) {
    contexts = [base];
  } else {
    const trimmed: ReviewContext = { ...base, files: base.files.map(truncateLongBodies) };
    if ((await count(renderContext(trimmed))) <= max) contexts = [trimmed];
    else contexts = await chunk(trimmed, new Map(built.map((b) => [b.file.path, b.changedLines])), max, count);
  }
  return contexts.map((c) => ReviewContext.parse(c));
};
