import { describe, expect, it } from "vitest";
import type { PrFile } from "../../../src/core/ports.js";
import { buildReviewContext, renderContext, SKIP_REASONS } from "../../../src/parser/index.js";
import { pairTests } from "../../../src/parser/context-builder.js";
import { ReviewContext } from "../../../src/schemas/review-context.js";
import { contents, files, input, lintConfigs, meta } from "./fixtures/pr.js";

const byPath = (ctx: ReviewContext, path: string) => {
  const f = ctx.files.find((x) => x.path === path);
  if (!f) throw new Error(`missing ${path}`);
  return f;
};

describe("buildReviewContext (end to end)", () => {
  it("builds one valid context for a small PR", async () => {
    const out = await buildReviewContext(input());
    expect(out).toHaveLength(1);
    const ctx = ReviewContext.parse(out[0]);

    expect(ctx).toMatchObject({
      runId: "octo__demo__7__aaaaaaaaaaaa",
      owner: "octo",
      repo: "demo",
      pr: 7,
      headSha: meta.headSha,
      baseSha: meta.baseSha,
      title: meta.title,
      description: meta.body,
      chunk: { index: 0, total: 1 },
    });
    expect(ctx.files.map((f) => f.path)).toEqual([
      "docs/notes.md",
      "src/legacy/cleanup.py",
      "src/services/user-service.test.ts",
      "src/services/user-service.ts",
      "src/utils/helpers.ts",
    ]);
    expect(ctx.skipped).toEqual([
      { path: "assets/logo.png", reason: "binary file (.png)" },
      { path: "package-lock.json", reason: "lockfile (package-lock.json)" },
      { path: "src/big-data.ts", reason: SKIP_REASONS.noPatch },
      { path: "src/gone.ts", reason: SKIP_REASONS.noContents },
    ]);
  });

  it("maps hunks, lines, symbols, imports and exports of a modified TS file", async () => {
    const [ctx] = await buildReviewContext(input());
    const f = byPath(ctx!, "src/services/user-service.ts");
    expect(f.language).toBe("typescript");
    expect(f.status).toBe("modified");
    expect(f.addedLines).toEqual([8, 15, 18, 19, 26]);
    expect(f.commentableLines).toEqual([5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 17, 18, 19, 20, 24, 25, 26, 27]);
    expect(f.hunks.map((h) => [h.rightStart, h.rightEnd, h.symbol?.name])).toEqual([
      [5, 9, "hashPassword"],
      [12, 20, "UserService.find"],
      // the only added line (26, `export { db as database };`) is top level → no symbol
      [24, 27, undefined],
    ]);
    expect(f.hunks[1]?.symbol).toMatchObject({ kind: "method_definition", startLine: 14, endLine: 17 });
    expect(f.imports).toEqual(["../types.js", "./db.js", "node:crypto"]);
    expect(f.exports).toContain("UserService");
  });

  it("includes removed files without symbols, and diff-only files without a grammar", async () => {
    const [ctx] = await buildReviewContext(input());
    const removed = byPath(ctx!, "src/legacy/cleanup.py");
    expect(removed).toMatchObject({ language: "python", status: "removed", commentableLines: [], addedLines: [], imports: [], exports: [] });
    expect(removed.hunks).toHaveLength(1);
    expect(removed.hunks[0]).toMatchObject({ rightStart: 0, rightEnd: 0 });
    expect(removed.hunks[0]?.symbol).toBeUndefined();

    const md = byPath(ctx!, "docs/notes.md");
    expect(md.language).toBeNull();
    expect(md.hunks[0]?.symbol).toBeUndefined();
    expect(md.commentableLines).toEqual([1, 2, 3]);

    const renamed = byPath(ctx!, "src/utils/helpers.ts");
    expect(renamed).toMatchObject({ status: "renamed", previousPath: "src/old/helpers.ts", addedLines: [2] });
    expect(renamed.hunks[0]?.symbol?.name).toBe("slugify");
  });

  it("builds the repo map, test pairs and lint configs", async () => {
    const [ctx] = await buildReviewContext(input());
    expect(ctx!.repoMap.map((r) => r.path)).toEqual([
      "src/services/user-service.test.ts",
      "src/services/user-service.ts",
      "src/utils/helpers.ts",
    ]);
    expect(ctx!.repoMap[1]).toMatchObject({ imports: ["../types.js", "./db.js", "node:crypto"] });
    expect(ctx!.repoMap[1]?.symbols).toContain("UserService.find");
    expect(ctx!.repoMap[0]?.imports).toEqual(["./user-service.js", "vitest"]);
    expect(ctx!.testPairs).toEqual([
      { source: "src/services/user-service.ts", tests: ["src/services/user-service.test.ts"] },
      { source: "src/utils/helpers.ts", tests: [] },
    ]);
    expect(ctx!.lintConfigs.map((c) => c.path)).toEqual([".prettierrc", "eslint.config.js"]);
  });

  it("skips a pure rename and an empty patch with specific reasons", async () => {
    const extra: PrFile[] = [
      { path: "src/a.ts", previousPath: "src/b.ts", status: "renamed", blobSha: "x", additions: 0, deletions: 0 },
      { path: "src/empty.ts", status: "added", patch: "", blobSha: "y", additions: 0, deletions: 0 },
    ];
    const [ctx] = await buildReviewContext({ ...input(), files: extra });
    expect(ctx!.files).toEqual([]);
    expect(ctx!.skipped).toEqual([
      { path: "src/a.ts", reason: SKIP_REASONS.pureRename },
      { path: "src/empty.ts", reason: SKIP_REASONS.noChanges },
    ]);
  });
});

