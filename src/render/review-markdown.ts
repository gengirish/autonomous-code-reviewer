/**
 * Pure, deterministic rendering of the posted review: body markdown + inline comments.
 * (judge output, input findings, contexts, config) → same bytes every time.
 */
import type { RenderReview, RepoConfig, ReviewComment } from "../core/ports.js";
import type { AgentName, CheckedFinding, JudgedFinding, ReviewContext, ReviewEvent, Severity } from "../schemas/index.js";
import { AGENTS, SEVERITY_ORDER, severityRank } from "../schemas/index.js";
import { codeSpan, fenceFor, oneLine, safeCode, safeText, tableCell } from "./escape.js";

/** GitHub's limit for a review body (and for each comment body). */
export const BODY_CAP = 65_536;

const AGENT_LABEL: Record<AgentName, string> = {
  security: "🔒 Security",
  style: "🎨 Style",
  coverage: "🧪 Coverage",
  architecture: "🏛️ Architecture",
};

const VERDICT_TEXT: Record<ReviewEvent, string> = {
  REQUEST_CHANGES: "Changes requested",
  COMMENT: "Comments",
  APPROVE: "Approved",
};

const FOOTER = "<sub>Autonomous Code Reviewer · findings are suggestions; humans decide.</sub>";

export const reviewMarker = (runId: string, headSha: string): string => `<!-- ai-reviewer run=${runId} sha=${headSha} -->`;

const MAX_PATH_CHARS = 200;
const MAX_DETAIL_RATIONALE = 600;
const MAX_INLINE_RATIONALE = 8_000;

