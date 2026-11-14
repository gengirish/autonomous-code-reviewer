import { readFileSync } from "node:fs";
import type { RunJudge } from "../core/ports.js";
import { logger } from "../core/logger.js";
import { JUDGE_EFFORT } from "../llm/models.js";
import type { AgentName, CheckedFinding, JudgedFinding } from "../schemas/index.js";
import { AGENTS, JudgeOutput } from "../schemas/index.js";
import { buildJudgeUserContent } from "./user-content.js";

export const JUDGE_PROMPT = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");
export const RUBRIC = readFileSync(new URL("./rubric.md", import.meta.url), "utf8");

export const SUMMARY_MAX_WORDS = 120;

const log = logger.child({ module: "judge" });

/** Copy of an input finding's Finding fields (drops agent/commentable/unverified). */
function findingFields(f: CheckedFinding): Omit<JudgedFinding, "sourceIndexes" | "sourceAgents" | "kept" | "dropReason" | "finalSeverity"> {
  const out: Omit<JudgedFinding, "sourceIndexes" | "sourceAgents" | "kept" | "dropReason" | "finalSeverity"> = {
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    title: f.title,
    rationale: f.rationale,
    evidence: f.evidence,
    confidence: f.confidence,
  };
  if (f.endLine !== undefined) out.endLine = f.endLine;
  if (f.suggestion !== undefined) out.suggestion = f.suggestion;
  return out;
}

function capWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return s.trim();
  return `${words.slice(0, max).join(" ")}…`;
}

/**
 * Enforces the judge's invariants regardless of what the model returned:
 * - out-of-range and already-claimed indexes are removed (first claim wins);
 *   entries left with no index are discarded
 * - every input index the judge omitted gets a synthesized `kept: false, low-value` entry
 * - `sourceAgents` is recomputed from the indexes
 * - an entry whose file/line is not one of its source findings' locations falls back to
 *   the first source finding's location
 * - `dropReason` present iff `kept` is false; summary capped at 120 words
 */
export function postValidate(raw: JudgeOutput, inputs: CheckedFinding[], runId: string): JudgeOutput {
  const n = inputs.length;
  const claimed = new Set<number>();
  const findings: JudgedFinding[] = [];
  let outOfRange = 0;
  let doubleClaimed = 0;
  let relocated = 0;
  let discarded = 0;

  for (const jf of raw.findings) {
    const idx: number[] = [];
    for (const i of jf.sourceIndexes) {
      if (!Number.isInteger(i) || i < 0 || i >= n) {
        outOfRange++;
        continue;
      }
      if (claimed.has(i)) {
        if (!idx.includes(i)) doubleClaimed++;
        continue;
      }
      claimed.add(i);
      idx.push(i);
    }
    if (idx.length === 0) {
      discarded++;
      continue;
    }
    const sources = idx.map((i) => inputs[i]).filter((f): f is CheckedFinding => f !== undefined);
    const agents = new Set<AgentName>(sources.map((s) => s.agent));
    const sourceAgents = AGENTS.filter((a) => agents.has(a));

    const out: JudgedFinding = { ...jf, sourceIndexes: idx, sourceAgents };
    const atSource = sources.some((s) => s.file === jf.file && s.line === jf.line);
    if (!atSource) {
      const first = sources[0] as CheckedFinding;
      out.file = first.file;
      out.line = first.line;
      if (first.endLine !== undefined) out.endLine = first.endLine;
      else delete out.endLine;
      relocated++;
    }
    if (out.endLine !== undefined && out.endLine < out.line) delete out.endLine;
    if (out.kept) delete out.dropReason;
    else if (out.dropReason === undefined) out.dropReason = "low-value";
    findings.push(out);
  }

  const omitted: number[] = [];
  for (let i = 0; i < n; i++) {
    if (claimed.has(i)) continue;
    const f = inputs[i] as CheckedFinding;
    omitted.push(i);
    findings.push({
      ...findingFields(f),
      sourceIndexes: [i],
      sourceAgents: [f.agent],
      kept: false,
      dropReason: "low-value",
      finalSeverity: f.severity,
    });
  }

  if (omitted.length > 0 || outOfRange > 0 || doubleClaimed > 0 || relocated > 0 || discarded > 0) {
    log.warn(
      { runId, omitted: omitted.length, omittedIndexes: omitted, outOfRange, doubleClaimed, relocated, discarded },
      "judge output violated invariants; repaired",
    );
  }

  return JudgeOutput.parse({ findings, summary: capWords(raw.summary, SUMMARY_MAX_WORDS) });
}

export const runJudge: RunJudge = async (input, deps) => {
  const userContent = buildJudgeUserContent({
    findings: input.findings,
    reports: input.reports,
    contexts: input.contexts,
    failedAgents: input.failedAgents,
    rubric: RUBRIC,
  });
  const res = await deps.llm.callStructured({
    label: "judge",
    runId: input.runId,
    system: JUDGE_PROMPT,
    userContent,
    cacheUserContent: false,
    schema: JudgeOutput,
    effort: JUDGE_EFFORT,
  });
  const output = postValidate(res.output, input.findings, input.runId);
  log.info(
    {
      runId: input.runId,
      inputFindings: input.findings.length,
      judged: output.findings.length,
      kept: output.findings.filter((f) => f.kept).length,
      failedAgents: input.failedAgents,
    },
    "judge finished",
  );
  return { output, usage: res.usage, stopReason: res.stopReason, latencyMs: res.latencyMs };
};
