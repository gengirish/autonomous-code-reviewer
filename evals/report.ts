/**
 * Eval report: metrics + markdown summary, and the baseline regression rule (acr-evals).
 */
import { z } from "zod";
import { AGENTS } from "../src/schemas/index.js";
import {
  aggregate,
  type CaseEvaluation,
  type CaseRunRecord,
  type EvalMetrics,
  evaluateCase,
  type Rate,
} from "./metrics.js";
import { type ExpectedFinding, isPrScoped } from "./schema.js";

/** The parts of a Fixture the report needs (a loaded Fixture fits). */
export interface ReportFixture {
  id: string;
  meta: { clean: boolean; title: string };
  expected: readonly ExpectedFinding[];
}

export interface EvalReport {
  metrics: EvalMetrics;
  evaluations: CaseEvaluation[];
  markdown: string;
}

export function buildReport(records: readonly CaseRunRecord[], fixtures: readonly ReportFixture[]): EvalReport {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const evaluations = records.map((r) => {
    const fixture = byId.get(r.caseId);
    if (!fixture) throw new Error(`report: no fixture for case "${r.caseId}"`);
    return evaluateCase(r, { expected: fixture.expected, clean: fixture.meta.clean });
  });
  const metrics = aggregate(evaluations, records);
  return { metrics, evaluations, markdown: renderMarkdown(metrics, evaluations, records) };
}

// ───────────────────────────── markdown ─────────────────────────────

const pct = (r: Rate) => (r.value === null ? "n/a" : `${(r.value * 100).toFixed(1)}% (${r.numerator}/${r.denominator})`);
const ratio = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const usd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(4)}`);
const ms = (v: number | null) => (v === null ? "n/a" : `${(v / 1000).toFixed(1)}s`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function describeExpected(e: ExpectedFinding): string {
  const where = isPrScoped(e) ? "(PR-level)" : `\`${e.file}:${e.lineStart}${e.lineEnd !== e.lineStart ? `-${e.lineEnd}` : ""}\``;
  return `${where} ${e.category} (${e.agent}, ≥ ${e.minSeverity})${e.note ? `: ${e.note}` : ""}`;
}

