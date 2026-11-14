/** Stub pipeline functions + a recording RunRecorder for processor and flow tests. */
import type { FlowProducer } from "bullmq";
import { pino } from "pino";
import type {
  BuildReviewContext,
  ContextStore,
  DecideEvent,
  LlmClient,
  PrFile,
  PrMeta,
  RenderReview,
  RunAgent,
  RunJudge,
  RunRecorder,
  RunStatus,
  StructuredRequest,
} from "../../../src/core/ports.js";
import { DEFAULT_REPO_CONFIG } from "../../../src/core/ports.js";
import { AgentReport, JudgeOutput, runKey, type PrepareJob, type PrRef } from "../../../src/schemas/index.js";
import type { WorkerDeps } from "../../../src/worker/deps.js";
import { aContext, aReport, SHA_A, SHA_B } from "../../fakes/builders.js";
import { FakePrSource, FakePublisher } from "../../fakes/fake-github.js";
import { byLabel, FakeLlm } from "../../fakes/fake-llm.js";
import { MemoryContextStore } from "../../fakes/memory-context-store.js";

export const REF: PrRef = { owner: "octo", repo: "demo", pr: 7 };
export const RUN_ID = runKey(REF, SHA_A);

export const prepareJob = (o: Partial<PrepareJob> = {}): PrepareJob => ({
  ...REF,
  baseSha: SHA_B,
  headSha: SHA_A,
  runId: RUN_ID,
  ...o,
});

export const aMeta = (o: Partial<PrMeta> = {}): PrMeta => ({
  headSha: SHA_A,
  baseSha: SHA_B,
  title: "Add user lookup",
  body: "",
  draft: false,
  state: "open",
  ...o,
});

export const aFile = (o: Partial<PrFile> = {}): PrFile => ({
  path: "src/db/users.ts",
  status: "modified",
  patch: "@@ -40,3 +40,4 @@\n a\n b\n+x\n c",
  blobSha: "f".repeat(40),
  additions: 1,
  deletions: 0,
  ...o,
});

type RecorderEvent =
  | { type: "runQueued"; runId: string }
  | { type: "runStatus"; runId: string; status: RunStatus; error?: string }
  | { type: "agentReport"; runId: string; agent: string; chunk: number; status: string; summary?: string }
  | { type: "llmCall"; runId: string; label: string; costUsd: number }
  | { type: "findings"; runId: string; findings: Array<{ inline: boolean; title: string }> }
  | { type: "runFinished"; runId: string; result: Parameters<RunRecorder["runFinished"]>[1] };

export class RecordingRecorder implements RunRecorder {
  readonly events: RecorderEvent[] = [];
  async runQueued(job: PrepareJob) {
    this.events.push({ type: "runQueued", runId: job.runId });
  }
  async runStatus(runId: string, status: RunStatus, error?: string) {
    this.events.push({ type: "runStatus", runId, status, ...(error === undefined ? {} : { error }) });
  }
  async agentReport(runId: string, agent: string, chunk: number, status: string, summary?: string) {
    this.events.push({ type: "agentReport", runId, agent, chunk, status, ...(summary === undefined ? {} : { summary }) });
  }
  async llmCall(runId: string, label: string, _u: unknown, _s: string, _l: number, costUsd: number) {
    this.events.push({ type: "llmCall", runId, label, costUsd });
  }
  async findings(runId: string, findings: Array<{ inline: boolean; title: string }>) {
    this.events.push({ type: "findings", runId, findings });
  }
  async runFinished(runId: string, result: Parameters<RunRecorder["runFinished"]>[1]) {
    this.events.push({ type: "runFinished", runId, result });
  }
  statuses(runId?: string): RunStatus[] {
    return this.events.flatMap((e) => (e.type === "runStatus" && (!runId || e.runId === runId) ? [e.status] : []));
  }
  of<T extends RecorderEvent["type"]>(type: T): Array<Extract<RecorderEvent, { type: T }>> {
    return this.events.filter((e): e is Extract<RecorderEvent, { type: T }> => e.type === type);
  }
}

/** Builds one context per `chunks` from the PR meta (enough for queue/worker tests). */
export const stubBuildReviewContext =
  (chunks = 1, onBuild?: (input: Parameters<BuildReviewContext>[0]) => void | Promise<void>): BuildReviewContext =>
  async (input) => {
    await onBuild?.(input);
    return Array.from({ length: chunks }, (_, index) =>
      aContext({
        runId: input.runId,
        owner: input.ref.owner,
        repo: input.ref.repo,
        pr: input.ref.pr,
        headSha: input.meta.headSha,
        baseSha: input.meta.baseSha,
        chunk: { index, total: chunks },
      }),
    );
  };

