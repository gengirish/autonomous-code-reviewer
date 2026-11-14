import { describe, expect, it } from "vitest";
import {
  ALL_STATUSES,
  canTransition,
  isTerminalStatus,
  parseRunId,
  statusesBlocking,
  toAgentReportRow,
  toBigIntId,
  toDecimalString,
  toFindingRow,
  toInt,
  toLlmCallRow,
  toQueuedRun,
  toRunFinished,
  toStatusUpdate,
  toStubRun,
} from "../../../src/db/mapping.js";
import { parseDatabaseUrl } from "../../../src/db/url.js";
import { runKey } from "../../../src/schemas/index.js";
import type { JudgedFinding } from "../../../src/schemas/index.js";
import { aFinding, SHA_A, SHA_B } from "../../fakes/builders.js";

const NOW = new Date("2026-11-14T12:00:00Z");

describe("toDecimalString", () => {
  it("formats with a fixed scale as a string (never a float)", () => {
    expect(toDecimalString(0.1 + 0.2, 4)).toBe("0.3000");
    expect(toDecimalString(1.23456, 5)).toBe("1.23456");
    expect(toDecimalString(0.000049, 4)).toBe("0.0000");
    expect(toDecimalString(0, 5)).toBe("0.00000");
    expect(toDecimalString(12.5, 4)).toBe("12.5000");
  });

  it("accepts the largest value that fits Decimal(10, s) and rejects overflow", () => {
    expect(toDecimalString(999_999.9999, 4)).toBe("999999.9999");
    expect(() => toDecimalString(1_000_000, 4)).toThrow(RangeError);
    expect(toDecimalString(99_999.5, 5)).toBe("99999.50000");
    expect(() => toDecimalString(100_000, 5)).toThrow(RangeError);
  });

  it("rejects NaN, Infinity and negatives", () => {
    expect(() => toDecimalString(Number.NaN, 4)).toThrow(RangeError);
    expect(() => toDecimalString(Number.POSITIVE_INFINITY, 4)).toThrow(RangeError);
    expect(() => toDecimalString(-0.01, 4)).toThrow(RangeError);
  });
});

describe("toBigIntId", () => {
  it("converts positive safe integers", () => {
    expect(toBigIntId(1)).toBe(1n);
    expect(toBigIntId(2_345_678_901)).toBe(2_345_678_901n); // > int4, the reason for BigInt
    expect(toBigIntId(Number.MAX_SAFE_INTEGER)).toBe(9_007_199_254_740_991n);
  });

  it("rejects zero, negatives, fractions and unsafe integers", () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => toBigIntId(bad)).toThrow(RangeError);
    }
  });
});

describe("toInt", () => {
  it("rounds and bounds to int4", () => {
    expect(toInt(1234.6)).toBe(1235);
    expect(toInt(0)).toBe(0);
    expect(() => toInt(-1)).toThrow(RangeError);
    expect(() => toInt(2 ** 31)).toThrow(RangeError);
    expect(() => toInt(Number.NaN)).toThrow(RangeError);
  });
});

describe("status rules", () => {
  it("PUBLISHED is sticky; everything else may change", () => {
    for (const next of ALL_STATUSES) {
      expect(canTransition("PUBLISHED", next)).toBe(next === "PUBLISHED");
    }
    for (const current of ALL_STATUSES.filter((s) => s !== "PUBLISHED")) {
      for (const next of ALL_STATUSES) expect(canTransition(current, next)).toBe(true);
    }
  });

  it("statusesBlocking matches canTransition", () => {
    expect(statusesBlocking("RUNNING")).toEqual(["PUBLISHED"]);
    expect(statusesBlocking("FAILED")).toEqual(["PUBLISHED"]);
    expect(statusesBlocking("PUBLISHED")).toEqual([]);
  });

  it("terminal statuses set finishedAt; error is replaced or cleared", () => {
    expect(ALL_STATUSES.filter(isTerminalStatus)).toEqual(["PUBLISHED", "SUPERSEDED", "SKIPPED", "FAILED"]);
    expect(toStatusUpdate("FAILED", "boom", NOW)).toEqual({ status: "FAILED", error: "boom", finishedAt: NOW });
    expect(toStatusUpdate("RUNNING", undefined, NOW)).toEqual({ status: "RUNNING", error: null, finishedAt: null });
    expect(toStatusUpdate("QUEUED", undefined, NOW).finishedAt).toBeNull();
  });
});