describe("pairTests", () => {
  it("matches the skill's patterns", () => {
    const pairs = pairTests([
      "src/a.ts",
      "src/a.test.ts",
      "src/b.tsx",
      "src/__tests__/b.tsx",
      "pkg/util.py",
      "tests/test_util.py",
      "cmd/server.go",
      "cmd/server_test.go",
      "src/c.ts",
      "test/unit/c.spec.ts",
      "src/d.py",
      "src/d.test.ts",
    ]);
    expect(pairs).toEqual([
      { source: "cmd/server.go", tests: ["cmd/server_test.go"] },
      { source: "pkg/util.py", tests: ["tests/test_util.py"] },
      { source: "src/a.ts", tests: ["src/a.test.ts"] },
      { source: "src/b.tsx", tests: ["src/__tests__/b.tsx"] },
      { source: "src/c.ts", tests: ["test/unit/c.spec.ts"] },
      { source: "src/d.py", tests: [] },
    ]);
  });
});

// ───────────────────────────── chunking ─────────────────────────────

/** A file in `dir` with one added line inside a function. */
function smallFile(path: string, additions = 1): { file: PrFile; content: string } {
  const content = "export function f() {\n  return 1;\n}\n";
  return {
    file: { path, status: "modified", patch: "@@ -1,3 +1,3 @@\n export function f() {\n-  return 0;\n+  return 1;\n }", blobSha: "s", additions, deletions: 1 },
    content,
  };
}

function prOf(entries: Array<{ file: PrFile; content: string }>) {
  return {
    ...input(),
    files: entries.map((e) => e.file),
    contents: new Map(entries.map((e) => [e.file.path, e.content])),
    lintConfigs: new Map<string, string>(),
  };
}

/** Deterministic fake counter: 100 tokens of overhead + 1000 per rendered file. */
const fakeCount = (text: string): Promise<number> => Promise.resolve(100 + 1000 * (text.match(/^<pr_file>$/gm)?.length ?? 0));

