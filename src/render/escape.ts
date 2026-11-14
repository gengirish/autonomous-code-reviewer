/**
 * Markdown helpers for untrusted text (titles, rationales, paths and the judge summary are
 * derived from author-controlled PR content).
 *
 * Main threat: a fake `<!-- ai-reviewer run=… sha=… -->` marker or a stray `</details>`
 * that changes how the review body is parsed or rendered.
 */

/** Neutralizes HTML openers outside code spans, and HTML comment openers inside them. */
export function safeText(s: string): string {
  let out = "";
  let i = 0;
  const re = /(`+)([\s\S]*?[^`])\1(?!`)/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    out += escapeHtmlOpeners(s.slice(i, m.index));
    out += m[0].replace(/<!--/g, "<!- -");
    i = m.index + m[0].length;
  }
  out += escapeHtmlOpeners(s.slice(i));
  return out;
}

const escapeHtmlOpeners = (s: string): string => s.replace(/<(?=[!/?a-zA-Z])/g, "&lt;");

/** Inside fenced code: only the HTML comment opener matters (marker spoofing). */
export const safeCode = (s: string): string => s.replace(/<!--/g, "<!- -");

export const oneLine = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ").trim();

/** Escapes text for a GFM table cell: newlines collapse, pipes are escaped (also inside code spans). */
export const tableCell = (s: string): string => oneLine(s).replace(/\\?\|/g, "\\|");

/** Inline code span that survives backticks in the content. */
export function codeSpan(s: string): string {
  const text = safeCode(oneLine(s));
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const padded = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

/** A fence (``` or longer) that cannot be closed by the content. */
export function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`{3,}/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}
