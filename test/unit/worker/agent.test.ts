import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentRefusedError, SchemaError } from "../../../src/core/errors.js";
import { processAgent } from "../../../src/worker/processors/agent.js";
import { aContext, aReport, SHA_A, SHA_B } from "../../fakes/builders.js";
import { byLabel, FakeLlm } from "../../fakes/fake-llm.js";
import { makeDeps, REF, RUN_ID, type TestDeps } from "./stubs.js";

const job = (data: unknown = { runId: RUN_ID, agent: "security", chunk: 0 }) => ({ id: "j", data });

describe("processAgent", () => {
  let deps: TestDeps;
  beforeEach(async () => {
    deps = makeDeps();
    await deps.contextStore.putContexts(RUN_ID, [aContext()]);
    await deps.contextStore.setLatest(REF, SHA_A);
  });

  it("runs the agent and returns a JSON-serialisable result", async () => {
    const res = await processAgent(job(), deps);
    expect(res).toMatchObject({ superseded: false, agent: "security", chunk: 0, costUsd: 0.01, report: aReport() });
    expect(res.superseded === false && res.checked).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(res))).toEqual(res);
    expect(deps.recorder.of("llmCall")).toEqual([{ type: "llmCall", runId: RUN_ID, label: "security", costUsd: 0.01 }]);
    expect(deps.recorder.of("agentReport")).toMatchObject([{ agent: "security", chunk: 0, status: "ok" }]);
  });

  it("returns superseded without calling the LLM when a newer SHA exists", async () => {
    await deps.contextStore.setLatest(REF, SHA_B);
    expect(await processAgent(job(), deps)).toEqual({ superseded: true });
    expect(deps.llm.calls).toHaveLength(0);
  });

  it.each([
    [new AgentRefusedError("security", "cyber"), "refused"],
    [new SchemaError("bad output twice"), "failed"],
  ])("maps a permanent error (%s) to UnrecoverableError", async (error, status) => {
    deps = makeDeps({
      llm: new FakeLlm(() => {
        throw error;
      }),
      contextStore: deps.contextStore,
    });
    await expect(processAgent(job(), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(deps.recorder.of("agentReport")).toMatchObject([{ agent: "security", status }]);
  });

  it("rethrows transient errors so BullMQ retries", async () => {
    deps = makeDeps({ llm: new FakeLlm(byLabel({})), contextStore: deps.contextStore });
    const err = await processAgent(job(), deps).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(deps.recorder.of("agentReport")).toHaveLength(0);
  });

  it("fails unrecoverably when the contexts expired or the chunk does not exist", async () => {
    await expect(processAgent(job({ runId: "other", agent: "style", chunk: 0 }), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(processAgent(job({ runId: RUN_ID, agent: "style", chunk: 3 }), deps)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("rejects a malformed payload", async () => {
    await expect(processAgent(job({ runId: RUN_ID, agent: "nope", chunk: 0 }), deps)).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
