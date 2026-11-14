import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import { isPermanent } from "../../core/errors.js";
import { PublishJob } from "../../schemas/index.js";
import type { WorkerDeps } from "../deps.js";
import { JudgeResult, SUPERSEDED, type PublishResult } from "../results.js";
import { errorMessage, isSuperseded, parseJob, toRetryable, type ParentJobLike } from "./shared.js";

/** PublishJob plus the run start time that addReviewFlow puts on the publish job. */
const PublishData = PublishJob.extend({ startedAt: z.number().optional() });

/** Posts the judge's rendered review once per (ref, headSha). */
export async function processPublish(job: ParentJobLike, deps: WorkerDeps): Promise<PublishResult> {
  const { runId, startedAt } = parseJob(PublishData, job);
  const log = deps.logger.child({ runId, stage: "publish" });

  const values = Object.values((await job.getChildrenValues()) ?? {});
  if (values.length === 0) throw new UnrecoverableError(`${runId}: no judge result`);
  const parsed = JudgeResult.safeParse(values[0]);
  if (!parsed.success) throw new UnrecoverableError(`${runId}: malformed judge result: ${parsed.error.message}`);
  const judged = parsed.data;

  if (judged.superseded || (await isSuperseded(deps.contextStore, judged.ref, judged.headSha))) {
    await deps.recorder.runStatus(runId, "SUPERSEDED");
    log.info("superseded: not publishing");
    return SUPERSEDED;
  }

  const { ref, headSha, event, costUsd, chunks } = judged;
  const latencyMs = Date.now() - (startedAt ?? job.timestamp ?? Date.now());
  try {
    const publisher = await deps.publisherFor(ref);
    const existing = await publisher.findExistingReview(ref, headSha);
    if (existing !== null) {
      await deps.recorder.runFinished(runId, { verdict: event, reviewId: existing, costUsd, latencyMs, chunks });
      log.info({ reviewId: existing }, "review already exists for this SHA: not publishing again");
      return { superseded: false, reviewId: existing, inlinePosted: 0, existing: true };
    }

    const { reviewId, inlinePosted } = await publisher.publish({ ref, headSha, event, body: judged.body, comments: judged.comments });
    const inline = new Set(judged.inlineFindingIndexes);
    await deps.recorder.findings(
      runId,
      judged.judged.map((f, i) => ({ ...f, inline: inline.has(i) })),
    );
    await deps.recorder.runFinished(runId, { verdict: event, reviewId, costUsd, latencyMs, chunks });
    log.info({ reviewId, inlinePosted, event, costUsd }, "review published");
    return { superseded: false, reviewId, inlinePosted, existing: false };
  } catch (err) {
    if (isPermanent(err)) await deps.recorder.runStatus(runId, "FAILED", `publish: ${errorMessage(err)}`);
    return toRetryable(err);
  }
}
