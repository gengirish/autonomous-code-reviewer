import type { ContextFile, Hunk } from "../../schemas/index.js";

export interface AddedLine {
  file: string;
  /** RIGHT-side line number. */
  line: number;
  text: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** RIGHT-side added lines of one hunk, numbered from its `@@` header. */
export function addedLinesOfHunk(file: string, hunk: Hunk): AddedLine[] {
  const out: AddedLine[] = [];
  let right = hunk.rightStart;
  for (const raw of hunk.text.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      right = Number(header[1]);
      continue;
    }
    const marker = raw[0];
    if (marker === "+") out.push({ file, line: right++, text: raw.slice(1) });
    else if (marker === " ") right++;
    // "-" (LEFT only), "\ No newline at end of file" and blank artefacts don't advance RIGHT.
  }
  return out;
}

/** Only added lines are scanned by the pre-scans. */
export function addedLines(files: readonly ContextFile[]): AddedLine[] {
  return files.flatMap((f) => f.hunks.flatMap((h) => addedLinesOfHunk(f.path, h)));
}

const TEST_PATH = /(^|\/)(__tests__|__mocks__|tests?|spec|fixtures?|testdata|e2e)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.go$|\.stories\.[^/]+$/i;

export const isTestPath = (path: string): boolean => TEST_PATH.test(path);

/**
 * Hints go into a SYSTEM message, which carries operator authority, while paths and names
 * come from the (untrusted) PR. Keep only a conservative character set and cap the length,
 * so nothing that reads like an instruction can be smuggled in through a file or package name.
 */
export function safe(value: string, max = 120): string {
  const cleaned = value.replace(/[^A-Za-z0-9_./@:+-]/g, "?");
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/** [3,4,5,9] → "3-5, 9" */
export function ranges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    const start = sorted[i] as number;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i] as number;
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    i++;
  }
  return parts.join(", ");
}

/** Caps a hint list so the role message stays small; says how many were left out. */
export function capped(lines: readonly string[], max: number): string[] {
  if (lines.length <= max) return [...lines];
  return [...lines.slice(0, max), `- (${lines.length - max} more not shown)`];
}
