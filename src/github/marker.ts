/**
 * Idempotency marker appended to every review body. The renderer (src/render) emits the
 * same format; keep the two in sync.
 */
export function reviewMarker(runId: string, headSha: string): string {
  return `<!-- ai-reviewer run=${runId} sha=${headSha} -->`;
}

const MARKER_RE = /<!-- ai-reviewer run=([^\s>]+) sha=([0-9A-Za-z]+) -->/g;

export interface ParsedMarker {
  runId: string;
  headSha: string;
}

/** Last marker in the body (the one the publisher keeps at the end), or null. */
export function parseMarker(body: string | null | undefined): ParsedMarker | null {
  const found = findLastMarker(body ?? "");
  return found ? { runId: found.runId, headSha: found.headSha } : null;
}

/** Last marker with its position, for callers that need to split the body around it. */
export function findLastMarker(body: string): (ParsedMarker & { index: number; text: string }) | null {
  let last: RegExpExecArray | null = null;
  for (const m of body.matchAll(MARKER_RE)) last = m;
  if (!last || last[1] === undefined || last[2] === undefined) return null;
  return { runId: last[1], headSha: last[2], index: last.index, text: last[0] };
}

/** True if any marker in the body carries this head SHA. */
export function hasMarkerForSha(body: string | null | undefined, headSha: string): boolean {
  for (const m of (body ?? "").matchAll(MARKER_RE)) if (m[2] === headSha) return true;
  return false;
}
