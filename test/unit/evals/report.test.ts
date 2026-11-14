import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { EvalMetrics } from "../../../evals/metrics.js";
import { buildReport, compareToBaseline, toBaseline } from "../../../evals/report.js";
import type { ExpectedFinding } from "../../../evals/schema.js";
import { aRecord, judged } from "./helpers.js";

const expected: ExpectedFinding[] = [
  { file: "src/db/users.ts", lineStart: 42, lineEnd: 42, category: "sql-injection", minSeverity: "high", agent: "security", note: "concat" },
  { file: "src/db/users.ts", lineStart: 90, lineEnd: 95, category: "missing-test", minSeverity: "medium", agent: "coverage" },
];
const fixtures = [
  { id: "seeded", meta: { clean: false, title: "Seeded" }, expected },
  { id: "clean", meta: { clean: true, title: "Clean" }, expected: [] },
];

const records = [
  aRecord({ caseId: "seeded", kept: [judged({ line: 42 })] }),
  aRecord({ caseId: "clean", kept: [judged({ file: "a.ts", line: 3, title: "Pipe | in title", sourceAgents: ["style"] })] }),
];

describe("buildReport", () => {
  const { metrics, evaluations, markdown } = buildReport(records, fixtures);

  it("evaluates every record against its fixture", () => {
    expect(evaluations.map((e) => [e.caseId, e.clean])).toEqual([
      ["seeded", false],
      ["clean", true],
    ]);
    expect(metrics.overall.recall.value).toBe(0.5);
    expect(metrics.overall.precision.value).toBe(0.5);
    expect(metrics.overall.cleanCriticalHighFalsePositives).toBe(1);
  });

  it("renders the accuracy table, missed findings and false positives", () => {
    expect(markdown).toContain("# ACR eval report");
    expect(markdown).toMatch(/\| security \| 100\.0% \(1\/1\) \| 100\.0% \(1\/1\) \| 0 \| 0 \|/);
    expect(markdown).toMatch(/\| coverage \| n\/a \| 0\.0% \(0\/1\) \|/);
    expect(markdown).toContain("`src/db/users.ts:90-95` missing-test (coverage, ≥ medium)");
    expect(markdown).toContain("**clean** (run 0) [clean]: `a.ts:3` high sql-injection (style): Pipe \\| in title");
    expect(markdown).toContain("| Cost per PR (mean) | $0.4000 |");
  });

  it("throws for a record without a fixture", () => {
    expect(() => buildReport([aRecord({ caseId: "nope" })], fixtures)).toThrow(/no fixture for case "nope"/);
  });
});

describe("compareToBaseline", () => {
  const base = buildReport(records, fixtures).metrics;
  const clone = (m: EvalMetrics): EvalMetrics => structuredClone(m);

  it("passes with 'no baseline' on the committed placeholder", async () => {
    const placeholder = JSON.parse(await readFile(new URL("../../../evals/baseline.json", import.meta.url), "utf8"));
    expect(compareToBaseline(base, placeholder)).toEqual({ pass: true, reasons: ["no baseline"] });
  });

  it("passes against itself", () => {
    expect(compareToBaseline(base, toBaseline(base))).toEqual({ pass: true, reasons: [] });
  });

  it("survives a JSON round trip of the baseline file", () => {
    expect(compareToBaseline(base, JSON.parse(JSON.stringify(toBaseline(base, { acceptedAt: "2026-11-14" })))).pass).toBe(true);
  });

  it("allows a drop of exactly 5 points but fails beyond it", () => {
    const b = clone(base);
    b.perAgent.security.precision.value = 0.95;
    const exactly = clone(base);
    exactly.perAgent.security.precision.value = 0.9;
    expect(compareToBaseline(exactly, toBaseline(b)).pass).toBe(true);

    const worse = clone(base);
    worse.perAgent.security.precision.value = 0.89;
    worse.perAgent.coverage.recall.value = 0.5;
    const b2 = clone(base);
    b2.perAgent.security.precision.value = 0.95;
    b2.perAgent.coverage.recall.value = 0.8;
    const r = compareToBaseline(worse, toBaseline(b2));
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual([
      "security precision dropped 6.0 points (95.0% → 89.0%), more than 5.0",
      "coverage recall dropped 30.0 points (80.0% → 50.0%), more than 5.0",
    ]);
  });

  it("ignores agents with nothing to measure on either side", () => {
    const b = clone(base);
    b.perAgent.style.precision.value = 1;
    const c = clone(base);
    c.perAgent.style.precision.value = null;
    expect(compareToBaseline(c, toBaseline(b)).pass).toBe(true);
  });

  it("fails when clean-PR critical/high false positives increase", () => {
    const b = clone(base);
    b.overall.cleanCriticalHighFalsePositivesPerCleanRun = 0;
    const r = compareToBaseline(base, toBaseline(b));
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual(["clean-PR critical/high false positives increased (0.00 → 1.00 per clean run)"]);
  });

  it("fails when cost per PR rises more than 20%", () => {
    const b = clone(base);
    b.cost.meanPerPrUsd = 0.4;
    const ok = clone(base);
    ok.cost.meanPerPrUsd = 0.48;
    expect(compareToBaseline(ok, toBaseline(b)).pass).toBe(true);
    const pricey = clone(base);
    pricey.cost.meanPerPrUsd = 0.5;
    const r = compareToBaseline(pricey, toBaseline(b));
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/^cost per PR rose 25\.0% \(\$0\.4000 → \$0\.5000\), more than 20%: needs the user's agreement$/);
  });

  it("fails on an invalid baseline file", () => {
    const r = compareToBaseline(base, { status: "accepted" });
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/^baseline\.json is invalid/);
  });
});
