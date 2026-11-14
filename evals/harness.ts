/**
 * Runs one fixture through the pipeline the worker runs (prepare → 4 agents in parallel →
 * judge), with no queues and no GitHub. The pipeline functions are injected, so evals
 * exercise the production parser/agents/judge (wired in evals/run-eval.ts) and tests can
 * stub them.
 */
import { performance } from "node:perf_hooks";
import { AgentRefusedError, SchemaError } from "../src/core/errors.js";
import type {
  BuildReviewContext,
  CostOf,
  IsSkippedPath,
  LlmClient,
  LlmUsage,
  RenderContext,
  RunAgent,
  RunJudge,
} from "../src/core/ports.js";
import { AGENTS, type AgentName, type AgentReport, type CheckedFinding } from "../src/schemas/index.js";
import { type Fixture, FixturePrSource, fixtureRef } from "./fixture-source.js";
import type { CaseRunRecord } from "./metrics.js";

export interface Pipeline {
  buildReviewContext: BuildReviewContext;
  isSkippedPath: IsSkippedPath;
  renderContext: RenderContext;
  runAgent: RunAgent;
  runJudge: RunJudge;
}

/**
 * Repo lint configs probed through PrSource.getRepoFile. If the worker exports its own list,
 * pass that as `lintConfigPaths` instead so evals and production see the same files.
 */
export const DEFAULT_LINT_CONFIG_PATHS: readonly string[] = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  "prettier.config.js",
  "biome.json",
  "ruff.toml",
  ".ruff.toml",
  "pyproject.toml",
  "setup.cfg",
  ".flake8",
  ".golangci.yml",
  ".golangci.yaml",
  ".editorconfig",
];

export interface RunCaseOptions {
  /** USD for one call's usage (src/llm costOf). */
  costOf: CostOf;
  /** Agents to run (`--agent`). Default: all four. */
  agents?: readonly AgentName[];
  /** Runs per case (`--repeat`). Default 1. Repeats run one after another. */
  repeat?: number;
  lintConfigPaths?: readonly string[];
  maxTokensPerChunk?: number;
  countTokens?: (text: string) => Promise<number>;
  /** Milliseconds clock, injectable for tests. Default performance.now. */
  clock?: () => number;
}

const errorMessage = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

/** One run of one fixture. */
export async function runCaseOnce(
  fixture: Fixture,
  pipeline: Pipeline,
  llm: LlmClient,
  opts: RunCaseOptions & { run?: number },
): Promise<CaseRunRecord> {
  const clock = opts.clock ?? (() => performance.now());
  const run = opts.run ?? 0;
  const agents = opts.agents ?? AGENTS;
  const started = clock();

  // ── prepare (mirrors the worker's prepare step) ──
  const source = new FixturePrSource(fixture);
  const ref = fixtureRef(fixture);
  const runId = `evals__${fixture.id}__r${run}`;
  const meta = await source.getPr(ref);
  const files = await source.listFiles(ref);

  const reviewable = files.filter(
    (f) => f.status !== "removed" && f.patch !== undefined && pipeline.isSkippedPath(f.path) === null,
  );
  const contents = new Map<string, string>();
  await Promise.all(
    reviewable.map(async (f) => {
      contents.set(f.path, await source.getContent(ref, f));
    }),
  );
  const lintConfigs = new Map<string, string>();
  for (const path of opts.lintConfigPaths ?? DEFAULT_LINT_CONFIG_PATHS) {
    const text = await source.getRepoFile(ref, path, meta.headSha);
    if (text !== null) lintConfigs.set(path, text);
  }

  const contexts = await pipeline.buildReviewContext({
    runId,
    ref,
    meta,
    files,
    contents,
    lintConfigs,
    ...(opts.maxTokensPerChunk === undefined ? {} : { maxTokensPerChunk: opts.maxTokensPerChunk }),
    ...(opts.countTokens === undefined ? {} : { countTokens: opts.countTokens }),
  });

  // ── agents: every (chunk, agent) pair in parallel ──
  const usages: LlmUsage[] = [];
  const errors: string[] = [];
  const failed = new Set<AgentName>();
  let refusals = 0;
  let schemaFailures = 0;
  let llmCalls = 0;
  const countFailure = (err: unknown) => {
    if (err instanceof AgentRefusedError) refusals++;
    else if (err instanceof SchemaError) schemaFailures++;
    else errors.push(errorMessage(err));
  };

  const jobs = contexts.flatMap((ctx) => agents.map((agent) => ({ ctx, agent })));
  llmCalls += jobs.length;
  const settled = await Promise.allSettled(
    jobs.map(({ ctx, agent }) => pipeline.runAgent(agent, ctx, { llm, renderContext: pipeline.renderContext })),
  );

  const reports: Array<{ agent: AgentName; chunk: number; report: AgentReport }> = [];
  const findings: CheckedFinding[] = [];
  settled.forEach((result, i) => {
    const { ctx, agent } = jobs[i] as (typeof jobs)[number];
    if (result.status === "fulfilled") {
      usages.push(result.value.usage);
      reports.push({ agent, chunk: ctx.chunk.index, report: result.value.report });
      findings.push(...result.value.checked);
    } else {
      failed.add(agent);
      countFailure(result.reason);
    }
  });

  // ── judge (runs even when some agents failed, like the worker) ──
  let kept: CaseRunRecord["kept"] = [];
  let allJudged: CaseRunRecord["allJudged"] = [];
  let judgeSummary: string | undefined;
  llmCalls++;
  try {
    const judged = await pipeline.runJudge(
      {
        runId,
        findings,
        reports: reports.map((r) => r.report),
        contexts,
        failedAgents: AGENTS.filter((a) => failed.has(a)),
      },
      { llm },
    );
    usages.push(judged.usage);
    allJudged = judged.output.findings;
    kept = allJudged.filter((f) => f.kept);
    judgeSummary = judged.output.summary;
  } catch (err) {
    countFailure(err);
  }

  const total = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") =>
    usages.reduce((acc, u) => acc + u[key], 0);
  return {
    caseId: fixture.id,
    run,
    kept,
    allJudged,
    costUsd: usages.reduce((acc, u) => acc + opts.costOf(u), 0),
    latencyMs: Math.max(0, clock() - started),
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cacheReadTokens: total("cacheReadTokens"),
    cacheWriteTokens: total("cacheWriteTokens"),
    llmCalls,
    schemaFailures,
    refusals,
    failedAgents: AGENTS.filter((a) => failed.has(a)),
    errors,
    reports,
    ...(judgeSummary === undefined ? {} : { judgeSummary }),
  };
}

/** `opts.repeat` runs of one fixture (default 1), one CaseRunRecord each. */
export async function runCase(
  fixture: Fixture,
  pipeline: Pipeline,
  llm: LlmClient,
  opts: RunCaseOptions,
): Promise<CaseRunRecord[]> {
  const repeat = opts.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`repeat must be a positive integer, got ${repeat}`);
  const records: CaseRunRecord[] = [];
  for (let run = 0; run < repeat; run++) records.push(await runCaseOnce(fixture, pipeline, llm, { ...opts, run }));
  return records;
}
