import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_ROOT, loadFixture } from "../../../evals/fixture-source.js";
import { type Pipeline, runCase, runCaseOnce } from "../../../evals/harness.js";
import { AgentRefusedError, SchemaError } from "../../../src/core/errors.js";
import type { BuildReviewContext, LlmClient, LlmUsage, RunAgent, RunJudge } from "../../../src/core/ports.js";
import type { AgentName, JudgedFinding } from "../../../src/schemas/index.js";
import { aCheckedFinding, aContext, aReport } from "../../fakes/builders.js";
import { judged } from "./helpers.js";

const usage = (o: Partial<LlmUsage> = {}): LlmUsage => ({
  model: "claude-opus-5-5",
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadTokens: 3000,
  cacheWriteTokens: 0,
  ...o,
});

/** The pipeline never needs a real LLM here: the stubs only check that it is passed through. */
const dummyLlm: LlmClient = {
  async callStructured() {
    throw new Error("dummy llm: no calls expected");
  },
};

interface Calls {
  build: Parameters<BuildReviewContext>[0][];
  agents: Array<{ agent: AgentName; chunk: number }>;
  judge: Parameters<RunJudge>[0][];
}

function stubPipeline(opts: { chunks?: number; fail?: Partial<Record<AgentName, Error>>; judgeError?: Error; judged?: JudgedFinding[] } = {}) {
  const calls: Calls = { build: [], agents: [], judge: [] };
  const buildReviewContext: BuildReviewContext = async (input) => {
    calls.build.push(input);
    const total = opts.chunks ?? 1;
    return Array.from({ length: total }, (_, index) => aContext({ runId: input.runId, chunk: { index, total } }));
  };
  const runAgent: RunAgent = async (agent, ctx, deps) => {
    expect(deps.llm).toBe(dummyLlm);
    expect(typeof deps.renderContext).toBe("function");
    calls.agents.push({ agent, chunk: ctx.chunk.index });
    const err = opts.fail?.[agent];
    if (err) throw err;
    return {
      report: aReport({ agent, findings: [] }),
      checked: [aCheckedFinding({ agent })],
      usage: usage(),
      stopReason: "end_turn",
      latencyMs: 5,
    };
  };
  const runJudge: RunJudge = async (input, deps) => {
    expect(deps.llm).toBe(dummyLlm);
    calls.judge.push(input);
    if (opts.judgeError) throw opts.judgeError;
    return {
      output: {
        findings: opts.judged ?? [judged({ kept: true }), judged({ kept: false, dropReason: "duplicate" })],
        summary: "One injection risk.",
      },
      usage: usage({ inputTokens: 2000, cacheReadTokens: 0 }),
      stopReason: "end_turn",
      latencyMs: 9,
    };
  };
  const pipeline: Pipeline = {
    buildReviewContext,
    isSkippedPath: (path) => (path.endsWith(".lock") || path.startsWith("test/") ? "skipped by stub" : null),
    renderContext: () => "<rendered/>",
    runAgent,
    runJudge,
  };
  return { pipeline, calls };
}

const costOf = (u: LlmUsage) => u.inputTokens * 1e-6 + u.cacheReadTokens * 1e-7;
const fakeClock = () => {
  let t = 1000;
  return () => (t += 250);
};

