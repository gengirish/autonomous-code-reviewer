/**
 * Every committed fixture is valid and internally consistent: the schemas pass, the
 * patch's RIGHT-side lines equal the head files line for line, and expected findings
 * point at lines a reviewer can actually comment on.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_TS_HEADER,
  type Fixture,
  loadAllFixtures,
  parseHunks,
  readHeadFile,
  splitPatch,
} from "../../../evals/fixture-source.js";
import { ExpectedFile, FixtureMeta, isPrScoped } from "../../../evals/schema.js";

const fixtures = await loadAllFixtures();

const headLines = (text: string) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

describe("fixture set", () => {
  it("has the 16 planned cases", () => {
    expect(fixtures).toHaveLength(16);
  });

  it("covers every bucket", () => {
    const bucket = (prefix: string) => fixtures.filter((f) => f.id.startsWith(prefix)).length;
    expect({
      security: bucket("sec-"),
      coverage: bucket("cov-"),
      architecture: bucket("arch-"),
      style: bucket("style-"),
      clean: bucket("clean-"),
    }).toEqual({ security: 4, coverage: 3, architecture: 3, style: 2, clean: 4 });
    expect(fixtures.filter((f) => f.meta.clean)).toHaveLength(5); // 4 clean + the clean refactor
  });

  it("mixes languages", () => {
    const langs = new Set(fixtures.map((f) => f.meta.language));
    for (const l of ["typescript", "javascript", "python", "go"]) expect(langs).toContain(l);
  });

  it("expects at least one finding from every agent", () => {
    const agents = new Set(fixtures.flatMap((f) => f.expected.map((e) => e.agent)));
    expect([...agents].sort()).toEqual(["architecture", "coverage", "security", "style"]);
  });
});

describe.each(fixtures.map((f) => [f.id, f] as const))("fixture %s", (_id, fixture: Fixture) => {
  const files = splitPatch(fixture.patch);

  it("validates against the schemas", async () => {
    const raw = async (name: string) => JSON.parse(await readFile(join(fixture.dir, name), "utf8"));
    expect(FixtureMeta.safeParse(await raw("meta.json")).success).toBe(true);
    expect(ExpectedFile.safeParse(await raw("expected.json")).success).toBe(true);
    expect(fixture.meta.clean).toBe(fixture.expected.length === 0);
  });

  it("uses LF line endings everywhere", async () => {
    expect(fixture.patch).not.toContain("\r");
    for (const p of fixture.headPaths) expect(await readFile(join(fixture.dir, "head", p), "utf8")).not.toContain("\r");
  });

  it("has a non-empty patch of valid hunks", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files.filter((x) => x.patch !== undefined)) {
      const hunks = parseHunks(f.patch as string);
      expect(hunks.length, f.path).toBeGreaterThan(0);
      for (const h of hunks) {
        expect(h.lines.filter((l) => l.kind !== "-").length, `${f.path} right count`).toBe(h.rightCount);
        expect(h.lines.filter((l) => l.kind !== "+").length, `${f.path} left count`).toBe(h.leftCount);
      }
    }
  });

  it("has head files exactly for the files that exist at head", async () => {
    for (const f of files) {
      const content = await readHeadFile(fixture, f.path);
      if (f.status === "removed") expect(content, f.path).toBeNull();
      else expect(content, f.path).not.toBeNull();
    }
  });

  it("matches every + and context line to the head file at that RIGHT line", async () => {
    for (const f of files.filter((x) => x.status !== "removed" && x.patch !== undefined)) {
      const head = headLines((await readHeadFile(fixture, f.path)) as string);
      for (const h of parseHunks(f.patch as string)) {
        for (const line of h.lines) {
          if (line.rightLine === undefined) continue;
          expect(head[line.rightLine - 1], `${f.path}:${line.rightLine}`).toBe(line.text);
        }
      }
      if (f.status === "added") expect(f.additions, `${f.path} added lines`).toBe(head.length);
    }
  });

  it("starts every TypeScript head file with the fixture header", async () => {
    for (const p of fixture.headPaths.filter((x) => /\.(ts|tsx|mts|cts)$/.test(x))) {
      const raw = await readFile(join(fixture.dir, "head", p), "utf8");
      expect(raw.startsWith(`${FIXTURE_TS_HEADER}\n`), p).toBe(true);
      expect(await readHeadFile(fixture, p)).toBe(raw.slice(FIXTURE_TS_HEADER.length + 1));
    }
  });

  it("points expected findings at commentable lines of changed files", () => {
    for (const e of fixture.expected) {
      if (isPrScoped(e)) {
        expect(e.category, "only PR-level issues may skip a location").toBe("prompt-injection-attempt");
        continue;
      }
      const f = files.find((x) => x.path === e.file);
      expect(f, `${e.file} is in pr.patch`).toBeDefined();
      const commentable = new Set(
        parseHunks(f?.patch ?? "").flatMap((h) => h.lines.flatMap((l) => (l.rightLine === undefined ? [] : [l.rightLine]))),
      );
      const range = Array.from({ length: e.lineEnd - e.lineStart + 1 }, (_, i) => e.lineStart + i);
      expect(
        range.some((n) => commentable.has(n)),
        `${e.file}:${e.lineStart}-${e.lineEnd}`,
      ).toBe(true);
    }
  });
});
