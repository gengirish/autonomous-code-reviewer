/**
 * Cross-module integration (offline): REAL parser, agents (post-checks), judge (post-validation),
 * verdict rule, renderer and eval metrics on a real fixture PR. Only the LLM is faked.
 * Catches contract drift between modules built in parallel.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../../../src/agents/index.js";
import { DEFAULT_REPO_CONFIG } from "../../../src/core/ports.js";
import { decideEvent, runJudge } from "../../../src/judge/index.js";
import { costOf } from "../../../src/llm/index.js";
import { buildReviewContext, isSkippedPath, renderContext } from "../../../src/parser/index.js";
import { renderReview } from "../../../src/render/index.js";
import { AGENTS, type AgentReport, type Finding, type JudgeOutput } from "../../../src/schemas/index.js";
import { FixturePrSource, FIXTURES_ROOT, fixtureRef, loadFixture } from "../../../evals/fixture-source.js";
import { runCase } from "../../../evals/harness.js";
import { buildReport } from "../../../evals/report.js";
import { FakeLlm } from "../../fakes/fake-llm.js";

const CASE = "sec-sql-concat-express";
const FILE = "src/routes/orders.ts";
const LINE = 24;

const sqlFinding: Finding = {
  file: FILE,
  line: LINE,
  severity: "high",
  category: "sql-injection",
  title: "Order status from the query string is interpolated into SQL",
  rationale: "req.query.status reaches the SQL text unescaped; an attacker can alter the WHERE clause.",
  evidence: "sql += ` AND status = '${status}'`;",
  suggestion: "Bind status as a parameter like customer_id.",
  confidence: 0.95,
};

/** Security reports the seeded issue, the other agents report nothing, the judge keeps it. */
const llm = () =>
  new FakeLlm((req) => {
    if (req.label === "judge") {
      const out: JudgeOutput = {
        findings: [{ ...sqlFinding, sourceIndexes: [0], sourceAgents: ["security"], kept: true, finalSeverity: "high" }],
        summary: "One SQL injection risk in the new order filter.",
      };
      return out;
    }
    const report: AgentReport = { agent: req.label, summary: "", findings: req.label === "security" ? [sqlFinding] : [] };
    return report;
  });

describe("end-to-end pipeline on a fixture PR (fake LLM)", () => {
  it("parser → agents → judge → verdict → renderer produce a REQUEST_CHANGES review with the inline comment", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, CASE));
    const source = new FixturePrSource(fixture);
    const ref = fixtureRef(fixture);
    const meta = await source.getPr(ref);
    const files = await source.listFiles(ref);
    const contents = new Map<string, string>();
    for (const f of files) {
      if (f.status !== "removed" && f.patch && !isSkippedPath(f.path)) contents.set(f.path, await source.getContent(ref, f));
    }
    const contexts = await buildReviewContext({ runId: "e2e", ref, meta, files, contents, lintConfigs: new Map() });
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0]!;
    expect(ctx.files.find((f) => f.path === FILE)?.commentableLines).toContain(LINE);

    const fake = llm();
    const results = await Promise.all(AGENTS.map((a) => runAgent(a, ctx, { llm: fake, renderContext })));
    const checked = results.flatMap((r) => r.checked);
    expect(checked).toHaveLength(1);
    // Agents' evidence check must accept code copied from the parser's rendering.
    expect(checked[0]).toMatchObject({ agent: "security", commentable: true, unverified: false });

    // Cache discipline across the real renderer + real agents.
    const agentCalls = fake.calls.filter((c) => c.label !== "judge");
    expect(new Set(agentCalls.map((c) => c.system)).size).toBe(1);
    expect(new Set(agentCalls.map((c) => c.userContent)).size).toBe(1);
    expect(new Set(agentCalls.map((c) => c.roleInstructions)).size).toBe(4);

    const judged = await runJudge(
      { runId: "e2e", findings: checked, reports: results.map((r) => r.report), contexts, failedAgents: [] },
      { llm: fake },
    );
    const event = decideEvent(judged.output.findings, DEFAULT_REPO_CONFIG);
    expect(event).toBe("REQUEST_CHANGES");

    const review = renderReview({
      runId: "e2e",
      headSha: meta.headSha,
      event,
      judge: judged.output,
      inputFindings: checked,
      reports: results.map((r) => r.report),
      failedAgents: [],
      contexts,
      cfg: DEFAULT_REPO_CONFIG,
    });
    expect(review.comments).toEqual([expect.objectContaining({ path: FILE, line: LINE, side: "RIGHT" })]);
    expect(review.inlineFindingIndexes).toEqual([0]);
    expect(review.body.trimEnd().endsWith(`<!-- ai-reviewer run=e2e sha=${meta.headSha} -->`)).toBe(true);
  });

  it("eval harness + metrics score the same run as a full match", async () => {
    const fixture = await loadFixture(join(FIXTURES_ROOT, CASE));
    const records = await runCase(
      fixture,
      { buildReviewContext, isSkippedPath, renderContext, runAgent, runJudge },
      llm(),
      { costOf },
    );
    const { metrics } = buildReport(records, [fixture]);
    expect(metrics.overall.recall.value).toBe(1);
    expect(metrics.overall.precision.value).toBe(1);
  });
});
