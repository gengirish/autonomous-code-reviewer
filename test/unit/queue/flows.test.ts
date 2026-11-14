import type { FlowJob, FlowProducer, Queue } from "bullmq";
import { describe, expect, it } from "vitest";
import { createPrepareEnqueuer } from "../../../src/queue/enqueue.js";
import { addReviewFlow } from "../../../src/queue/flows.js";
import { Q } from "../../../src/schemas/index.js";
import { mapLimit } from "../../../src/worker/processors/shared.js";
import { prepareJob, RecordingRecorder, RUN_ID } from "../worker/stubs.js";

const capture = () => {
  const flows: FlowJob[] = [];
  const producer = { add: async (f: FlowJob) => (flows.push(f), { job: {} }) } as unknown as FlowProducer;
  return { flows, producer };
};

describe("addReviewFlow", () => {
  it("builds publish ← judge ← 4 agents × chunks with deterministic job IDs", async () => {
    const { flows, producer } = capture();
    await addReviewFlow(producer, "r", 2, { agentBackoffMs: 7, startedAt: 5 });
    const publish = flows[0]!;
    expect(publish).toMatchObject({ queueName: Q.publish, data: { runId: "r", startedAt: 5 }, opts: { jobId: "r__publish", attempts: 5 } });
    const judge = publish.children![0]!;
    expect(judge).toMatchObject({ queueName: Q.judge, data: { runId: "r" }, opts: { jobId: "r__judge", attempts: 2, failParentOnFailure: true } });
    const agents = judge.children!;
    expect(agents.map((a) => a.opts?.jobId)).toEqual([
      "r__security__0",
      "r__security__1",
      "r__style__0",
      "r__style__1",
      "r__coverage__0",
      "r__coverage__1",
      "r__architecture__0",
      "r__architecture__1",
    ]);
    for (const a of agents) {
      expect(a.queueName).toBe(Q.agent);
      expect(a.opts).toMatchObject({ attempts: 3, ignoreDependencyOnFailure: true, backoff: { type: "exponential", delay: 7 } });
    }
    expect(agents[1]!.data).toEqual({ runId: "r", agent: "security", chunk: 1 });
    expect(agents.every((a) => !String(a.opts?.jobId).includes(":"))).toBe(true);
  });

  it("rejects zero chunks", async () => {
    await expect(addReviewFlow(capture().producer, "r", 0)).rejects.toThrow(/chunks/);
  });
});

describe("createPrepareEnqueuer", () => {
  const fakeQueue = () => {
    const jobs = new Map<string, unknown>();
    const queue = {
      getJob: async (id: string) => jobs.get(id),
      add: async (_name: string, data: unknown, opts: { jobId: string }) => {
        if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, data);
        return { id: opts.jobId };
      },
    } as unknown as Queue;
    return { jobs, queue };
  };

  it("uses the runId as jobId and is idempotent", async () => {
    const { jobs, queue } = fakeQueue();
    const recorder = new RecordingRecorder();
    const enqueue = createPrepareEnqueuer(queue, { recorder });
    expect(await enqueue(prepareJob())).toEqual({ runId: RUN_ID });
    expect(await enqueue(prepareJob())).toEqual({ runId: RUN_ID });
    expect([...jobs.keys()]).toEqual([RUN_ID]);
    expect(recorder.of("runQueued")).toHaveLength(1);
  });

  it("validates the payload", async () => {
    await expect(createPrepareEnqueuer(fakeQueue().queue)(prepareJob({ headSha: "short" }))).rejects.toThrow();
  });
});

describe("mapLimit", () => {
  it("keeps order and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, n));
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 8, async () => 1)).toEqual([]);
  });
});
