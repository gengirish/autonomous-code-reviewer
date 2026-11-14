import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it } from "vitest";
import { processPublish } from "../../../src/worker/processors/publish.js";
import type { JudgeResultOk } from "../../../src/worker/results.js";
import { aCheckedFinding, SHA_A, SHA_B } from "../../fakes/builders.js";
import { FakePublisher } from "../../fakes/fake-github.js";
import { keepAll, makeDeps, REF, RUN_ID, type TestDeps } from "./stubs.js";

const judged = (): JudgeResultOk => {
  const findings = keepAll([aCheckedFinding({ title: "first" }), aCheckedFinding({ title: "second", line: 41 })]).findings;
  return {
    superseded: false,
    ref: REF,
    headSha: SHA_A,
    event: "REQUEST_CHANGES",
    body: "body",
    comments: [{ path: "src/db/users.ts", line: 41, side: "RIGHT", body: "second" }],
    inlineFindingIndexes: [1],
    judged: findings,
    failedAgents: [],
    costUsd: 0.05,
    chunks: 1,
  };
};

const parentJob = (value: unknown) => ({
  id: `${RUN_ID}__publish`,
  data: { runId: RUN_ID, startedAt: Date.now() - 50 },
  getChildrenValues: async () => (value === undefined ? {} : { [`bull:acr-judge:${RUN_ID}__judge`]: value }),
  getIgnoredChildrenFailures: async () => ({}),
});

describe("processPublish", () => {
  let deps: TestDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await deps.contextStore.setLatest(REF, SHA_A);
  });

  it("publishes once and records findings with inline flags", async () => {
    const res = await processPublish(parentJob(judged()), deps);
    expect(res).toEqual({ superseded: false, reviewId: 1000, inlinePosted: 1, existing: false });
    expect(deps.publisher.published).toEqual([
      { ref: REF, headSha: SHA_A, event: "REQUEST_CHANGES", body: "body", comments: judged().comments },
    ]);
    const recorded = deps.recorder.of("findings")[0]!.findings;
    expect(recorded.map((f) => [f.title, f.inline])).toEqual([
      ["first", false],
      ["second", true],
    ]);
    const finished = deps.recorder.of("runFinished")[0]!.result;
    expect(finished).toMatchObject({ verdict: "REQUEST_CHANGES", reviewId: 1000, costUsd: 0.05, chunks: 1 });
    expect(finished.latencyMs).toBeGreaterThanOrEqual(50);
  });

  it("does not publish again when a review for this SHA exists", async () => {
    const publisher = new FakePublisher({ [`octo/demo#7@${SHA_A}`]: 77 });
    deps = makeDeps({ publisher, contextStore: deps.contextStore });
    const res = await processPublish(parentJob(judged()), deps);
    expect(res).toEqual({ superseded: false, reviewId: 77, inlinePosted: 0, existing: true });
    expect(publisher.published).toHaveLength(0);
    expect(deps.recorder.of("runFinished")[0]!.result.reviewId).toBe(77);
  });

  it("is idempotent across a retry of the same job", async () => {
    await processPublish(parentJob(judged()), deps);
    await processPublish(parentJob(judged()), deps);
    expect(deps.publisher.published).toHaveLength(1);
  });

  it("does not publish a superseded judge result", async () => {
    expect(await processPublish(parentJob({ superseded: true }), deps)).toEqual({ superseded: true });
    expect(deps.publisher.published).toHaveLength(0);
    expect(deps.recorder.statuses()).toEqual(["SUPERSEDED"]);
  });

  it("does not publish when a newer SHA arrived after the judge", async () => {
    await deps.contextStore.setLatest(REF, SHA_B);
    expect(await processPublish(parentJob(judged()), deps)).toEqual({ superseded: true });
    expect(deps.publisher.published).toHaveLength(0);
  });

  it("fails unrecoverably without a judge result", async () => {
    await expect(processPublish(parentJob(undefined), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processPublish(parentJob({ nonsense: 1 }), deps)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("rethrows a transient GitHub error for retry", async () => {
    deps.publisher.publish = async () => {
      throw new Error("502 Bad Gateway");
    };
    const err = await processPublish(parentJob(judged()), deps).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(deps.recorder.of("runFinished")).toHaveLength(0);
  });
});
