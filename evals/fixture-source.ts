/**
 * Loads eval fixtures from disk and serves one as a PrSource, so evals run the real
 * prepare → agents → judge code without GitHub.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrFile, PrMeta, PrSource } from "../src/core/ports.js";
import type { PrRef } from "../src/schemas/index.js";
import { CASE_ID_PATTERN, ExpectedFile, type ExpectedFinding, FixtureMeta } from "./schema.js";

/** Default fixture directory (evals/fixtures). */
export const FIXTURES_ROOT = fileURLToPath(new URL("./fixtures/", import.meta.url));

/**
 * First line of every TypeScript head file. The repo's root `tsc` includes `evals/**`, and
 * fixture code imports packages this repo doesn't have, so each .ts/.tsx fixture file opts
 * out of type checking. The loader strips this line: agents never see it, and every line
 * number (pr.patch, expected.json) refers to the file WITHOUT it.
 */
export const FIXTURE_TS_HEADER =
  "// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)";
const TS_FAMILY = /\.(ts|tsx|mts|cts)$/;

export interface Fixture {
  id: string;
  /** Absolute path of evals/fixtures/<id>. */
  dir: string;
  meta: FixtureMeta;
  expected: ExpectedFinding[];
  /** Full pr.patch text (LF line endings). */
  patch: string;
  /** Posix paths of every file under head/, sorted. */
  headPaths: string[];
}

const toLf = (s: string) => s.replace(/\r\n/g, "\n");

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new Error(`fixture: cannot read ${path}: ${(err as Error).message}`, { cause: err });
  }
}

async function walk(dir: string, base = dir): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

/** Loads and validates one fixture directory. Throws with the offending path on any problem. */
export async function loadFixture(dir: string): Promise<Fixture> {
  const abs = resolve(dir);
  const id = abs.split(sep).at(-1) ?? "";
  if (!CASE_ID_PATTERN.test(id)) throw new Error(`fixture: case id "${id}" must be kebab-case (${abs})`);

  const metaResult = FixtureMeta.safeParse(await readJson(join(abs, "meta.json")));
  if (!metaResult.success) throw new Error(`fixture ${id}: invalid meta.json: ${metaResult.error.message}`);
  const expectedResult = ExpectedFile.safeParse(await readJson(join(abs, "expected.json")));
  if (!expectedResult.success) throw new Error(`fixture ${id}: invalid expected.json: ${expectedResult.error.message}`);

  const meta = metaResult.data;
  const expected = expectedResult.data;
  if (meta.clean && expected.length > 0) throw new Error(`fixture ${id}: clean cases must have expected: []`);
  if (!meta.clean && expected.length === 0) throw new Error(`fixture ${id}: seeded cases need at least one expected finding`);

  let patch: string;
  try {
    patch = toLf(await readFile(join(abs, "pr.patch"), "utf8"));
  } catch (err) {
    throw new Error(`fixture ${id}: cannot read pr.patch`, { cause: err });
  }
  return { id, dir: abs, meta, expected, patch, headPaths: await walk(join(abs, "head")) };
}

/** Every fixture under root (one subdirectory per case), sorted by id. */
export async function loadAllFixtures(root: string = FIXTURES_ROOT): Promise<Fixture[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  return Promise.all(dirs.map((name) => loadFixture(join(root, name))));
}

/** Removes the fixture-only TS header line (see FIXTURE_TS_HEADER). */
export function stripFixtureHeader(path: string, text: string): string {
  const lf = toLf(text);
  if (TS_FAMILY.test(path) && lf.startsWith(`${FIXTURE_TS_HEADER}\n`)) return lf.slice(FIXTURE_TS_HEADER.length + 1);
  return lf;
}

/** Head contents of `path` as the PR author wrote it, or null when head/ doesn't have it. */
export async function readHeadFile(fixture: Pick<Fixture, "dir" | "id">, path: string): Promise<string | null> {
  const clean = posix.normalize(path.replace(/\\/g, "/"));
  if (clean.startsWith("../") || clean === ".." || posix.isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) {
    throw new Error(`fixture ${fixture.id}: path escapes head/: ${path}`);
  }
  const full = join(fixture.dir, "head", ...clean.split("/"));
  try {
    if (!(await stat(full)).isFile()) return null;
  } catch {
    return null;
  }
  return stripFixtureHeader(clean, await readFile(full, "utf8"));
}

// ───────────────────────────── patch parsing ─────────────────────────────

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

/**
 * Splits a multi-file `git diff` into GitHub-files-API-shaped entries. `patch` is the text
 * from the first `@@` to the end of that file's section; it is absent for binary files and
 * for files without hunks (pure renames, empty new files), as on GitHub.
 */
