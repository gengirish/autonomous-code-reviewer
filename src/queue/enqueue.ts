import type { JobsOptions, Queue } from "bullmq";
import type { HookDeps, RunRecorder } from "../core/ports.js";
import { PrepareJob } from "../schemas/index.js";

export const PREPARE_JOB_NAME = "prepare";

/** Default options for the prepare job. The jobId (= runId) is always set by the enqueuer. */
export const DEFAULT_PREPARE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export interface PrepareEnqueuerOptions {
  /** Called with `runQueued` only when a new prepare job was created (not for duplicates). */
  recorder?: RunRecorder;
  jobOptions?: Omit<JobsOptions, "jobId">;
}

/**
 * `HookDeps["enqueuePrepare"]` over a BullMQ queue (Q.prepare). The jobId is the runId, so a
 * re-delivered hook for the same (ref, headSha) is a no-op that still returns the same runId.
 */
export function createPrepareEnqueuer(queue: Queue, opts: PrepareEnqueuerOptions = {}): HookDeps["enqueuePrepare"] {
  const jobOptions = { ...DEFAULT_PREPARE_JOB_OPTIONS, ...opts.jobOptions };
  return async (input) => {
    const job = PrepareJob.parse(input);
    const existing = await queue.getJob(job.runId);
    if (existing) return { runId: job.runId };
    // Adding an existing jobId is a no-op in BullMQ, so a concurrent duplicate is still safe.
    await queue.add(PREPARE_JOB_NAME, job, { ...jobOptions, jobId: job.runId });
    await opts.recorder?.runQueued(job);
    return { runId: job.runId };
  };
}