describe("runCaseOnce", () => {
  it("runs prepare → 4 agents → judge and records the result", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "sec-sql-concat-express"));
    const { pipeline, calls } = stubPipeline();

    const record = await runCaseOnce(fixture, pipeline, dummyLlm, { costOf, clock: fakeClock() });

    expect(calls.agents.map((a) => a.agent).sort()).toEqual(["architecture", "coverage", "security", "style"]);
    expect(calls.judge).toHaveLength(1);
    expect(calls.judge[0]?.findings).toHaveLength(4);
    expect(calls.judge[0]?.reports).toHaveLength(4);
    expect(calls.judge[0]?.failedAgents).toEqual([]);
    expect(record).toMatchObject({
      caseId: "sec-sql-concat-express",
      run: 0,
      llmCalls: 5,
      schemaFailures: 0,
      refusals: 0,
      failedAgents: [],
      errors: [],
      inputTokens: 4 * 1000 + 2000,
      cacheReadTokens: 4 * 3000,
      outputTokens: 500,
      latencyMs: 250,
      judgeSummary: "One injection risk.",
    });
    expect(record.allJudged).toHaveLength(2);
    expect(record.kept).toHaveLength(1);
    expect(record.costUsd).toBeCloseTo(4 * (0.001 + 0.0003) + 0.002);
    expect(record.reports?.map((r) => r.agent).sort()).toEqual(["architecture", "coverage", "security", "style"]);
  });

  it("prepares like the worker: PR meta, contents for reviewable files only, lint configs", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "sec-sql-concat-express"));
    const { pipeline, calls } = stubPipeline();
    await runCaseOnce(fixture, pipeline, dummyLlm, { costOf, run: 2 });

    const input = calls.build[0];
    expect(input?.runId).toBe("evals__sec-sql-concat-express__r2");
    expect(input?.ref).toMatchObject({ owner: "acr-evals", repo: "sec-sql-concat-express" });
    expect(input?.meta.title).toBe(fixture.meta.title);
    expect(input?.files.map((f) => f.path)).toEqual(["src/routes/orders.ts", "test/routes/orders.test.ts"]);
    // test/ is skipped by the stub's isSkippedPath, so its content is never fetched
    expect([...(input?.contents.keys() ?? [])]).toEqual(["src/routes/orders.ts"]);
    expect(input?.contents.get("src/routes/orders.ts")?.startsWith('import { Router } from "express";')).toBe(true);
    expect(input?.lintConfigs.size).toBe(0);
  });

  it("does not fetch removed files and passes repo lint configs", async () => {
    const rename = await loadFixture(join(FIXTURES_ROOT, "clean-ts-rename-date-utils"));
    const a = stubPipeline();
    await runCaseOnce(rename, a.pipeline, dummyLlm, { costOf });
    expect(a.calls.build[0]?.files.map((f) => f.path)).toContain("src/utils/legacyFormat.ts");
    expect(a.calls.build[0]?.contents.has("src/utils/legacyFormat.ts")).toBe(false);
    expect(a.calls.build[0]?.contents.size).toBe(4);

    const style = await loadFixture(join(FIXTURES_ROOT, "style-eslint-config-inconsistency"));
    const b = stubPipeline();
    await runCaseOnce(style, b.pipeline, dummyLlm, { costOf });
    expect([...(b.calls.build[0]?.lintConfigs.keys() ?? [])]).toEqual([".eslintrc.json"]);
    expect(b.calls.build[0]?.lintConfigs.get(".eslintrc.json")).toContain('"no-console": "error"');
  });

  it("does not fetch files without a patch (empty new file)", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "sec-hardcoded-api-key"));
    const { pipeline, calls } = stubPipeline();
    await runCaseOnce(fixture, pipeline, dummyLlm, { costOf });
    expect(calls.build[0]?.files.find((f) => f.path === "app/shipping/__init__.py")?.patch).toBeUndefined();
    expect(calls.build[0]?.contents.has("app/shipping/__init__.py")).toBe(false);
  });

  it("counts refusals and schema failures, and still runs the judge", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "sec-sql-concat-express"));
    const { pipeline, calls } = stubPipeline({
      fail: {
        security: new AgentRefusedError("security", "cyber"),
        style: new SchemaError("bad output"),
        coverage: new Error("socket hang up"),
      },
    });

    const record = await runCaseOnce(fixture, pipeline, dummyLlm, { costOf });

    expect(record).toMatchObject({ refusals: 1, schemaFailures: 1, errors: ["Error: socket hang up"] });
    expect(record.failedAgents).toEqual(["security", "style", "coverage"]);
    expect(calls.judge[0]?.failedAgents).toEqual(["security", "style", "coverage"]);
    expect(calls.judge[0]?.findings).toHaveLength(1);
    expect(record.inputTokens).toBe(1000 + 2000);
  });

  it("records a failing judge as no findings", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "sec-sql-concat-express"));
    const { pipeline } = stubPipeline({ judgeError: new SchemaError("judge output invalid") });
    const record = await runCaseOnce(fixture, pipeline, dummyLlm, { costOf });
    expect(record).toMatchObject({ kept: [], allJudged: [], schemaFailures: 1 });
    expect(record.judgeSummary).toBeUndefined();
  });

  it("runs every agent on every chunk, and only the requested agents", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "sec-sql-concat-express"));
    const { pipeline, calls } = stubPipeline({ chunks: 2 });
    const record = await runCaseOnce(fixture, pipeline, dummyLlm, { costOf, agents: ["security", "style"] });
    expect(calls.agents.sort((x, y) => x.agent.localeCompare(y.agent) || x.chunk - y.chunk)).toEqual([
      { agent: "security", chunk: 0 },
      { agent: "security", chunk: 1 },
      { agent: "style", chunk: 0 },
      { agent: "style", chunk: 1 },
    ]);
    expect(record.llmCalls).toBe(5);
    expect(record.reports?.map((r) => r.chunk).sort()).toEqual([0, 0, 1, 1]);
  });
});

describe("runCase", () => {
  it("repeats sequentially with a run index per record", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "clean-ts-cursor-pagination"));
    const { pipeline, calls } = stubPipeline({ judged: [] });
    const records = await runCase(fixture, pipeline, dummyLlm, { costOf, repeat: 3 });
    expect(records.map((r) => r.run)).toEqual([0, 1, 2]);
    expect(calls.build.map((b) => b.runId)).toEqual([
      "evals__clean-ts-cursor-pagination__r0",
      "evals__clean-ts-cursor-pagination__r1",
      "evals__clean-ts-cursor-pagination__r2",
    ]);
    expect(records.every((r) => r.kept.length === 0)).toBe(true);
  });

  it("defaults to one run and rejects a bad repeat", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, "clean-ts-cursor-pagination"));
    const { pipeline } = stubPipeline();
    expect(await runCase(fixture, pipeline, dummyLlm, { costOf })).toHaveLength(1);
    await expect(runCase(fixture, pipeline, dummyLlm, { costOf, repeat: 0 })).rejects.toThrow(/repeat/);
  });
});