export function splitPatch(patch: string): PrFile[] {
  const lines = toLf(patch).split("\n");
  const starts = lines.flatMap((line, i) => (line.startsWith("diff --git ") ? [i] : []));
  return starts.map((start, n) => {
    const section = lines.slice(start, starts[n + 1] ?? lines.length);
    while (section.length > 0 && section.at(-1) === "") section.pop();

    const header = DIFF_HEADER.exec(section[0] ?? "");
    if (!header) throw new Error(`pr.patch: cannot parse "${section[0]}"`);
    let oldPath = header[1] as string;
    let newPath = header[2] as string;
    let status: PrFile["status"] = "modified";
    let binary = false;

    const firstHunk = section.findIndex((l) => l.startsWith("@@"));
    const headerLines = firstHunk === -1 ? section : section.slice(0, firstHunk);
    for (const line of headerLines) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) newPath = line.slice("rename to ".length);
      else if (line.startsWith("copy from ")) {
        status = "copied";
        oldPath = line.slice("copy from ".length);
      } else if (line.startsWith("copy to ")) newPath = line.slice("copy to ".length);
      else if (line.startsWith("--- a/")) oldPath = line.slice("--- a/".length);
      else if (line.startsWith("+++ b/")) newPath = line.slice("+++ b/".length);
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
    }

    const body = firstHunk === -1 || binary ? [] : section.slice(firstHunk);
    const path = status === "removed" ? oldPath : newPath;
    const file: PrFile = {
      path,
      status,
      blobSha: sha1(path),
      additions: body.filter((l) => l.startsWith("+")).length,
      deletions: body.filter((l) => l.startsWith("-")).length,
    };
    if (body.length > 0) file.patch = body.join("\n");
    if ((status === "renamed" || status === "copied") && oldPath !== path) file.previousPath = oldPath;
    return file;
  });
}

export interface HunkLine {
  kind: " " | "+" | "-";
  text: string;
  /** RIGHT-side (head) line number, for context and added lines. */
  rightLine?: number;
  /** LEFT-side (base) line number, for context and removed lines. */
  leftLine?: number;
}

export interface ParsedHunk {
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
  lines: HunkLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses the hunks of one file's patch (as in PrFile.patch). */
export function parseHunks(patch: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | undefined;
  let left = 0;
  let right = 0;
  for (const line of toLf(patch).split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        leftStart: Number(header[1]),
        leftCount: header[2] === undefined ? 1 : Number(header[2]),
        rightStart: Number(header[3]),
        rightCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      left = current.leftStart;
      right = current.rightStart;
      continue;
    }
    if (!current || line.startsWith("\\") || line === "") continue;
    const kind = line[0];
    const text = line.slice(1);
    if (kind === " ") current.lines.push({ kind, text, leftLine: left++, rightLine: right++ });
    else if (kind === "+") current.lines.push({ kind, text, rightLine: right++ });
    else if (kind === "-") current.lines.push({ kind, text, leftLine: left++ });
    else throw new Error(`patch: unexpected line in hunk: ${JSON.stringify(line)}`);
  }
  return hunks;
}

// ───────────────────────────── PrSource ─────────────────────────────

export const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

export const FIXTURE_OWNER = "acr-evals";

/** Deterministic PrRef for a fixture: owner "acr-evals", repo = case id. */
export function fixtureRef(fixture: Pick<Fixture, "id">): PrRef {
  return { owner: FIXTURE_OWNER, repo: fixture.id, pr: 1 + (Number.parseInt(sha1(`pr:${fixture.id}`).slice(0, 6), 16) % 9999) };
}

/** PrSource over one fixture. Ignores the ref: a FixturePrSource only ever serves its own case. */
export class FixturePrSource implements PrSource {
  constructor(readonly fixture: Fixture) {}

  async getPr(_ref: PrRef): Promise<PrMeta> {
    return {
      headSha: sha1(`head:${this.fixture.id}`),
      baseSha: sha1(`base:${this.fixture.id}`),
      title: this.fixture.meta.title,
      body: this.fixture.meta.description,
      draft: false,
      state: "open",
    };
  }

  async listFiles(_ref: PrRef): Promise<PrFile[]> {
    return splitPatch(this.fixture.patch);
  }

  async getContent(_ref: PrRef, file: PrFile): Promise<string> {
    const content = await readHeadFile(this.fixture, file.path);
    if (content === null) throw new Error(`fixture ${this.fixture.id}: no head/${file.path}`);
    return content;
  }

  async getRepoFile(_ref: PrRef, path: string, _sha: string): Promise<string | null> {
    return readHeadFile(this.fixture, path);
  }
}
