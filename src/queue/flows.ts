import type { FlowJobNode, FlowProducer, JobNode, JobsOptions } from "bullmq";
import { AGENTS, Q, type AgentJob, type AgentName, type JudgeJob, type PublishJob } from "../schemas/index.js";

export interface ReviewFlowOptions {
  /** Agent attempts (default 3). */
  agentAttempts?: number;
  /** Base delay of the agents' exponential backoff in ms (default 5000). Tests use a few ms. */
  agentBackoffMs?: number;
  /** Judge attempts (default 2). */
  judgeAttempts?: number;
  judgeBackoffMs?: number;
  /** Publish attempts (default 5). GitHub failures retry without re-paying for the judge. */
  publishAttempts?: number;
  publishBackoffMs?: number;
  /** Run start (epoch ms) carried on the publish job for the run latency. */
  startedAt?: number;
}

/** Publish job data: PublishJob plus the optional run start time. */
export type PublishFlowData = PublishJob & { startedAt?: number };

const retention: Pick<JobsOptions, "removeOnComplete" | "removeOnFail"> = {
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export const agentJobId = (runId: string, agent: AgentName, chunk: number) => `${runId}__${agent}__${chunk}`;
export const judgeJobId = (runId: string) => `${runId}__judge`;
export const publishJobId = (runId: string) => `${runId}__publish`;

type FlowChild = FlowJobNode;

/**
 * Adds the review tree: publish ← judge ← (4 agents × chunks). Deterministic jobIds make a
 * re-add (prepare retry, re-delivered hook) a no-op.
 */
export async function addReviewFlow(
  flowProducer: FlowProducer,
  runId: string,
  chunks: number,
  opts: ReviewFlowOptions = {},
): Promise<JobNode> {
  if (!Number.isInteger(chunks) || chunks < 1) throw new Error(`addReviewFlow: chunks must be ≥ 1 (got ${chunks})`);

  const agentChildren: FlowChild[] = [];
  for (const agent of AGENTS) {
    for (let chunk = 0; chunk < chunks; chunk++) {
      const data: AgentJob = { runId, agent, chunk };
      agentChildren.push({
        name: agent,
        queueName: Q.agent,
        data,
        opts: {
          jobId: agentJobId(runId, agent, chunk),
          attempts: opts.agentAttempts ?? 3,
          backoff: { type: "exponential", delay: opts.agentBackoffMs ?? 5_000 },
          // The judge still runs with 3/4 reports; failures are read via getIgnoredChildrenFailures().
          ignoreDependencyOnFailure: true,
          ...retention,
        },
      });
    }
  }

  const judgeData: JudgeJob = { runId };
  const publishData: PublishFlowData = opts.startedAt === undefined ? { runId } : { runId, startedAt: opts.startedAt };

  return flowProducer.add({
    name: "publish",
    queueName: Q.publish,
    data: publishData,
    opts: {
      jobId: publishJobId(runId),
      attempts: opts.publishAttempts ?? 5,
      backoff: { type: "exponential", delay: opts.publishBackoffMs ?? 5_000 },
      ...retention,
    },
    children: [
      {
        name: "judge",
        queueName: Q.judge,
        data: judgeData,
        opts: {
          jobId: judgeJobId(runId),
          attempts: opts.judgeAttempts ?? 2,
          backoff: { type: "exponential", delay: opts.judgeBackoffMs ?? 5_000 },
          // A failed judge (e.g. all agents failed) fails publish instead of leaving it waiting forever.
          failParentOnFailure: true,
          ...retention,
        },
        children: agentChildren,
      },
    ],
  });
}