describe("run rows", () => {
  it("parses runKey output back into an identity (sha prefix)", () => {
    const id = runKey({ owner: "octo", repo: "demo", pr: 7 }, SHA_A);
    expect(parseRunId(id)).toEqual({ owner: "octo", repo: "demo", pr: 7, headSha: "aaaaaaaaaaaa" });
  });

  it("keeps a repo name containing '__' intact (owners can't contain '_')", () => {
    expect(parseRunId("octo__my__repo__12__abc123def456")).toEqual({
      owner: "octo",
      repo: "my__repo",
      pr: 12,
      headSha: "abc123def456",
    });
  });

  it("falls back to placeholders that stay unique per runId", () => {
    expect(parseRunId("not-a-run-key")).toEqual({ owner: "unknown", repo: "unknown", pr: 0, headSha: "not-a-run-key" });
    expect(parseRunId("o__r__99999999999__abc").pr).toBe(0); // pr overflows int4
  });

  it("maps a PrepareJob to a QUEUED row and a runId to a stub", () => {
    const job = { runId: "r1", owner: "octo", repo: "demo", pr: 7, baseSha: SHA_B, headSha: SHA_A };
    expect(toQueuedRun(job)).toEqual({ id: "r1", owner: "octo", repo: "demo", pr: 7, headSha: SHA_A, status: "QUEUED" });
    expect(toStubRun("octo__demo__7__aaaaaaaaaaaa")).toMatchObject({ id: "octo__demo__7__aaaaaaaaaaaa", status: "QUEUED", pr: 7 });
  });

  it("maps runFinished with Decimal/BigInt conversions", () => {
    expect(toRunFinished({ verdict: "COMMENT", reviewId: 3_000_000_001, costUsd: 0.42317, latencyMs: 61_000.4, chunks: 2 }, NOW)).toEqual({
      status: "PUBLISHED",
      verdict: "COMMENT",
      reviewId: 3_000_000_001n,
      costUsd: "0.4232",
      latencyMs: 61_000,
      chunks: 2,
      error: null,
      finishedAt: NOW,
    });
    expect(() => toRunFinished({ verdict: "COMMENT", reviewId: 1, costUsd: 0, latencyMs: 0, chunks: 0 })).toThrow(RangeError);
  });
});

describe("child rows", () => {
  it("maps an agent report and validates the chunk", () => {
    expect(toAgentReportRow("r1", "style", 0, "ok")).toEqual({ runId: "r1", agent: "style", chunk: 0, status: "ok", summary: null });
    expect(toAgentReportRow("r1", "security", 2, "refused", "s").summary).toBe("s");
    expect(() => toAgentReportRow("r1", "style", -1, "ok")).toThrow(RangeError);
    expect(() => toAgentReportRow("r1", "style", 0.5, "ok")).toThrow(RangeError);
  });

  it("maps an LLM call with a 5-decimal cost", () => {
    const usage = { model: "claude-opus-5-5", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50_000, cacheWriteTokens: 0 };
    expect(toLlmCallRow("r1", "judge", usage, "end_turn", 812.7, 0.123456)).toEqual({
      runId: "r1",
      role: "judge",
      model: "claude-opus-5-5",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 0,
      stopReason: "end_turn",
      latencyMs: 813,
      costUsd: "0.12346",
    });
  });

  it("maps a judged finding without rationale, evidence or suggestion", () => {
    const judged: JudgedFinding & { inline: boolean } = {
      ...aFinding({ suggestion: "use parameters" }),
      sourceIndexes: [0, 3],
      sourceAgents: ["security", "architecture"],
      kept: false,
      dropReason: "duplicate",
      finalSeverity: "medium",
      inline: true,
    };
    const row = toFindingRow("r1", judged);
    expect(row).toEqual({
      runId: "r1",
      sourceAgents: ["security", "architecture"],
      file: "src/db/users.ts",
      line: 42,
      category: "sql-injection",
      agentSeverity: "high",
      finalSeverity: "medium",
      kept: false,
      dropReason: "duplicate",
      inline: true,
      title: "SQL built from request parameters",
    });
    expect(Object.keys(row)).not.toContain("evidence");
    expect(toFindingRow("r1", { ...judged, dropReason: undefined }).dropReason).toBeNull();
  });
});

describe("parseDatabaseUrl", () => {
  it("passes a plain URL through", () => {
    expect(parseDatabaseUrl("postgresql://acr:acr@localhost:5432/acr")).toEqual({ connectionString: "postgresql://acr:acr@localhost:5432/acr" });
  });

  it("extracts ?schema= and ?connection_limit= and keeps other params", () => {
    expect(parseDatabaseUrl("postgres://u:p@h:5432/db?schema=acr_test_db&connection_limit=5&sslmode=require")).toEqual({
      connectionString: "postgres://u:p@h:5432/db?sslmode=require",
      schema: "acr_test_db",
      max: 5,
    });
    expect(parseDatabaseUrl("postgresql://h/db?schema=public").schema).toBeUndefined();
  });

  it("rejects bad input without echoing credentials", () => {
    expect(() => parseDatabaseUrl("not a url")).toThrow("not a valid URL");
    expect(() => parseDatabaseUrl("mysql://h/db")).toThrow(/postgres URL/);
    expect(() => parseDatabaseUrl("postgresql://h/db?schema=x;drop")).toThrow(/Invalid schema/);
    expect(() => parseDatabaseUrl("postgresql://h/db?connection_limit=0")).toThrow(/connection_limit/);
  });
});
