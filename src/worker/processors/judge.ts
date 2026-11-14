import { UnrecoverableError } from "bullmq";
import { isPermanent } from "../../core/errors.js";
import { AGENTS, JudgeJob, type JudgeOutput } from "../../schemas/index.js";
import type { WorkerDeps } from "../deps.js";
import { AgentResult, SUPERSEDED, type AgentResultOk, type JudgeResult } from "../results.js";
import { errorMessage, isSuperseded, loadRun, parseJob, toRetryable, type ParentJobLike } from "./shared.js";

export const NO_FINDINGS_SUMMARY = "No issues found by the specialist agents.";

/**
 * Merges the agents' reports (whatever succeeded), runs the judge, decides the event in code and
 * renders the review. Returns everything publish needs, so a GitHub failure never re-pays the judge.
 */
export async function processJudge(job: ParentJobLike, deps: WorkerDeps): Promise<JudgeResult> {
  const { runId } = parseJob(JudgeJob, job);
  const log = deps.logger.child({ runId, stage: "judge" });
  const { contexts, ref, headSha } = await loadRun(deps.contextStore, runId);

  if (await isSuperseded(deps.contextStore, ref, headSha)) {
    log.info("superseded: skipping judge");
    return SUPERSEDED;
  }

  const values = (await job.getChildrenValues()) ?? {};
  const failures = (await job.getIgnoredChildrenFailures()) ?? {};
  const ok: AgentResultOk[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const parsed = AgentResult.safeParse(raw);
    if (!parsed.success) {
      log.warn({ key }, "ignoring malformed agent result");
      continue;
    }
    if (parsed.data.superseded) {
      log.info({ key }, "an agent was superseded: skipping judge");
      return SUPERSEDED;
    }
    ok.push(parsed.data);
  }

  const failedAgents = AGENTS.filter((a) => !ok.some((r) => r.agent === a));
  if (Object.keys(failures).length > 0) log.warn({ failedJobs: Object.keys(failures), failedAgents }, "some agent jobs failed");
  if (ok.length === 0) {
    const reason = "all agents failed";
    await deps.recorder.runStatus(runId, "FAILED", reason);
    throw new UnrecoverableError(`${runId}: ${reason}`);
  }

  // Stable order: AGENTS order, then chunk. JudgedFinding.sourceIndexes point into `findings`.
  ok.sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent) || a.chunk - b.chunk);
  const reports = ok.map((r) => r.report);
  const findings = ok.flatMap((r) => r.checked);
  const agentsCost = ok.reduce((sum, r) => sum + r.costUsd, 0);

  let judge: JudgeOutput;
  let judgeCost = 0;
  if (findings.length === 0) {
    judge = { findings: [], summary: NO_FINDINGS_SUMMARY };
  } else {
    try {
      const out = await deps.runJudge({ runId, findings, reports, contexts, failedAgents }, { llm: deps.llm });
      judge = out.output;
      judgeCost = deps.costOf(out.usage);
      await deps.recorder.llmCall(runId, "judge", out.usage, out.stopReason, out.latencyMs, judgeCost);
    } catch (err) {
      if (isPermanent(err)) await deps.recorder.runStatus(runId, "FAILED", `judge: ${errorMessage(err)}`);
      return toRetryable(err);
    }
  }

  const cfg = await deps.repoConfig(ref);
  const event = deps.decideEvent(judge.findings, cfg);
  const rendered = deps.renderReview({
    runId,
    headSha,
    event,
    judge,
    inputFindings: findings,
    reports,
    failedAgents,
    contexts,
    cfg,
  });
  log.info({ event, findings: findings.length, judged: judge.findings.length, failedAgents }, "judge done");

  return {
    superseded: false,
    ref,
    headSha,
    event,
    body: rendered.body,
    comments: rendered.comments,
    inlineFindingIndexes: rendered.inlineFindingIndexes,
    judged: judge.findings,
    failedAgents,
    costUsd: agentsCost + judgeCost,
    chunks: contexts.length,
  };
}