interface Indexed {
  f: JudgedFinding;
  i: number;
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const byPriority = (a: Indexed, b: Indexed): number =>
  severityRank(a.f.finalSeverity) - severityRank(b.f.finalSeverity) || b.f.confidence - a.f.confidence || a.i - b.i;

const location = (f: { file: string; line: number }): string => codeSpan(`${clip(f.file, MAX_PATH_CHARS)}:${f.line}`);

function commentableIndex(contexts: ReviewContext[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const ctx of contexts) {
    for (const file of ctx.files) {
      const set = map.get(file.path) ?? new Set<number>();
      for (const l of file.commentableLines) set.add(l);
      map.set(file.path, set);
    }
  }
  return map;
}

const isCommentable = (map: Map<string, Set<number>>, path: string, line: number): boolean => map.get(path)?.has(line) ?? false;

const tag = (f: JudgedFinding): string => `**[${f.finalSeverity} · ${f.sourceAgents.join(", ")} · ${safeText(oneLine(f.category))}]**`;

/** Heuristic: prose like "Use a parameterized query." must never become a suggestion block. */
const looksLikeCode = (s: string): boolean => /[=(){}[\];<>"'`]|\w\.\w/.test(s);

function suggestionBlock(f: JudgedFinding, rangePlaced: boolean): string | null {
  if (f.suggestion === undefined) return null;
  const text = f.suggestion.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (text.trim() === "") return null;
  const singleLineFinding = f.endLine === undefined || f.endLine === f.line;
  const literal =
    !text.includes("```") &&
    !text.includes("<!--") &&
    looksLikeCode(text) &&
    (rangePlaced || (singleLineFinding && !text.includes("\n")));
  if (literal) return `\`\`\`suggestion\n${text}\n\`\`\``;
  const fence = fenceFor(text);
  return `Suggested change:\n\n${fence}\n${safeCode(text)}\n${fence}`;
}

function inlineComment(f: JudgedFinding, commentable: Map<string, Set<number>>): ReviewComment {
  let rangePlaced = false;
  if (f.endLine !== undefined && f.endLine > f.line) {
    rangePlaced = true;
    for (let l = f.line; l <= f.endLine; l++) {
      if (!isCommentable(commentable, f.file, l)) {
        rangePlaced = false;
        break;
      }
    }
  }
  const parts = [`${tag(f)} ${safeText(oneLine(f.title))}`, safeText(clip(f.rationale.trim(), MAX_INLINE_RATIONALE))];
  const sugg = suggestionBlock(f, rangePlaced);
  if (sugg) parts.push(sugg);
  const body = parts.join("\n\n");
  const comment: ReviewComment = { path: f.file, line: f.line, side: "RIGHT", body: clip(body, BODY_CAP) };
  if (rangePlaced && f.endLine !== undefined) {
    comment.startLine = f.line;
    comment.line = f.endLine;
  }
  return comment;
}

function severityCounts(kept: JudgedFinding[]): string {
  const counts = new Map<Severity, number>();
  for (const f of kept) counts.set(f.finalSeverity, (counts.get(f.finalSeverity) ?? 0) + 1);
  const parts = SEVERITY_ORDER.filter((s) => counts.has(s)).map((s) => `${counts.get(s)} ${s}`);
  return parts.length > 0 ? `**${parts.join(" · ")}**` : "**No issues kept**";
}

function agentTable(
  judged: Indexed[],
  inputFindings: CheckedFinding[],
  failedAgents: AgentName[],
): string {
  const rows = ["| Agent | Raised | Kept | Top issue |", "|---|---|---|---|"];
  for (const agent of AGENTS) {
    const raised = inputFindings.filter((f) => f.agent === agent).length;
    const kept = judged.filter((x) => x.f.kept && x.f.sourceAgents.includes(agent)).sort(byPriority);
    const failed = failedAgents.includes(agent);
    if (failed && raised === 0) {
      rows.push(`| ${AGENT_LABEL[agent]} | – | – | unavailable |`);
      continue;
    }
    const top = kept[0];
    let issue = top ? `${tableCell(safeText(oneLine(top.f.title)))} (${tableCell(location(top.f))})` : "n/a";
    if (failed) issue += " (partly unavailable)";
    rows.push(`| ${AGENT_LABEL[agent]} | ${raised} | ${kept.length} | ${issue} |`);
  }
  return rows.join("\n");
}

function detailItem(f: JudgedFinding): string {
  const head = `- ${tag(f)} ${safeText(oneLine(f.title))} · ${location(f)}`;
  const why = safeText(clip(oneLine(f.rationale), MAX_DETAIL_RATIONALE));
  return why ? `${head}\n  ${why}` : head;
}

/** Renders a <details> section with as many items as fit in `budget` chars ("" if none fit). */
function detailsSection(title: string, items: string[], budget: number): string {
  if (items.length === 0) return "";
  const open = `<details><summary>${title} (${items.length})</summary>\n\n`;
  const close = "\n\n</details>";
  const full = `${open}${items.join("\n")}${close}`;
  if (full.length <= budget) return full;
  const note = (k: number): string => `- …and ${k} more not shown (review size limit)`;
  const reserve = open.length + close.length + note(items.length).length + 1;
  const shown: string[] = [];
  let used = reserve;
  for (const item of items) {
    const cost = item.length + 1;
    if (used + cost > budget) break;
    shown.push(item);
    used += cost;
  }
  if (reserve > budget) return "";
  return `${open}${[...shown, note(items.length - shown.length)].join("\n")}${close}`;
}

export function selectInline(
  judge: { findings: JudgedFinding[] },
  contexts: ReviewContext[],
  cfg: RepoConfig,
): number[] {
  const commentable = commentableIndex(contexts);
  const lowRank = severityRank("low");
  return judge.findings
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.kept)
    .filter(({ f }) => severityRank(f.finalSeverity) <= lowRank || (cfg.includeNits && f.finalSeverity === "nit"))
    .filter(({ f }) => isCommentable(commentable, f.file, f.line))
    .sort(byPriority)
    .slice(0, Math.max(0, cfg.maxInline))
    .map(({ i }) => i);
}

export const renderReview: RenderReview = (input) => {
  const { runId, headSha, event, judge, inputFindings, failedAgents, contexts, cfg } = input;
  const commentable = commentableIndex(contexts);
  const judged: Indexed[] = judge.findings.map((f, i) => ({ f, i }));
  const keptSorted = judged.filter((x) => x.f.kept).sort(byPriority);

  const inlineFindingIndexes = selectInline(judge, contexts, cfg);
  const inlineSet = new Set(inlineFindingIndexes);
  const comments = inlineFindingIndexes.map((i) => inlineComment(judge.findings[i] as JudgedFinding, commentable));

  // ── fixed parts (never truncated) ──
  const fileCount = new Set(contexts.flatMap((c) => c.files.map((f) => f.path))).size;
  const header = `## 🤖 AI Review: ${VERDICT_TEXT[event]}`;
  const stats = `${severityCounts(keptSorted.map((x) => x.f))} across ${fileCount} file${fileCount === 1 ? "" : "s"} · reviewed \`${headSha.slice(0, 7)}\``;
  const table = agentTable(judged, inputFindings, failedAgents);
  const tail = `${FOOTER}\n${reviewMarker(runId, headSha)}`;

  let summary = judge.summary.trim();
  const quote = (s: string): string =>
    s === ""
      ? ""
      : s
          .split(/\r?\n/)
          .map((l) => (l.trim() === "" ? ">" : `> ${safeText(l)}`))
          .join("\n");

  // ── details (truncated first) ──
  const moreItems = keptSorted.filter((x) => !inlineSet.has(x.i)).map((x) => detailItem(x.f));
  const skipped = new Map<string, string>();
  for (const ctx of contexts) for (const s of ctx.skipped) if (!skipped.has(s.path)) skipped.set(s.path, s.reason);
  const notReviewedItems = [
    ...[...skipped].map(([path, reason]) => `- ${codeSpan(clip(path, MAX_PATH_CHARS))}: ${safeText(oneLine(reason))}`),
    ...AGENTS.filter((a) => failedAgents.includes(a)).map(
      (a) => `- ${AGENT_LABEL[a]} agent unavailable: its checks did not run (or did not finish for every file)`,
    ),
  ];

  const assemble = (more: string, notReviewed: string): string =>
    [header, stats, quote(summary), table, more, notReviewed, tail].filter((p) => p !== "").join("\n\n");

  let fixedLen = assemble("", "").length;
  if (fixedLen > BODY_CAP) {
    // Only reachable with absurd input: the summary is the one fixed part that may shrink.
    summary = clip(summary, Math.max(0, summary.length - (fixedLen - BODY_CAP) - 1));
    fixedLen = assemble("", "").length;
  }
  const sep = 2; // "\n\n" per extra section
  const budget = BODY_CAP - fixedLen;
  const moreFull = detailsSection("More findings", moreItems, Infinity);
  const nrFull = detailsSection("Not reviewed", notReviewedItems, Infinity);

  let more = moreFull;
  let notReviewed = nrFull;
  const total = (m: string, n: string): number => (m ? m.length + sep : 0) + (n ? n.length + sep : 0);
  if (total(more, notReviewed) > budget) {
    notReviewed = detailsSection("Not reviewed", notReviewedItems, Math.floor(budget / 2) - sep);
    more = detailsSection("More findings", moreItems, budget - (notReviewed ? notReviewed.length + sep : 0) - sep);
    // Give any space "More findings" did not need back to "Not reviewed".
    const left = budget - (more ? more.length + sep : 0) - sep;
    if (notReviewed !== nrFull) notReviewed = detailsSection("Not reviewed", notReviewedItems, left);
  }

  let body = assemble(more, notReviewed);
  if (body.length > BODY_CAP) body = assemble("", ""); // defensive; budget math above should prevent this
  return { body, comments, inlineFindingIndexes };
};
