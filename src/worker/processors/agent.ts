import { UnrecoverableError } from "bullmq";
import { AgentRefusedError, isPermanent } from "../../core/errors.js";
import { AgentJob } from "../../schemas/index.js";
import type { WorkerDeps } from "../deps.js";
import { SUPERSEDED, type AgentResult } from "../results.js";
import { errorMessage, isSuperseded, loadRun, parseJob, toRetryable, type JobLike } from "./shared.js";

/** One specialist agent over one context chunk. */
export async function processAgent(job: JobLike, deps: WorkerDeps): Promise<AgentResult> {
  const { runId, agent, chunk } = parseJob(AgentJob, job);
  const log = deps.logger.child({ runId, stage: "agent", agent, chunk });
  const { contexts, ref, headSha } = await loadRun(deps.contextStore, runId);

  if (await isSuperseded(deps.contextStore, ref, headSha)) {
    log.info("superseded: skipping agent");
    return SUPERSEDED;
  }
  const ctx = contexts[chunk];
  if (!ctx) throw new UnrecoverableError(`${runId}: chunk ${chunk} does not exist (${contexts.length} chunks)`);

  let out: Awaited<ReturnType<WorkerDeps["runAgent"]>>;
  try {
    out = await deps.runAgent(agent, ctx, { llm: deps.llm, renderContext: deps.renderContext });
  } catch (err) {
    if (isPermanent(err)) {
      await deps.recorder.agentReport(runId, agent, chunk, err instanceof AgentRefusedError ? "refused" : "failed", errorMessage(err));
      log.warn({ err: errorMessage(err) }, "agent failed permanently");
    }
    return toRetryable(err);
  }

  const costUsd = deps.costOf(out.usage);
  await deps.recorder.llmCall(runId, agent, out.usage, out.stopReason, out.latencyMs, costUsd);
  await deps.recorder.agentReport(runId, agent, chunk, "ok", out.report.summary);
  log.info({ findings: out.checked.length, costUsd }, "agent done");
  return { superseded: false, agent, chunk, report: out.report, checked: out.checked, costUsd };
}
