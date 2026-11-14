import { describe, expect, it } from "vitest";
import {
  CATEGORY_FAMILIES,
  aggregate,
  evaluateCase,
  matchFindings,
  percentile,
  sameCategoryFamily,
  severityAccepted,
} from "../../../evals/metrics.js";
import type { ExpectedFinding } from "../../../evals/schema.js";
import { aRecord, judged } from "./helpers.js";

const sqlExpected = (o: Partial<ExpectedFinding> = {}): ExpectedFinding =>
  ({
    file: "src/db/users.ts",
    lineStart: 40,
    lineEnd: 44,
    category: "sql-injection",
    minSeverity: "high",
    agent: "security",
    ...o,
  }) as ExpectedFinding;

describe("matching rule", () => {
  it("matches the same file within ±3 lines of the range", () => {
    const e = [sqlExpected()];
    for (const line of [37, 40, 42, 44, 47]) expect(matchFindings([judged({ line })], e).pairs, `line ${line}`).toHaveLength(1);
    for (const line of [36, 48]) expect(matchFindings([judged({ line })], e).pairs, `line ${line}`).toHaveLength(0);
  });

  it("requires the same file (path normalised)", () => {
    expect(matchFindings([judged({ file: "src/db/orders.ts" })], [sqlExpected()]).pairs).toHaveLength(0);
    expect(matchFindings([judged({ file: "./src/db/users.ts" })], [sqlExpected()]).pairs).toHaveLength(1);
    expect(matchFindings([judged({ file: "src\\db\\users.ts" })], [sqlExpected()]).pairs).toHaveLength(1);
  });

  it("matches categories exactly or within a family", () => {
    expect(sameCategoryFamily("sql-injection", "sql-injection")).toBe(true);
    expect(sameCategoryFamily("sql-injection", "command-injection")).toBe(true);
    expect(sameCategoryFamily("injection", "nosql-injection")).toBe(true);
    expect(sameCategoryFamily("SQL_Injection", "sql-injection")).toBe(true);
    expect(sameCategoryFamily("missing-test", "weak-test")).toBe(true);
    expect(sameCategoryFamily("sql-injection", "hardcoded-secret")).toBe(false);
    expect(sameCategoryFamily("something-new", "something-new")).toBe(true);
    expect(sameCategoryFamily("something-new", "sql-injection")).toBe(false);
    expect(matchFindings([judged({ category: "injection" })], [sqlExpected()]).pairs).toHaveLength(1);
    expect(matchFindings([judged({ category: "missing-test" })], [sqlExpected()]).pairs).toHaveLength(0);
  });

  it("puts each category in at most one family", () => {
    const all = Object.entries(CATEGORY_FAMILIES).flatMap(([family, members]) => [family, ...members]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("accepts severity one level below minSeverity, not two", () => {
    expect(severityAccepted("critical", "high")).toBe(true);
    expect(severityAccepted("high", "high")).toBe(true);
    expect(severityAccepted("medium", "high")).toBe(true);
    expect(severityAccepted("low", "high")).toBe(false);
    expect(severityAccepted("nit", "low")).toBe(true);
    const e = [sqlExpected()];
    expect(matchFindings([judged({ finalSeverity: "medium" })], e).pairs).toHaveLength(1);
    expect(matchFindings([judged({ finalSeverity: "low" })], e).pairs).toHaveLength(0);
    // the judge's finalSeverity decides, not the agent's original severity
    expect(matchFindings([judged({ severity: "critical", finalSeverity: "low" })], e).pairs).toHaveLength(0);
  });

  it("matches PR-scoped expectations anywhere", () => {
    const e: ExpectedFinding[] = [{ scope: "pr", category: "prompt-injection-attempt", minSeverity: "high", agent: "security" }];
    expect(matchFindings([judged({ file: "any/file.go", line: 1, category: "prompt-injection" })], e).pairs).toHaveLength(1);
    expect(matchFindings([judged({ category: "sql-injection" })], e).pairs).toHaveLength(0);
  });

  it("matches each expected item at most once (duplicates are false positives)", () => {
    const dupes = [judged({ line: 42 }), judged({ line: 43 }), judged({ line: 41 })];
    const r = matchFindings(dupes, [sqlExpected()]);
    expect(r.pairs).toEqual([{ expectedIndex: 0, findingIndex: 0 }]);
    expect(r.unmatchedFindings).toEqual([1, 2]);
  });

  it("never lets one finding claim two expected items", () => {
    const r = matchFindings([judged({ line: 42 })], [sqlExpected(), sqlExpected({ lineStart: 41, lineEnd: 41 })]);
    expect(r.pairs).toHaveLength(1);
    expect(r.unmatchedExpected).toHaveLength(1);
  });

  it("finds the maximum matching when greedy choice would starve an item", () => {
    // expected[0] accepts both findings, expected[1] only the first. Greedy would give
    // finding 0 to expected[0] and leave expected[1] unmatched.
    const expected = [sqlExpected({ lineStart: 40, lineEnd: 50 }), sqlExpected({ lineStart: 40, lineEnd: 40 })];
    const findings = [judged({ line: 40 }), judged({ line: 52 })];
    const r = matchFindings(findings, expected);
    expect(r.pairs).toEqual([
      { expectedIndex: 0, findingIndex: 1 },
      { expectedIndex: 1, findingIndex: 0 },
    ]);
  });

  it("prefers a finding from the expected agent, then the closest line", () => {
    const findings = [judged({ line: 47, sourceAgents: ["security"] }), judged({ line: 42, sourceAgents: ["style"] })];
    expect(matchFindings(findings, [sqlExpected()]).pairs[0]?.findingIndex).toBe(0);
    const sameAgent = [judged({ line: 47 }), judged({ line: 42 })];
    expect(matchFindings(sameAgent, [sqlExpected()]).pairs[0]?.findingIndex).toBe(1);
  });
});

describe("evaluateCase", () => {
  it("counts per agent, merged findings for every source agent", () => {
    const kept = [
      judged({ line: 42, sourceAgents: ["security", "architecture"] }),
      judged({ file: "src/x.ts", line: 1, category: "dead-code", finalSeverity: "low", sourceAgents: ["style"] }),
    ];
    const ev = evaluateCase(aRecord({ kept }), {
      clean: false,
      expected: [sqlExpected(), sqlExpected({ file: "src/missing.ts", agent: "coverage", category: "missing-test" })],
    });
    expect(ev.totals).toMatchObject({ kept: 2, matchedKept: 1, expected: 2, matchedExpected: 1 });
    expect(ev.perAgent.security).toMatchObject({ kept: 1, matchedKept: 1, expected: 1, matchedExpected: 1 });
    expect(ev.perAgent.architecture).toMatchObject({ kept: 1, matchedKept: 1, expected: 0 });
    expect(ev.perAgent.style).toMatchObject({ kept: 1, matchedKept: 0 });
    expect(ev.perAgent.coverage).toMatchObject({ kept: 0, expected: 1, matchedExpected: 0 });
    expect(ev.missed.map((m) => m.agent)).toEqual(["coverage"]);
    expect(ev.falsePositives.map((f) => f.category)).toEqual(["dead-code"]);
  });

  it("counts clean-PR false positives at medium and above only", () => {
    const kept = (["critical", "high", "medium", "low", "nit"] as const).map((s, i) =>
      judged({ line: i + 1, finalSeverity: s, sourceAgents: ["style"] }),
    );
    const ev = evaluateCase(aRecord({ kept }), { clean: true, expected: [] });
    expect(ev.totals.cleanFalsePositives).toBe(3);
    expect(ev.totals.cleanCriticalHighFalsePositives).toBe(2);
    expect(ev.perAgent.style.cleanFalsePositives).toBe(3);
    expect(ev.falsePositives).toHaveLength(5); // all of them still hurt precision
  });

  it("does not count clean FPs on seeded cases", () => {
    const ev = evaluateCase(aRecord({ kept: [judged({ file: "other.ts" })] }), { clean: false, expected: [sqlExpected()] });
    expect(ev.totals.cleanFalsePositives).toBe(0);
  });

  it("tracks judge drops", () => {
    const allJudged = [judged(), judged({ kept: false, dropReason: "duplicate" }), judged({ kept: false })];
    const ev = evaluateCase(aRecord({ kept: [allJudged[0] as ReturnType<typeof judged>], allJudged }), {
      clean: false,
      expected: [sqlExpected()],
    });
    expect([ev.judged, ev.dropped]).toEqual([3, 2]);
  });
});

describe("aggregate", () => {
  it("computes precision/recall, clean FP rate, cost, latency and cache ratio", () => {
    const records = [
      aRecord({ caseId: "a", kept: [judged()], costUsd: 0.2, latencyMs: 10_000, inputTokens: 500, cacheReadTokens: 1500 }),
      aRecord({ caseId: "a", run: 1, kept: [], costUsd: 0.4, latencyMs: 30_000, schemaFailures: 1, refusals: 1 }),
      aRecord({ caseId: "clean", kept: [judged({ finalSeverity: "high" })], costUsd: 0.6, latencyMs: 20_000 }),
    ];
    const fixtures = [
      { expected: [sqlExpected()], clean: false },
      { expected: [sqlExpected()], clean: false },
      { expected: [], clean: true },
    ];
    const m = aggregate(
      records.map((r, i) => evaluateCase(r, fixtures[i] as (typeof fixtures)[number])),
      records,
    );
    expect(m).toMatchObject({ cases: 2, runs: 3, cleanRuns: 1 });
    expect(m.overall.precision).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(m.overall.recall).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(m.perAgent.security.recall.value).toBe(0.5);
    expect(m.perAgent.style.precision.value).toBeNull();
    expect(m.perAgent.style.recall.value).toBeNull();
    expect(m.overall.cleanCriticalHighFalsePositives).toBe(1);
    expect(m.overall.cleanCriticalHighFalsePositivesPerCleanRun).toBe(1);
    expect(m.overall.schemaFailureRate).toEqual({ numerator: 1, denominator: 15, value: 1 / 15 });
    expect(m.overall.refusals).toBe(1);
    expect(m.cost.totalUsd).toBeCloseTo(1.2);
    expect(m.cost.meanPerPrUsd).toBeCloseTo(0.4);
    expect(m.latency).toEqual({ meanMs: 20_000, p50Ms: 20_000, p95Ms: 30_000 });
    expect(m.cache.readRatio).toBeCloseTo(1500 / (2500 + 1500));
  });

  it("returns nulls for an empty run", () => {
    const m = aggregate([], []);
    expect(m.cost.meanPerPrUsd).toBeNull();
    expect(m.latency.p50Ms).toBeNull();
    expect(m.cache.readRatio).toBeNull();
    expect(m.overall.cleanCriticalHighFalsePositivesPerCleanRun).toBeNull();
  });

  it("percentile uses nearest rank", () => {
    const xs = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNull();
  });
});
