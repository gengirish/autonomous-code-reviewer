import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_TS_HEADER,
  FIXTURES_ROOT,
  FixturePrSource,
  fixtureRef,
  loadAllFixtures,
  loadFixture,
  parseHunks,
  sha1,
  splitPatch,
  stripFixtureHeader,
} from "../../../evals/fixture-source.js";
import { Sha } from "../../../src/schemas/index.js";

const SYNTHETIC = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  "+two and a half",
  " three",
  "@@ -10,2 +11,2 @@ function x() {",
  " ten",
  "-eleven",
  "+ELEVEN",
  "\\ No newline at end of file",
  "diff --git a/src/new.py b/src/new.py",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/new.py",
  "@@ -0,0 +1,2 @@",
  "+x = 1",
  "+y = 2",
  "diff --git a/old/gone.go b/old/gone.go",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/old/gone.go",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-package gone",
  "-",
  "diff --git a/lib/before.js b/lib/after.js",
  "similarity index 100%",
  "rename from lib/before.js",
  "rename to lib/after.js",
  "diff --git a/docs/v1.md b/docs/v2.md",
  "similarity index 80%",
  "rename from docs/v1.md",
  "rename to docs/v2.md",
  "index 5555555..6666666 100644",
  "--- a/docs/v1.md",
  "+++ b/docs/v2.md",
  "@@ -1 +1 @@",
  "-v1",
  "+v2",
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 7777777..8888888 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
  "diff --git a/pkg/__init__.py b/pkg/__init__.py",
  "new file mode 100644",
  "index 0000000..e69de29",
  "",
].join("\n");

describe("splitPatch", () => {
  const files = splitPatch(SYNTHETIC);
  const byPath = (p: string) => files.find((f) => f.path === p);

  it("yields one PrFile per diff --git section, in order", () => {
    expect(files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/new.py",
      "old/gone.go",
      "lib/after.js",
      "docs/v2.md",
      "assets/logo.png",
      "pkg/__init__.py",
    ]);
  });

  it("derives status from the git headers", () => {
    expect(files.map((f) => f.status)).toEqual(["modified", "added", "removed", "renamed", "renamed", "modified", "added"]);
    expect(byPath("lib/after.js")?.previousPath).toBe("lib/before.js");
    expect(byPath("docs/v2.md")?.previousPath).toBe("docs/v1.md");
    expect(byPath("src/a.ts")?.previousPath).toBeUndefined();
  });

  it("keeps the per-file patch from the first @@ to the end of the section", () => {
    const patch = byPath("src/a.ts")?.patch ?? "";
    expect(patch.startsWith("@@ -1,3 +1,4 @@\n one\n")).toBe(true);
    expect(patch.endsWith("+ELEVEN\n\\ No newline at end of file")).toBe(true);
    expect(patch).not.toContain("diff --git");
    expect(byPath("src/new.py")?.patch).toBe("@@ -0,0 +1,2 @@\n+x = 1\n+y = 2");
  });

  it("has no patch for binaries, pure renames and empty files (like GitHub)", () => {
    expect(byPath("assets/logo.png")?.patch).toBeUndefined();
    expect(byPath("lib/after.js")?.patch).toBeUndefined();
    expect(byPath("pkg/__init__.py")?.patch).toBeUndefined();
  });

  it("counts additions and deletions", () => {
    expect(files.map((f) => [f.additions, f.deletions])).toEqual([
      [3, 2],
      [2, 0],
      [0, 2],
      [0, 0],
      [1, 1],
      [0, 0],
      [0, 0],
    ]);
  });

  it("uses sha1(path) as a deterministic blob SHA", () => {
    expect(byPath("src/a.ts")?.blobSha).toBe(sha1("src/a.ts"));
    expect(Sha.safeParse(byPath("src/a.ts")?.blobSha).success).toBe(true);
  });

  it("accepts CRLF patches", () => {
    expect(splitPatch(SYNTHETIC.replace(/\n/g, "\r\n"))).toEqual(files);
  });

  it("returns nothing for an empty patch", () => {
    expect(splitPatch("")).toEqual([]);
  });
});

describe("parseHunks", () => {
  it("numbers RIGHT and LEFT lines and skips the no-newline marker", () => {
    const [first, second] = parseHunks(splitPatch(SYNTHETIC)[0]?.patch ?? "");
    expect(first?.lines.map((l) => [l.kind, l.leftLine, l.rightLine])).toEqual([
      [" ", 1, 1],
      ["-", 2, undefined],
      ["+", undefined, 2],
      ["+", undefined, 3],
      [" ", 3, 4],
    ]);
    expect(second).toMatchObject({ leftStart: 10, leftCount: 2, rightStart: 11, rightCount: 2 });
    expect(second?.lines.map((l) => l.text)).toEqual(["ten", "eleven", "ELEVEN"]);
  });

  it("defaults omitted counts to 1", () => {
    expect(parseHunks("@@ -1 +1 @@\n-a\n+b")[0]).toMatchObject({ leftCount: 1, rightCount: 1 });
  });
});

