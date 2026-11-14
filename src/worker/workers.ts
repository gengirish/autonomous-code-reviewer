import { Worker, type ConnectionOptions, type Job } from "bullmq";
import { AgentJob, Q } from "../schemas/index.js";
import type { WorkerDeps } from "./deps.js";
import { processAgent } from "./processors/agent.js";
import { processJudge } from "./processors/judge.js";
import { processPrepare } from "./processors/prepare.js";
import { processPublish } from "./processors/publish.js";

export interface CreateWorkersOptions {
  /** BullMQ key prefix. Must match the prepare Queue and deps.flowProducer. */
  prefix?: string;
  /** Default 8. */
  agentConcurrency?: number;
  /** Agent rate limit; tune to the Anthropic tier's RPM. Default 40 / 60s. */
  limiter?: { max: number; duration: number };
}

export interface WorkerSet {
  workers: Worker[];
  close(): Promise<void>;
}

const isFinalFailure = (job: Job, err: Error) =>
  err.name === "UnrecoverableError" || job.attemptsMade >= (job.opts.attempts ?? 1);

/** One worker per queue: prepare 4, agent 8 (+ limiter), judge 4, publish 4. */
export function createWorkers(deps: WorkerDeps, connection: ConnectionOptions, opts: CreateWorkersOptions = {}): WorkerSet {
  const base = { connection, ...(opts.prefix === undefined ? {} : { prefix: opts.prefix }) };

  const prepare = new Worker(Q.prepare, (job) => processPrepare(job, deps), { ...base, concurrency: 4 });
  const agent = new Worker(Q.agent, (job) => processAgent(job, deps), {
    ...base,
    concurrency: opts.agentConcurrency ?? 8,
    limiter: opts.limiter ?? { max: 40, duration: 60_000 },
  });
  const judge = new Worker(Q.judge, (job) => processJudge(job, deps), { ...base, concurrency: 4 });
  const publish = new Worker(Q.publish, (job) => processPublish(job, deps), { ...base, concurrency: 4 });
  const workers = [prepare, agent, judge, publish];

  for (const w of workers) {
    w.on("error", (err) => deps.logger.error({ queue: w.name, err: err.message }, "worker error"));
    w.on("failed", (job, err) => {
      if (!job) return;
      const runId = (job.data as { runId?: unknown }).runId;
      deps.logger.warn({ queue: w.name, jobId: job.id, runId, attempt: job.attemptsMade, err: err.message }, "job failed");
      // Permanent failures were already recorded by the processor; record exhausted retries here.
      if (typeof runId !== "string" || err.name === "UnrecoverableError" || !isFinalFailure(job, err)) return;
      void recordExhausted(deps, w.name, job, runId, err).catch((e: unknown) =>
        deps.logger.error({ runId, err: e instanceof Error ? e.message : String(e) }, "recorder failed"),
      );
    });
  }

  return {
    workers,
    async close() {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}

async function recordExhausted(deps: WorkerDeps, queue: string, job: Job, runId: string, err: Error): Promise<void> {
  if (queue === Q.agent) {
    const data = AgentJob.safeParse(job.data);
    if (data.success) await deps.recorder.agentReport(runId, data.data.agent, data.data.chunk, "failed", err.message);
    return;
  }
  await deps.recorder.runStatus(runId, "FAILED", `${queue}: ${err.message}`);
}
