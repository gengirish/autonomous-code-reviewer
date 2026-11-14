/**
 * Unified diff (one file's GitHub `patch`) → RIGHT-side line maps.
 *
 * Walk rules (acr-parser):
 *   `+` line → RIGHT line n, added,   n++
 *   ` ` line → RIGHT line n, context, n++
 *   `-` line → LEFT only (no RIGHT line)
 *   `\ No newline at end of file` → ignored (kept in the hunk text)
 *
 * Conventions:
 * - A hunk spans exactly the line counts in its `@@ -a,b +c,d @@` header; anything after that
 *   and before the next `@@` (e.g. `diff --git` / `---` / `+++` headers of a full git diff) is
 *   ignored, so text before the first hunk header is fine too.
 * - A deletion-only hunk (`+c,0`) has `rightStart = rightEnd = 0` (the schema's convention),
 *   whatever `c` the header carries.
 * - Otherwise `rightStart`/`rightEnd` are the first/last RIGHT line the hunk covers (inclusive).
 * - A blank line inside a hunk (some tools strip the leading space of empty context lines)
 *   counts as a context line while the header says lines remain.
 * - `addedLines` and `commentableLines` (added + context) are sorted and de-duplicated.
 *   `commentableLines` is the only set the publisher may use for inline comments.
 */

export interface DiffHunk {
  rightStart: number;
  rightEnd: number;
  /** Raw hunk text: the `@@` header line plus its body lines, joined with "\n". */
  text: string;
  /** RIGHT lines added in this hunk, ascending. */
  addedLines: number[];
}

export interface ParsedPatch {
  hunks: DiffHunk[];
  addedLines: number[];
  commentableLines: number[];
}

export type DiffLineKind = "header" | "added" | "context" | "removed" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** RIGHT line number for added/context lines. */
  right?: number;
  /** Line without its one-character diff prefix (the full line for header/meta). */
  content: string;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface RawHunk {
  lines: DiffLine[];
  rawLines: string[];
  rightStart: number;
  rightEnd: number;
  added: number[];
  context: number[];
}

function walk(patch: string): RawHunk[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks: RawHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = HEADER.exec(lines[i] ?? "");
    if (!header) {
      i++;
      continue;
    }
    let leftLeft = header[2] === undefined ? 1 : Number(header[2]);
    let rightLeft = header[4] === undefined ? 1 : Number(header[4]);
    let n = Number(header[3]);
    const hunk: RawHunk = {
      lines: [{ kind: "header", content: lines[i] ?? "" }],
      rawLines: [lines[i] ?? ""],
      rightStart: 0,
      rightEnd: 0,
      added: [],
      context: [],
    };
    i++;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (line.startsWith("\\")) {
        // "\ No newline at end of file": belongs to the previous line; no line number.
        hunk.lines.push({ kind: "meta", content: line });
        hunk.rawLines.push(line);
        i++;
        continue;
      }
      if (leftLeft <= 0 && rightLeft <= 0) break;
      if (HEADER.test(line)) break; // malformed counts: the next hunk starts here
      const prefix = line[0];
      if (prefix === "+" && rightLeft > 0) {
        hunk.added.push(n);
        hunk.lines.push({ kind: "added", right: n, content: line.slice(1) });
        n++;
        rightLeft--;
      } else if (prefix === "-" && leftLeft > 0) {
        hunk.lines.push({ kind: "removed", content: line.slice(1) });
        leftLeft--;
      } else if ((prefix === " " || line === "") && (leftLeft > 0 || rightLeft > 0)) {
        if (i === lines.length - 1 && line === "") break; // trailing newline of the patch string
        hunk.context.push(n);
        hunk.lines.push({ kind: "context", right: n, content: line.slice(1) });
        n++;
        leftLeft--;
        rightLeft--;
      } else {
        break; // not part of this hunk
      }
      hunk.rawLines.push(line);
      i++;
    }
    const rights = hunk.lines.flatMap((l) => (l.right === undefined ? [] : [l.right]));
    if (rights.length > 0) {
      hunk.rightStart = rights[0] ?? 0;
      hunk.rightEnd = rights[rights.length - 1] ?? 0;
    }
    hunks.push(hunk);
  }
  return hunks;
}

function sortedUnique(nums: Iterable<number>): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

export function parsePatch(patch: string): ParsedPatch {
  const raw = walk(patch);
  const added = new Set<number>();
  const commentable = new Set<number>();
  const hunks: DiffHunk[] = raw.map((h) => {
    for (const n of h.added) {
      added.add(n);
      commentable.add(n);
    }
    for (const n of h.context) commentable.add(n);
    return { rightStart: h.rightStart, rightEnd: h.rightEnd, text: h.rawLines.join("\n"), addedLines: sortedUnique(h.added) };
  });
  return { hunks, addedLines: sortedUnique(added), commentableLines: sortedUnique(commentable) };
}

/** Classifies every line of one hunk's text (used by the renderer to number RIGHT lines). */
export function annotateHunk(text: string): DiffLine[] {
  const raw = walk(text);
  if (raw.length === 0) return text.split("\n").map((content) => ({ kind: "meta", content }));
  return raw.flatMap((h) => h.lines);
}
