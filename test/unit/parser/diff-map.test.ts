import { describe, expect, it } from "vitest";
import { annotateHunk, parsePatch } from "../../../src/parser/diff-map.js";
import { patch, source } from "./helpers.js";

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("parsePatch", () => {
  it("maps a multi-hunk patch to exact RIGHT line numbers", () => {
    const p = parsePatch(patch("multi-hunk"));
    expect(p.hunks.map((h) => [h.rightStart, h.rightEnd])).toEqual([
      [5, 9],
      [12, 20],
      [24, 27],
    ]);
    expect(p.addedLines).toEqual([8, 15, 18, 19, 26]);
    expect(p.commentableLines).toEqual([...range(5, 9), ...range(12, 20), ...range(24, 27)]);
    expect(p.hunks[1]?.addedLines).toEqual([15, 18, 19]);
    expect(p.hunks[0]?.text.startsWith("@@ -5,5 +5,5 @@")).toBe(true);
    expect(p.hunks[2]?.text.split("\n")).toHaveLength(5);
  });

  it("added line numbers point at the same text in the head file", () => {
    const head = source("user-service.ts").split("\n");
    const p = parsePatch(patch("multi-hunk"));
    const addedText = patch("multi-hunk")
      .split("\n")
      .filter((l) => l.startsWith("+"))
      .map((l) => l.slice(1));
    expect(p.addedLines.map((n) => head[n - 1])).toEqual(addedText);
    expect(head[15 - 1]).toContain("SELECT * FROM ${this.table}");
  });

  it("ignores git headers in a rename patch", () => {
    const p = parsePatch(patch("rename"));
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]).toMatchObject({ rightStart: 1, rightEnd: 4 });
    expect(p.hunks[0]?.text.startsWith("@@ -1,4 +1,4 @@")).toBe(true);
    expect(p.addedLines).toEqual([2]);
    expect(p.commentableLines).toEqual([1, 2, 3, 4]);
  });

  it("gives deletion-only hunks rightStart = rightEnd = 0 and no commentable lines", () => {
    const p = parsePatch(patch("deletion-only"));
    expect(p.hunks).toHaveLength(1);
    expect(p.hunks[0]).toMatchObject({ rightStart: 0, rightEnd: 0, addedLines: [] });
    expect(p.addedLines).toEqual([]);
    expect(p.commentableLines).toEqual([]);
  });

  it("handles a new file", () => {
    const p = parsePatch(patch("new-file"));
    expect(p.hunks[0]).toMatchObject({ rightStart: 1, rightEnd: 8 });
    expect(p.addedLines).toEqual(range(1, 8));
    expect(p.commentableLines).toEqual(range(1, 8));
  });

  it("ignores the no-newline marker", () => {
    const p = parsePatch(patch("no-newline"));
    expect(p.hunks[0]).toMatchObject({ rightStart: 1, rightEnd: 3 });
    expect(p.addedLines).toEqual([3]);
    expect(p.commentableLines).toEqual([1, 2, 3]);
    expect(p.hunks[0]?.text).toContain("\\ No newline at end of file");
  });

  it("treats a missing count as 1, sorts and de-duplicates, tolerates CRLF", () => {
    const p = parsePatch("@@ -3 +3 @@\r\n-old\r\n+new\r\n@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n");
    expect(p.hunks.map((h) => [h.rightStart, h.rightEnd])).toEqual([
      [3, 3],
      [1, 2],
    ]);
    expect(p.addedLines).toEqual([2, 3]);
    expect(p.commentableLines).toEqual([1, 2, 3]);
  });

  it("returns nothing for an empty patch", () => {
    expect(parsePatch("")).toEqual({ hunks: [], addedLines: [], commentableLines: [] });
  });
});

describe("annotateHunk", () => {
  it("numbers RIGHT lines and leaves removed lines unnumbered", () => {
    const lines = annotateHunk(parsePatch(patch("no-newline")).hunks[0]?.text ?? "");
    expect(lines.map((l) => [l.kind, l.right])).toEqual([
      ["header", undefined],
      ["context", 1],
      ["context", 2],
      ["removed", undefined],
      ["meta", undefined],
      ["added", 3],
      ["meta", undefined],
    ]);
  });
});