function renderMarkdown(m: EvalMetrics, evaluations: readonly CaseEvaluation[], records: readonly CaseRunRecord[]): string {
  const lines: string[] = [];
  lines.push("# ACR eval report", "");
  lines.push(`${m.cases} cases, ${m.runs} runs (${m.cleanRuns} on clean PRs).`, "");

  lines.push("## Accuracy", "");
  lines.push("| Agent | Precision | Recall | Clean-PR FPs (≥ medium) | Clean-PR critical/high FPs |");
  lines.push("|---|---|---|---|---|");
  for (const agent of AGENTS) {
    const a = m.perAgent[agent];
    lines.push(`| ${agent} | ${pct(a.precision)} | ${pct(a.recall)} | ${a.cleanFalsePositives} | ${a.cleanCriticalHighFalsePositives} |`);
  }
  const o = m.overall;
  lines.push(
    `| **overall** | ${pct(o.precision)} | ${pct(o.recall)} | ${o.cleanFalsePositives} | ${o.cleanCriticalHighFalsePositives} |`,
    "",
  );
  lines.push("Merged findings count for every source agent, so per-agent rows can add up to more than overall.", "");

  lines.push("## Pipeline", "");
  lines.push("| Metric | Value |", "|---|---|");
  lines.push(`| Judge drop rate | ${pct(o.judgeDropRate)} |`);
  lines.push(`| Schema-failure rate | ${pct(o.schemaFailureRate)} |`);
  lines.push(`| Refusals | ${o.refusals} |`);
  lines.push(`| Cost per PR (mean) | ${usd(m.cost.meanPerPrUsd)} |`);
  lines.push(`| Cost total | ${usd(m.cost.totalUsd)} |`);
  lines.push(`| Latency p50 / p95 | ${ms(m.latency.p50Ms)} / ${ms(m.latency.p95Ms)} |`);
  lines.push(`| Cache read ratio | ${ratio(m.cache.readRatio)} |`, "");

  lines.push("## Cases", "");
  lines.push("| Case | Run | Clean | Expected | Matched | False positives | Cost | Latency | Errors |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  evaluations.forEach((e, i) => {
    const r = records[i] as CaseRunRecord;
    const problems = [
      r.refusals ? `${r.refusals} refused` : "",
      r.schemaFailures ? `${r.schemaFailures} schema` : "",
      r.errors?.length ? `${r.errors.length} other` : "",
    ].filter(Boolean);
    lines.push(
      `| ${e.caseId} | ${e.run} | ${e.clean ? "yes" : ""} | ${e.totals.expected} | ${e.totals.matchedExpected} | ${e.falsePositives.length} | ${usd(r.costUsd)} | ${ms(r.latencyMs)} | ${problems.join(", ")} |`,
    );
  });
  lines.push("");

  const missed = evaluations.flatMap((e) => e.missed.map((x) => ({ e, x })));
  lines.push("## Missed expected findings", "");
  if (missed.length === 0) lines.push("None.");
  for (const { e, x } of missed) lines.push(`- **${e.caseId}** (run ${e.run}): ${cell(describeExpected(x))}`);
  lines.push("");

  const fps = evaluations.flatMap((e) => e.falsePositives.map((f) => ({ e, f })));
  lines.push("## False positives (kept, unmatched)", "");
  if (fps.length === 0) lines.push("None.");
  for (const { e, f } of fps) {
    lines.push(
      `- **${e.caseId}** (run ${e.run})${e.clean ? " [clean]" : ""}: \`${f.file}:${f.line}\` ${f.finalSeverity} ${f.category} (${f.sourceAgents.join(", ")}): ${cell(f.title)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ───────────────────────────── baseline ─────────────────────────────

/** No agent may lose more than this much precision or recall (5 points). */
export const MAX_PRECISION_RECALL_DROP = 0.05;
/** Cost per PR may not rise more than this without the user agreeing. */
export const MAX_COST_INCREASE = 0.2;
const EPS = 1e-9;

const RateValue = z.object({ value: z.number().nullable() });
const BaselineMetrics = z.object({
  perAgent: z.record(z.string(), z.object({ precision: RateValue, recall: RateValue })),
  overall: z.object({ cleanCriticalHighFalsePositivesPerCleanRun: z.number().nullable() }),
  cost: z.object({ meanPerPrUsd: z.number().nullable() }),
});

/** evals/baseline.json: a placeholder until the first accepted run, then that run's metrics. */
export const BaselineFile = z.union([
  z.object({ status: z.literal("no-baseline-yet") }),
  z.object({
    status: z.literal("accepted"),
    acceptedAt: z.string().optional(),
    note: z.string().optional(),
    metrics: BaselineMetrics,
  }),
]);
export type BaselineFile = z.infer<typeof BaselineFile>;

/** The JSON to write to evals/baseline.json when a change is accepted. */
export function toBaseline(metrics: EvalMetrics, opts: { acceptedAt?: string; note?: string } = {}) {
  return { status: "accepted" as const, ...opts, metrics };
}

const points = (v: number) => `${(v * 100).toFixed(1)}`;

/**
 * The regression rule. `baseline` is the parsed evals/baseline.json (unknown: it is validated
 * here). Passes with the reason "no baseline" while baseline.json is the placeholder.
 */
export function compareToBaseline(metrics: EvalMetrics, baseline: unknown): { pass: boolean; reasons: string[] } {
  const parsed = BaselineFile.safeParse(baseline);
  if (!parsed.success) return { pass: false, reasons: [`baseline.json is invalid: ${parsed.error.message}`] };
  if (parsed.data.status === "no-baseline-yet") return { pass: true, reasons: ["no baseline"] };
  const base = parsed.data.metrics;
  const reasons: string[] = [];

  for (const agent of AGENTS) {
    const b = base.perAgent[agent];
    const c = metrics.perAgent[agent];
    if (!b) continue;
    for (const key of ["precision", "recall"] as const) {
      const before = b[key].value;
      const after = c[key].value;
      if (before === null || after === null) continue;
      if (before - after > MAX_PRECISION_RECALL_DROP + EPS) {
        reasons.push(
          `${agent} ${key} dropped ${points(before - after)} points (${points(before)}% → ${points(after)}%), more than ${points(MAX_PRECISION_RECALL_DROP)}`,
        );
      }
    }
  }

  const fpBefore = base.overall.cleanCriticalHighFalsePositivesPerCleanRun;
  const fpAfter = metrics.overall.cleanCriticalHighFalsePositivesPerCleanRun;
  if (fpBefore !== null && fpAfter !== null && fpAfter > fpBefore + EPS) {
    reasons.push(
      `clean-PR critical/high false positives increased (${fpBefore.toFixed(2)} → ${fpAfter.toFixed(2)} per clean run)`,
    );
  }

  const costBefore = base.cost.meanPerPrUsd;
  const costAfter = metrics.cost.meanPerPrUsd;
  if (costBefore !== null && costAfter !== null && costBefore > 0 && costAfter > costBefore * (1 + MAX_COST_INCREASE) + EPS) {
    reasons.push(
      `cost per PR rose ${(((costAfter - costBefore) / costBefore) * 100).toFixed(1)}% ($${costBefore.toFixed(4)} → $${costAfter.toFixed(4)}), more than ${MAX_COST_INCREASE * 100}%: needs the user's agreement`,
    );
  }

  return { pass: reasons.length === 0, reasons };
}
