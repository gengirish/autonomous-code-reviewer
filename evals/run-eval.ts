/**
 * Eval CLI (acr-evals). LIVE Claude calls: costs real money.
 *
 *   npm run eval -- [--case <glob>] [--agent <name>]... [--repeat N] [--record <dir>] [--yes]
 *
 * Without --yes it prints the case list and a cost estimate, then exits without calling Claude.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runAgent } from "../src/agents/index.js";
import { runJudge } from "../src/judge/index.js";
import { AnthropicLlmClient, costOf } from "../src/llm/index.js";
import { buildReviewContext, isSkippedPath, renderContext } from "../src/parser/index.js";
import { AGENTS, AgentName } from "../src/schemas/index.js";
import { DEFAULT_LINT_CONFIG_PATHS } from "../src/worker/exports.js";
import { loadAllFixtures } from "./fixture-source.js";
import { runCase, type Pipeline } from "./harness.js";
import type { CaseRunRecord } from "./metrics.js";
import { buildReport, compareToBaseline } from "./report.js";

const EST_USD_PER_RUN = { low: 0.3, high: 0.6 };

const { values } = parseArgs({
  options: {
    case: { type: "string" },
    agent: { type: "string", multiple: true },
    repeat: { type: "string", default: "1" },
    record: { type: "string" },
    yes: { type: "boolean", default: false },
  },
  strict: true,
});

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

async function main() {
  const repeat = Number.parseInt(values.repeat ?? "1", 10);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
  const agents = values.agent?.map((a) => AgentName.parse(a)) ?? [...AGENTS];

  const all = await loadAllFixtures();
  const pattern = values.case ? globToRegExp(values.case) : null;
  const fixtures = pattern ? all.filter((f) => pattern.test(f.id)) : all;
  if (fixtures.length === 0) throw new Error(`no fixtures match --case ${values.case}`);

  const runs = fixtures.length * repeat;
  const scale = agents.length / AGENTS.length;
  const est = (n: number) => `$${(n * runs * (0.25 + 0.75 * scale)).toFixed(2)}`;
  console.log(`Cases (${fixtures.length}): ${fixtures.map((f) => f.id).join(", ")}`);
  console.log(`Agents: ${agents.join(", ")} · repeat ${repeat} · ${runs} runs`);
  console.log(`Estimated cost: ${est(EST_USD_PER_RUN.low)}–${est(EST_USD_PER_RUN.high)} (live Claude calls)`);
  if (!values.yes) {
    console.log("\nDry run. Re-run with --yes to call Claude.");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const pipeline: Pipeline = { buildReviewContext, isSkippedPath, renderContext, runAgent, runJudge };
  const llm = new AnthropicLlmClient();
  const records: CaseRunRecord[] = [];
  const failedCases: string[] = [];

  for (const fixture of fixtures) {
    process.stdout.write(`▶ ${fixture.id} … `);
    try {
      const recs = await runCase(fixture, pipeline, llm, {
        costOf,
        agents,
        repeat,
        lintConfigPaths: DEFAULT_LINT_CONFIG_PATHS,
      });
      records.push(...recs);
      const cost = recs.reduce((s, r) => s + r.costUsd, 0);
      console.log(`done ($${cost.toFixed(3)})`);
    } catch (err) {
      failedCases.push(fixture.id);
      console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { metrics, markdown } = buildReport(records, fixtures);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = "evals/results";
  mkdirSync(resultsDir, { recursive: true });
  const resultFile = join(resultsDir, `${stamp}.json`);
  writeFileSync(resultFile, JSON.stringify({ args: values, failedCases, metrics, records, markdown }, null, 2));

  if (values.record) {
    mkdirSync(values.record, { recursive: true });
    for (const r of records) {
      writeFileSync(
        join(values.record, `${r.caseId}${r.run !== undefined ? `.run${r.run}` : ""}.json`),
        JSON.stringify({ reports: r.reports, judge: { findings: r.allJudged, summary: r.judgeSummary } }, null, 2),
      );
    }
  }

  console.log(`\n${markdown}\nResults: ${resultFile}`);
  if (failedCases.length) console.log(`Cases that errored: ${failedCases.join(", ")}`);

  const baseline = JSON.parse(readFileSync("evals/baseline.json", "utf8")) as unknown;
  const verdict = compareToBaseline(metrics, baseline);
  console.log(`\nBaseline check: ${verdict.pass ? "PASS" : "FAIL"}`);
  for (const r of verdict.reasons) console.log(`  - ${r}`);
  if (!verdict.pass || failedCases.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