/** Calls the LLM (so FakeLlm counts calls) and checks every finding as commentable. */
export const stubRunAgent: RunAgent = async (agent, ctx, { llm, renderContext }) => {
  const res = await llm.callStructured({
    label: agent,
    runId: ctx.runId,
    system: "agent",
    userContent: renderContext(ctx),
    cacheUserContent: true,
    schema: AgentReport,
    effort: "medium",
  });
  return {
    report: res.output,
    checked: res.output.findings.map((f) => ({ ...f, agent, commentable: true, unverified: false })),
    usage: res.usage,
    stopReason: res.stopReason,
    latencyMs: res.latencyMs,
  };
};

export const stubRunJudge: RunJudge = async (input, { llm }) => {
  const res = await llm.callStructured({
    label: "judge",
    runId: input.runId,
    system: "judge",
    userContent: JSON.stringify(input.findings),
    cacheUserContent: false,
    schema: JudgeOutput,
    effort: "high",
  });
  return { output: res.output, usage: res.usage, stopReason: res.stopReason, latencyMs: res.latencyMs };
};

export const stubDecideEvent: DecideEvent = (findings) =>
  findings.some((f) => f.kept && (f.finalSeverity === "critical" || f.finalSeverity === "high")) ? "REQUEST_CHANGES" : "COMMENT";

/** Records every input so tests can assert failedAgents etc.; inlines every kept finding. */
export const recordingRenderReview = (seen: Array<Parameters<RenderReview>[0]>): RenderReview => (input) => {
  seen.push(input);
  const inlineFindingIndexes = input.judge.findings.flatMap((f, i) => (f.kept ? [i] : []));
  return {
    body: `review ${input.runId} failed=[${input.failedAgents.join(",")}] ${input.judge.summary}\n<!-- ai-reviewer run=${input.runId} sha=${input.headSha} -->`,
    comments: inlineFindingIndexes.map((i) => {
      const f = input.judge.findings[i]!;
      return { path: f.file, line: f.line, side: "RIGHT" as const, body: f.title };
    }),
    inlineFindingIndexes,
  };
};

/** A JudgeOutput that keeps every input finding as-is. */
export const keepAll = (findings: Array<AgentReport["findings"][number] & { agent: AgentReport["agent"] }>): JudgeOutput => ({
  findings: findings.map((f, i) => ({
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    title: f.title,
    rationale: f.rationale,
    evidence: f.evidence,
    confidence: f.confidence,
    sourceIndexes: [i],
    sourceAgents: [f.agent],
    kept: true,
    finalSeverity: f.severity,
  })),
  summary: "Merged.",
});

/** LLM that answers every agent with aReport and the judge with keepAll(input). */
export const defaultLlm = (overrides: Parameters<typeof byLabel>[0] = {}) =>
  new FakeLlm(
    byLabel({
      security: aReport({ agent: "security" }),
      style: aReport({ agent: "style", findings: [], summary: "Clean." }),
      coverage: aReport({ agent: "coverage", findings: [], summary: "Clean." }),
      architecture: aReport({ agent: "architecture", findings: [], summary: "Clean." }),
      judge: (req: StructuredRequest<unknown>) => keepAll(JSON.parse(req.userContent)),
      ...overrides,
    }),
  );

export interface TestDeps extends WorkerDeps {
  llm: FakeLlm;
  recorder: RecordingRecorder;
  contextStore: ContextStore;
  source: FakePrSource;
  publisher: FakePublisher;
  rendered: Array<Parameters<RenderReview>[0]>;
  flowCalls: unknown[];
}

/**
 * Deps over the fakes. `flowProducer` defaults to a recorder of `add` calls (unit tests);
 * integration tests pass a real FlowProducer.
 */
export function makeDeps(o: Partial<WorkerDeps> & { llm?: LlmClient; source?: FakePrSource; publisher?: FakePublisher } = {}): TestDeps {
  const source = o.source ?? new FakePrSource(aMeta(), [aFile()], { "src/db/users.ts": "export const findUser = 1;\n" });
  const publisher = o.publisher ?? new FakePublisher();
  const rendered: Array<Parameters<RenderReview>[0]> = [];
  const flowCalls: unknown[] = [];
  const fakeFlow = { add: async (flow: unknown) => (flowCalls.push(flow), { job: {} }) } as unknown as FlowProducer;
  return {
    prSourceFor: async () => source,
    publisherFor: async () => publisher,
    contextStore: new MemoryContextStore(),
    recorder: new RecordingRecorder(),
    repoConfig: async () => DEFAULT_REPO_CONFIG,
    buildReviewContext: stubBuildReviewContext(),
    isSkippedPath: (p) => (p.endsWith(".lock") || p.startsWith("dist/") ? "generated or lockfile" : null),
    renderContext: (ctx) => JSON.stringify(ctx),
    runAgent: stubRunAgent,
    runJudge: stubRunJudge,
    decideEvent: stubDecideEvent,
    renderReview: recordingRenderReview(rendered),
    costOf: () => 0.01,
    logger: pino({ level: "silent" }),
    flowProducer: fakeFlow,
    ...o,
    llm: (o.llm as FakeLlm | undefined) ?? defaultLlm(),
    source,
    publisher,
    rendered,
    flowCalls,
  } as TestDeps;
}