describe("chunking", () => {
  it("keeps one context when it fits", async () => {
    const pr = prOf(["a/1.ts", "b/1.ts"].map((p) => smallFile(p)));
    const out = await buildReviewContext({ ...pr, maxTokensPerChunk: 2100, countTokens: fakeCount });
    expect(out).toHaveLength(1);
  });

  it("splits by top-level directory, greedily, file by file for an oversized directory", async () => {
    const pr = prOf(["c/3.ts", "a/1.ts", "b/1.ts", "c/1.ts", "a/2.ts", "c/2.ts"].map((p) => smallFile(p)));
    const out = await buildReviewContext({ ...pr, maxTokensPerChunk: 2100, countTokens: fakeCount });
    expect(out.map((c) => c.files.map((f) => f.path))).toEqual([
      ["a/1.ts", "a/2.ts"],
      ["b/1.ts", "c/1.ts"],
      ["c/2.ts", "c/3.ts"],
    ]);
    expect(out.map((c) => c.chunk)).toEqual([
      { index: 0, total: 3 },
      { index: 1, total: 3 },
      { index: 2, total: 3 },
    ]);
    for (const c of out) {
      ReviewContext.parse(c);
      // PR-level fields are identical on every chunk.
      expect(c.title).toBe(out[0]!.title);
      expect(c.repoMap).toEqual(out[0]!.repoMap);
      expect(c.testPairs).toEqual(out[0]!.testPairs);
      expect(c.skipped).toEqual([]);
      expect(c.repoMap).toHaveLength(6);
    }
  });

  it("caps at 4 chunks, keeping the most-changed ones and listing the rest as skipped", async () => {
    const pr = prOf(Array.from({ length: 10 }, (_, i) => smallFile(`d${i}/f.ts`, i + 1)));
    const out = await buildReviewContext({ ...pr, maxTokensPerChunk: 1500, countTokens: fakeCount });
    expect(out).toHaveLength(4);
    expect(out.map((c) => c.files.map((f) => f.path))).toEqual([["d6/f.ts"], ["d7/f.ts"], ["d8/f.ts"], ["d9/f.ts"]]);
    const expectedSkipped = [0, 1, 2, 3, 4, 5].map((i) => ({ path: `d${i}/f.ts`, reason: SKIP_REASONS.prTooLarge }));
    for (const [i, c] of out.entries()) {
      expect(c.chunk).toEqual({ index: i, total: 4 });
      expect(c.skipped).toEqual(expectedSkipped);
    }
  });

  it("skips a file that cannot fit even alone (never silently)", async () => {
    const pr = prOf([smallFile("a/1.ts")]);
    const out = await buildReviewContext({ ...pr, maxTokensPerChunk: 1000, countTokens: fakeCount });
    expect(out).toHaveLength(1);
    expect(out[0]!.files).toEqual([]);
    expect(out[0]!.skipped).toEqual([{ path: "a/1.ts", reason: SKIP_REASONS.fileTooLarge }]);
  });

  it("first cuts symbol bodies over 300 lines to 20 lines (default chars/4 counter)", async () => {
    const lines = ["export function big() {", ...Array.from({ length: 400 }, (_, i) => `  const v${i} = ${i};`), "}"];
    const content = lines.join("\n") + "\n";
    const file: PrFile = {
      path: "src/big.ts",
      status: "modified",
      patch: `@@ -100,2 +100,3 @@\n ${lines[99]}\n+${lines[100]}\n ${lines[101]}`,
      blobSha: "b",
      additions: 1,
      deletions: 0,
    };
    const pr = prOf([{ file, content }]);
    const [full] = await buildReviewContext(pr);
    expect(full!.files[0]!.hunks[0]!.symbol!.body.split("\n")).toHaveLength(402);

    const budget = Math.ceil(renderContext(full!).length / 4) - 1;
    const out = await buildReviewContext({ ...pr, maxTokensPerChunk: budget });
    expect(out).toHaveLength(1);
    const sym = out[0]!.files[0]!.hunks[0]!.symbol!;
    expect(sym).toMatchObject({ name: "big", startLine: 1, endLine: 402 });
    const body = sym.body.split("\n");
    expect(body).toHaveLength(21);
    expect(body[0]).toBe("export function big() {");
    expect(body[20]).toBe("… (382 more lines not shown)");
    const rendered = renderContext(out[0]!);
    expect(rendered).toContain("  20 |   const v18 = 18;\n     | … (382 more lines not shown)\n");
    expect(Math.ceil(rendered.length / 4)).toBeLessThanOrEqual(budget);
  });
});

describe("contents map and lint configs are read, not mutated", () => {
  it("leaves inputs untouched", async () => {
    const before = JSON.stringify([files, [...contents], [...lintConfigs]]);
    await buildReviewContext(input());
    expect(JSON.stringify([files, [...contents], [...lintConfigs]])).toBe(before);
  });
});