describe("stripFixtureHeader", () => {
  it("removes the header from TypeScript files only", () => {
    expect(stripFixtureHeader("a.ts", `${FIXTURE_TS_HEADER}\nconst x = 1;\n`)).toBe("const x = 1;\n");
    expect(stripFixtureHeader("a.tsx", `${FIXTURE_TS_HEADER}\r\nx\r\n`)).toBe("x\n");
    expect(stripFixtureHeader("a.py", `${FIXTURE_TS_HEADER}\nx\n`)).toBe(`${FIXTURE_TS_HEADER}\nx\n`);
    expect(stripFixtureHeader("a.ts", "// @ts-nocheck\nx\n")).toBe("// @ts-nocheck\nx\n");
  });
});

describe("FixturePrSource", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "acr-fixture-test-"));
    const dir = join(root, "demo-case");
    await mkdir(join(dir, "head", "src"), { recursive: true });
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify({ title: "Demo", description: "Body", language: "typescript", tags: ["demo"], clean: false }),
    );
    await writeFile(
      join(dir, "expected.json"),
      JSON.stringify([{ file: "src/a.ts", lineStart: 2, lineEnd: 2, category: "x", minSeverity: "low", agent: "style" }]),
    );
    await writeFile(join(dir, "pr.patch"), SYNTHETIC);
    await writeFile(join(dir, "head", "src", "a.ts"), `${FIXTURE_TS_HEADER}\none\nTWO\n`);
    await writeFile(join(dir, "head", ".eslintrc.json"), "{}\n");
    await writeFile(join(root, "README.txt"), "not a case");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves meta with stable, distinct 40-hex SHAs", async () => {
    const fixture = await loadFixture(join(root, "demo-case"));
    const source = new FixturePrSource(fixture);
    const meta = await source.getPr(fixtureRef(fixture));
    expect(meta).toMatchObject({ title: "Demo", body: "Body", draft: false, state: "open" });
    expect(Sha.safeParse(meta.headSha).success && Sha.safeParse(meta.baseSha).success).toBe(true);
    expect(meta.headSha).not.toBe(meta.baseSha);
    expect((await new FixturePrSource(fixture).getPr(fixtureRef(fixture))).headSha).toBe(meta.headSha);
  });

  it("lists files from the patch and reads head contents without the TS header", async () => {
    const fixture = await loadFixture(join(root, "demo-case"));
    const source = new FixturePrSource(fixture);
    const ref = fixtureRef(fixture);
    const files = await source.listFiles(ref);
    expect(files).toHaveLength(7);
    expect(await source.getContent(ref, files[0] as (typeof files)[number])).toBe("one\nTWO\n");
    await expect(source.getContent(ref, files[1] as (typeof files)[number])).rejects.toThrow(/no head\/src\/new\.py/);
  });

  it("serves repo files from head/ and null when absent", async () => {
    const fixture = await loadFixture(join(root, "demo-case"));
    const source = new FixturePrSource(fixture);
    const ref = fixtureRef(fixture);
    expect(await source.getRepoFile(ref, ".eslintrc.json", "x")).toBe("{}\n");
    expect(await source.getRepoFile(ref, "eslint.config.js", "x")).toBeNull();
    expect(await source.getRepoFile(ref, "src", "x")).toBeNull();
    await expect(source.getRepoFile(ref, "../meta.json", "x")).rejects.toThrow(/escapes head/);
  });

  it("derives a GitHub-like ref from the case id", async () => {
    const fixture = await loadFixture(join(root, "demo-case"));
    expect(fixtureRef(fixture)).toEqual({ owner: "acr-evals", repo: "demo-case", pr: expect.any(Number) });
    expect(fixtureRef(fixture).pr).toBeGreaterThan(0);
  });

  it("loadAllFixtures skips plain files and loads each case directory", async () => {
    expect((await loadAllFixtures(root)).map((f) => f.id)).toEqual(["demo-case"]);
  });

  it("rejects inconsistent fixtures", async () => {
    const dir = join(root, "bad-clean");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify({ title: "t", description: "", language: "go", tags: ["x"], clean: true }),
    );
    await writeFile(
      join(dir, "expected.json"),
      JSON.stringify([{ file: "a.go", lineStart: 1, lineEnd: 1, category: "x", minSeverity: "low", agent: "style" }]),
    );
    await writeFile(join(dir, "pr.patch"), "");
    await expect(loadFixture(dir)).rejects.toThrow(/clean cases must have expected: \[\]/);

    await writeFile(join(dir, "expected.json"), JSON.stringify([{ file: "a.go", lineStart: 5, lineEnd: 2 }]));
    await expect(loadFixture(dir)).rejects.toThrow(/invalid expected.json/);
    await rm(dir, { recursive: true, force: true });
  });

  it("real fixtures: the rename case exercises renamed, removed and modified files", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "clean-ts-rename-date-utils"));
    const files = await new FixturePrSource(fixture).listFiles(fixtureRef(fixture));
    expect(Object.fromEntries(files.map((f) => [f.path, [f.status, f.previousPath]]))).toEqual({
      "src/api/handlers/stats.ts": ["modified", undefined],
      "src/reports/daily.ts": ["modified", undefined],
      "src/utils/dates.test.ts": ["renamed", "src/utils/date.test.ts"],
      "src/utils/dates.ts": ["renamed", "src/utils/date.ts"],
      "src/utils/legacyFormat.ts": ["removed", undefined],
    });
  });
});
