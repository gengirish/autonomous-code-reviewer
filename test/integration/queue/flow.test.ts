import { randomUUID } from "node:crypto";
import { FlowProducer, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HookDeps } from "../../../src/core/ports.js";
import { createRedis } from "../../../src/queue/connection.js";
import { RedisContextStore } from "../../../src/queue/context-store.js";
import { createPrepareEnqueuer } from "../../../src/queue/enqueue.js";
import { Q } from "../../../src/schemas/index.js";
import type { WorkerDeps } from "../../../src/worker/deps.js";
import { createWorkers, type WorkerSet } from "../../../src/worker/workers.js";
import { SHA_A, SHA_B } from "../../fakes/builders.js";
import { FakePrSource } from "../../fakes/fake-github.js";
import { aFile, aMeta, defaultLlm, makeDeps, prepareJob, RecordingRecorder, REF, RUN_ID, stubBuildReviewContext, type TestDeps } from "../../unit/worker/stubs.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const FAST = { agentBackoffMs: 10, judgeBackoffMs: 10, publishBackoffMs: 10 };

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function deleteKeys(redis: Redis, pattern: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== "0");
}

describe("review flow over real Redis", () => {
  let prefix: string;
  let connection: Redis;
  let flowProducer: FlowProducer;
  let prepareQueue: Queue;
  let contextStore: RedisContextStore;
  let recorder: RecordingRecorder;
  let workers: WorkerSet | undefined;
  let enqueue: HookDeps["enqueuePrepare"];

  beforeEach(() => {
    prefix = `acrtest-queue-${randomUUID().slice(0, 8)}`;
    connection = createRedis(REDIS_URL, 4);
    flowProducer = new FlowProducer({ connection, prefix });
    prepareQueue = new Queue(Q.prepare, { connection, prefix });
    contextStore = new RedisContextStore(connection, { keyPrefix: `${prefix}:acr:` });
    recorder = new RecordingRecorder();
    enqueue = createPrepareEnqueuer(prepareQueue, { recorder });
  });

  afterEach(async () => {
    await workers?.close();
    workers = undefined;
    await flowProducer.close();
    await prepareQueue.close();
    await deleteKeys(connection, `${prefix}:*`);
    await connection.quit();
  });

  const start = (o: Partial<WorkerDeps> & { source?: FakePrSource } = {}): TestDeps => {
    const deps = makeDeps({ contextStore, recorder, flowProducer, flowOptions: FAST, ...o });
    workers = createWorkers(deps, connection, { prefix, limiter: { max: 1000, duration: 1000 } });
    return deps;
  };

  const finished = () => recorder.of("runFinished").length > 0;

  it("runs prepare → 4 agents × chunks → judge → publish and posts one review", async () => {
    const deps = start({ buildReviewContext: stubBuildReviewContext(2) });
    expect(await enqueue(prepareJob())).toEqual({ runId: RUN_ID });
    await waitFor("runFinished", finished);

    expect(deps.publisher.published).toHaveLength(1);
    const review = deps.publisher.published[0]!;
    expect(review).toMatchObject({ ref: REF, headSha: SHA_A, event: "REQUEST_CHANGES" });
    expect(review.comments).toHaveLength(2); // security finding from each chunk, kept + inlined
    expect(deps.llm.calls.filter((c) => c.label !== "judge")).toHaveLength(8);
    expect(deps.llm.callsFor("judge")).toHaveLength(1);
    expect(recorder.statuses()).toEqual(["RUNNING"]);
    expect(recorder.of("runQueued")).toHaveLength(1);
    expect(recorder.of("runFinished")[0]!.result).toMatchObject({ reviewId: 1000, chunks: 2, verdict: "REQUEST_CHANGES" });
    expect(recorder.of("runFinished")[0]!.result.costUsd).toBeCloseTo(0.09);
    expect(recorder.of("findings")[0]!.findings.every((f) => f.inline)).toBe(true);
    expect((await contextStore.getContexts(RUN_ID))?.length).toBe(2);
    expect(await contextStore.getLatest(REF)).toBe(SHA_A);
  });

  it("dedupes a re-delivered hook: one prepare job, one review", async () => {
    const deps = start();
    const ids = await Promise.all([enqueue(prepareJob()), enqueue(prepareJob()), enqueue(prepareJob())]);
    expect(new Set(ids.map((r) => r.runId))).toEqual(new Set([RUN_ID]));
    await waitFor("runFinished", finished);

    expect(await enqueue(prepareJob())).toEqual({ runId: RUN_ID }); // after completion, too
    await settle();
    expect(deps.publisher.published).toHaveLength(1);
    expect(deps.llm.calls).toHaveLength(5); // 4 agents + judge, once
    const counts = await prepareQueue.getJobCounts("completed", "waiting", "active", "delayed");
    expect(counts).toEqual({ completed: 1, waiting: 0, active: 0, delayed: 0 });
  });

  it("still judges and publishes when one agent always fails, naming it in the review", async () => {
    const llm = defaultLlm({
      coverage: () => {
        throw new Error("529 overloaded");
      },
    });
    const deps = start({ llm });
    await enqueue(prepareJob());
    await waitFor("runFinished", finished);

    expect(deps.llm.callsFor("coverage")).toHaveLength(3); // all attempts used
    expect(deps.llm.callsFor("judge")).toHaveLength(1);
    expect(deps.rendered).toHaveLength(1);
    expect(deps.rendered[0]!.failedAgents).toEqual(["coverage"]);
    expect(deps.publisher.published).toHaveLength(1);
    expect(deps.publisher.published[0]!.body).toContain("failed=[coverage]");
    await waitFor("exhausted agent recorded", () =>
      recorder.of("agentReport").some((e) => e.agent === "coverage" && e.status === "failed"),
    );
  });

  it("does no LLM or GitHub work when the PR head already moved", async () => {
    const source = new FakePrSource(aMeta({ headSha: SHA_B }), [aFile()], { "src/db/users.ts": "x" });
    const deps = start({ source });
    await enqueue(prepareJob());
    await waitFor("SUPERSEDED", () => recorder.statuses().includes("SUPERSEDED"));
    await settle();

    expect(deps.llm.calls).toHaveLength(0);
    expect(deps.publisher.published).toHaveLength(0);
    expect(source.calls).toEqual(["getPr"]);
  });

  it("stops a run in flight when a newer SHA arrives: no LLM calls, no review", async () => {
    const deps = start({
      // A newer push lands while prepare is building the contexts.
      buildReviewContext: stubBuildReviewContext(1, () => contextStore.setLatest(REF, SHA_B)),
    });
    await enqueue(prepareJob());
    await waitFor("SUPERSEDED", () => recorder.statuses().includes("SUPERSEDED"));
    await settle();

    expect(recorder.statuses()).toEqual(["RUNNING", "SUPERSEDED"]);
    expect(deps.llm.calls).toHaveLength(0);
    expect(deps.publisher.published).toHaveLength(0);
    expect(recorder.of("runFinished")).toHaveLength(0);
  });

  it("marks the run FAILED and publishes nothing when every agent fails", async () => {
    const boom = () => {
      throw new Error("500");
    };
    const deps = start({ llm: defaultLlm({ security: boom, style: boom, coverage: boom, architecture: boom }) });
    await enqueue(prepareJob());
    await waitFor("FAILED", () => recorder.statuses().includes("FAILED"));
    await settle();

    expect(recorder.statuses()).toEqual(["RUNNING", "FAILED"]);
    expect(deps.llm.callsFor("judge")).toHaveLength(0);
    expect(deps.publisher.published).toHaveLength(0);
    const publishQueue = new Queue(Q.publish, { connection, prefix });
    try {
      const publishJob = await publishQueue.getJob(`${RUN_ID}__publish`);
      expect(await publishJob?.getState()).toBe("failed"); // not stuck in waiting-children
    } finally {
      await publishQueue.close();
    }
  });

  it("stores contexts and the latest-SHA guard with TTLs", async () => {
    await contextStore.putContexts("r1", []);
    await contextStore.setLatest(REF, SHA_A);
    expect(await contextStore.getContexts("r1")).toEqual([]);
    expect(await contextStore.getContexts("missing")).toBeNull();
    const ctxTtl = await connection.ttl(contextStore.contextKey("r1"));
    const latestTtl = await connection.ttl(contextStore.latestKey(REF));
    expect(ctxTtl).toBeGreaterThan(3500);
    expect(ctxTtl).toBeLessThanOrEqual(3600);
    expect(latestTtl).toBeGreaterThan(86_000);
    expect(latestTtl).toBeLessThanOrEqual(86_400);
  });
});
