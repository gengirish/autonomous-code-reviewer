import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it } from "vitest";
import { SchemaError } from "../../../src/core/errors.js";
import type { AgentName, CheckedFinding } from "../../../src/schemas/index.js";
import { NO_FINDINGS_SUMMARY, processJudge } from "../../../src/worker/processors/judge.js";
import type { AgentResultOk } from "../../../src/worker/results.js";
import { aCheckedFinding, aContext, aReport, SHA_A, SHA_B } from "../../fakes/builders.js";
import { FakeLlm } from "../../fakes/fake-llm.js";
import { keepAll, makeDeps, REF, RUN_ID, type TestDeps } from "./stubs.js";

const ok = (agent: AgentName, chunk = 0, checked: CheckedFinding[] = []): AgentResultOk => ({
  superseded: false,
  agent,
  chunk,
  report: aReport({ agent, findings: checked }),
  checked,
  costUsd: 0.01,
});

const parentJob = (values: Record<string, unknown>, failures: Record<string, string> = {}) => ({
  id: `${RUN_ID}__judge`,
  data: { runId: RUN_ID },
  getChildrenValues: async () => values,
  getIgnoredChildrenFailures: async () => failures,
});

const finding = (agent: AgentName, title: string) => aCheckedFinding({ agent, title });

describe("processJudge", () => {
  let deps: TestDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await deps.contextStore.putContexts(RUN_ID, [aContext(), aContext({ chunk: { index: 1, total: 2 } })]);
    await deps.contextStore.setLatest(REF, SHA_A);
  });

  it("flattens findings in AGENTS order then chunk, judges, decides and renders", async () => {
    const values = {
      "k1": ok("coverage", 0, [finding("coverage", "c0")]),
      "k2": ok("security", 1, [finding("security", "s1")]),
      "k3": ok("security", 0, [finding("security", "s0")]),
      "k4": ok("style", 0),
      "k5": ok("architecture", 0, [finding("architecture", "a0")]),
    };
    const res = await processJudge(parentJob(values), deps);

    const judgeCalls = deps.llm.callsFor("judge");
    expect(judgeCalls).toHaveLength(1);
    expect((JSON.parse(judgeCalls[0]!.userContent) as CheckedFinding[]).map((f) => f.title)).toEqual(["s0", "s1", "c0", "a0"]);
    expect(deps.rendered[0]!.inputFindings.map((f) => f.title)).toEqual(["s0", "s1", "c0", "a0"]);
    expect(deps.rendered[0]!.failedAgents).toEqual([]);
    expect(res).toMatchObject({
      superseded: false,
      ref: REF,
      headSha: SHA_A,
      event: "REQUEST_CHANGES",
      inlineFindingIndexes: [0, 1, 2, 3],
      failedAgents: [],
      chunks: 2,
    });
    expect(res.superseded === false && res.costUsd).toBeCloseTo(0.06); // 5 agent jobs + judge
    expect(res.superseded === false && res.judged).toHaveLength(4);
    expect(deps.recorder.of("llmCall")).toMatchObject([{ label: "judge" }]);
  });

  it("names an agent with no successful chunk in failedAgents", async () => {
    const values = { a: ok("security", 0, [finding("security", "s0")]), b: ok("style"), c: ok("architecture") };
    const res = await processJudge(parentJob(values, { [`bull:acr-agent:${RUN_ID}__coverage__0`]: "boom" }), deps);
    expect(res.superseded === false && res.failedAgents).toEqual(["coverage"]);
    expect(deps.rendered[0]!.failedAgents).toEqual(["coverage"]);
  });

  it("skips the judge call when no agent found anything", async () => {
    const values = { a: ok("security"), b: ok("style"), c: ok("coverage"), d: ok("architecture") };
    const res = await processJudge(parentJob(values), deps);
    expect(deps.llm.calls).toHaveLength(0);
    expect(deps.rendered[0]!.judge).toEqual({ findings: [], summary: NO_FINDINGS_SUMMARY });
    expect(res).toMatchObject({ superseded: false, event: "COMMENT", judged: [], costUsd: 0.04 });
  });

  it("fails unrecoverably and records FAILED when every agent failed", async () => {
    await expect(processJudge(parentJob({}, { x: "boom" }), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(deps.recorder.statuses()).toEqual(["FAILED"]);
    expect(deps.rendered).toHaveLength(0);
  });

  it("returns superseded without calling the LLM when a newer SHA exists", async () => {
    await deps.contextStore.setLatest(REF, SHA_B);
    const res = await processJudge(parentJob({ a: ok("security", 0, [finding("security", "s0")]) }), deps);
    expect(res).toEqual({ superseded: true });
    expect(deps.llm.calls).toHaveLength(0);
  });

  it("returns superseded when an agent child was superseded", async () => {
    const res = await processJudge(parentJob({ a: ok("security", 0, [finding("security", "s0")]), b: { superseded: true } }), deps);
    expect(res).toEqual({ superseded: true });
    expect(deps.llm.calls).toHaveLength(0);
  });

  it("maps a permanent judge error to UnrecoverableError", async () => {
    deps = makeDeps({
      contextStore: deps.contextStore,
      llm: new FakeLlm(() => {
        throw new SchemaError("judge output invalid twice");
      }),
    });
    await expect(processJudge(parentJob({ a: ok("security", 0, [finding("security", "s0")]) }), deps)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(deps.recorder.statuses()).toEqual(["FAILED"]);
  });

  it("fails unrecoverably when the contexts expired", async () => {
    const job = { ...parentJob({}), data: { runId: "expired" } };
    await expect(processJudge(job, deps)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("keepAll helper keeps sourceIndexes aligned", () => {
    expect(keepAll([finding("security", "x")]).findings[0]!.sourceIndexes).toEqual([0]);
  });
});
