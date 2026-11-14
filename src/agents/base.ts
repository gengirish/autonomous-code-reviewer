import type { RunAgent } from "../core/ports.js";
import { AGENT_EFFORT } from "../llm/models.js";
import { AgentReport, type AgentName, type CheckedFinding, type ContextFile, type Finding, type ReviewContext } from "../schemas/index.js";
import { buildHints } from "./hints/index.js";
import { ROLE_PROMPTS, SHARED_SYSTEM } from "./prompts.js";

/** Evidence shorter than this (ignoring whitespace) proves nothing, e.g. "}" or "x". */
const MIN_EVIDENCE_CHARS = 4;

const normalise = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Role prompt plus this agent's deterministic hints: everything agent-specific lives after the cache breakpoint. */
export function roleInstructions(agent: AgentName, ctx: ReviewContext): string {
  const hints = buildHints(agent, ctx);
  return hints ? `${ROLE_PROMPTS[agent]}\n\n${hints}` : ROLE_PROMPTS[agent];
}

export const runAgent: RunAgent = async (agent, ctx, deps) => {
  const res = await deps.llm.callStructured({
    label: agent,
    runId: ctx.runId,
    system: SHARED_SYSTEM,
    userContent: deps.renderContext(ctx),
    cacheUserContent: true,
    roleInstructions: roleInstructions(agent, ctx),
    schema: AgentReport,
    effort: AGENT_EFFORT,
  });
  const report: AgentReport = { ...res.output, agent };
  return {
    report,
    checked: checkFindings(agent, report.findings, ctx),
    usage: res.usage,
    stopReason: res.stopReason,
    latencyMs: res.latencyMs,
  };
};

// ───────────────────────────── post-checks ─────────────────────────────

interface FileIndex {
  file: ContextFile;
  commentable: Set<number>;
  /** Normalised RIGHT-side and LEFT-side text of each hunk, plus enclosing symbol bodies. */
  haystacks: string[];
}

/** Splits raw hunk text into the head (context + added) and base (context + removed) versions, prefixes stripped. */
export function hunkSides(text: string): { right: string; left: string } {
  const right: string[] = [];
  const left: string[] = [];
  for (const raw of text.split("\n")) {
    if (raw.startsWith("@@") || raw.startsWith("\\")) continue;
    const marker = raw[0];
    const code = raw.slice(1);
    if (marker === "+") right.push(code);
    else if (marker === "-") left.push(code);
    else {
      right.push(marker === " " ? code : raw);
      left.push(marker === " " ? code : raw);
    }
  }
  return { right: right.join("\n"), left: left.join("\n") };
}

function indexFile(file: ContextFile): FileIndex {
  const haystacks: string[] = [];
  for (const h of file.hunks) {
    const { right, left } = hunkSides(h.text);
    haystacks.push(normalise(right), normalise(left));
    if (h.symbol) haystacks.push(normalise(h.symbol.body));
  }
  return { file, commentable: new Set(file.commentableLines), haystacks };
}

/**
 * Forms of the quoted evidence to try, most literal first. Models sometimes wrap code in
 * backticks or fences, or copy the rendered `  42 + ` line prefixes; those are stripped
 * only as fallbacks so that genuine code is always tried verbatim first.
 */
export function evidenceVariants(evidence: string): string[] {
  const variants = [evidence];
  const unfenced = evidence
    .trim()
    .replace(/^```[\w-]*\n?/, "")
    .replace(/\n?```$/, "")
    .replace(/^`([^`]*)`$/, "$1");
  variants.push(unfenced);
  variants.push(
    unfenced
      .split("\n")
      .map((l) => l.replace(/^\s*\d+\s+[+\- ](?: |$)/, "").replace(/^[+-](?=\s|$)/, ""))
      .join("\n"),
  );
  return [...new Set(variants)];
}

/** Every `...`/`…`-separated piece must occur, in order, in one haystack. */
function occursIn(haystack: string, evidence: string): boolean {
  const pieces = evidence
    .split(/\.\.\.|…/)
    .map(normalise)
    .filter(Boolean);
  if (pieces.join("").replace(/\s/g, "").length < MIN_EVIDENCE_CHARS) return false;
  let from = 0;
  for (const piece of pieces) {
    const at = haystack.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return true;
}

export function evidenceFound(evidence: string, haystacks: readonly string[]): boolean {
  const variants = evidenceVariants(evidence);
  return haystacks.some((h) => variants.some((v) => occursIn(h, v)));
}

const hunkOf = (file: ContextFile, line: number) => file.hunks.find((h) => line >= h.rightStart && line <= h.rightEnd);

/**
 * Deterministic checks on an agent's findings (acr-agents):
 * - unknown file → dropped;
 * - `line` not on a commentable RIGHT line → `commentable: false` (summary only);
 * - `endLine` kept only when it is after `line`, commentable and in the same hunk;
 * - `evidence` not found in the file's hunk or symbol text → `unverified: true`, confidence halved.
 * A `prompt-injection-attempt` may quote the PR title/description instead; it is then verified
 * but never inline, since no code line carries it.
 */
export function checkFindings(agent: AgentName, findings: readonly Finding[], ctx: ReviewContext): CheckedFinding[] {
  const files = new Map<string, FileIndex>();
  const index = (path: string): FileIndex | undefined => {
    const cached = files.get(path);
    if (cached) return cached;
    const file = ctx.files.find((f) => f.path === path);
    if (!file) return undefined;
    const built = indexFile(file);
    files.set(path, built);
    return built;
  };
  const metadata = [normalise(ctx.title), normalise(ctx.description)];

  const out: CheckedFinding[] = [];
  for (const f of findings) {
    const idx = index(f.file);
    if (!idx) continue;

    let commentable = idx.commentable.has(f.line);
    let verified = evidenceFound(f.evidence, idx.haystacks);
    if (!verified && f.category === "prompt-injection-attempt" && evidenceFound(f.evidence, metadata)) {
      verified = true;
      commentable = false;
    }

    const { endLine, ...rest } = f;
    const hunk = hunkOf(idx.file, f.line);
    const keepEnd =
      endLine !== undefined && commentable && endLine > f.line && idx.commentable.has(endLine) && hunk !== undefined && endLine <= hunk.rightEnd;

    out.push({
      ...rest,
      ...(keepEnd ? { endLine } : {}),
      confidence: verified ? f.confidence : f.confidence / 2,
      agent,
      commentable,
      unverified: !verified,
    });
  }
  return out;
}
