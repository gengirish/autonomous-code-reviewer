/**
 * Real Postgres (docker compose `postgres`, or TEST_DATABASE_URL). Runs in a dedicated schema
 * built from prisma/migrations, so it never touches `public`. Needs `prisma generate` first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, createPrismaRecorder, createRecorderFromEnv } from "../../../src/db/index.js";
import type { PrismaClient } from "../../../src/db/index.js";
import { noopRecorder } from "../../../src/core/recorder.js";
import type { RunRecorder } from "../../../src/core/ports.js";
import { runKey } from "../../../src/schemas/index.js";
import type { JudgedFinding, PrepareJob } from "../../../src/schemas/index.js";
import { aFinding, SHA_A, SHA_B } from "../../fakes/builders.js";

const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://acr:acr@localhost:5432/acr";
const SCHEMA = "acr_test_db";
const MIGRATIONS = join(process.cwd(), "prisma", "migrations");

let admin: pg.Client;
let prisma: PrismaClient;
let rec: RunRecorder;

const ref = { owner: "octo", repo: "demo", pr: 7 };
const job: PrepareJob = { ...ref, baseSha: SHA_B, headSha: SHA_A, runId: runKey(ref, SHA_A) };
const runId = job.runId;
const usage = { model: "claude-opus-5-5", inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 40_000, cacheWriteTokens: 1_500 };

const judged = (o: Partial<JudgedFinding> = {}, inline = false): JudgedFinding & { inline: boolean } => ({
  ...aFinding(),
  sourceIndexes: [0],
  sourceAgents: ["security"],
  kept: true,
  finalSeverity: "high",
  ...o,
  inline,
});

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.query(`SET search_path TO ${SCHEMA}`);
  const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    await admin.query(readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8"));
  }
  prisma = createPrisma(`${BASE_URL}?schema=${SCHEMA}`);
  rec = createPrismaRecorder(prisma);
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  }
});

beforeEach(async () => {
  await prisma.reviewRun.deleteMany({}); // cascades to reports, findings, calls, feedback
});

const getRun = () => prisma.reviewRun.findUniqueOrThrow({ where: { id: runId } });

describe("PrismaRecorder (real Postgres)", () => {
  it("writes into the test schema, not public", async () => {
    await rec.runQueued(job);
    const { rows } = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM ${SCHEMA}."ReviewRun" WHERE id = $1`, [runId]);
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it("records the full happy path", async () => {
    await rec.runQueued(job);
    expect(await getRun()).toMatchObject({ ...ref, headSha: SHA_A, status: "QUEUED", chunks: 1, finishedAt: null });

    await rec.runStatus(runId, "RUNNING");
    for (const agent of ["security", "style", "coverage", "architecture"] as const) {
      await rec.agentReport(runId, agent, 0, agent === "coverage" ? "failed" : "ok", agent === "coverage" ? undefined : `${agent} ok`);
      await rec.llmCall(runId, agent, usage, "end_turn", 1234.4, 0.012345);
    }
    await rec.llmCall(runId, "judge", usage, "end_turn", 2000, 0.05);
    await rec.findings(runId, [judged({}, true), judged({ kept: false, dropReason: "low-value", finalSeverity: "nit", line: 7 })]);
    await rec.runFinished(runId, { verdict: "REQUEST_CHANGES", reviewId: 3_123_456_789, costUsd: 0.09938, latencyMs: 45_678.9, chunks: 1 });

    const run = await prisma.reviewRun.findUniqueOrThrow({
      where: { id: runId },
      include: { reports: { orderBy: { agent: "asc" } }, findings: { orderBy: { line: "asc" } }, llmCalls: true },
    });
    expect(run.status).toBe("PUBLISHED");
    expect(run.verdict).toBe("REQUEST_CHANGES");
    expect(run.reviewId).toBe(3_123_456_789n);
    expect(run.costUsd?.toString()).toBe("0.0994");
    expect(run.latencyMs).toBe(45_679);
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.error).toBeNull();

    expect(run.reports.map((r) => [r.agent, r.status, r.summary])).toEqual([
      ["architecture", "ok", "architecture ok"],
      ["coverage", "failed", null],
      ["security", "ok", "security ok"],
      ["style", "ok", "style ok"],
    ]);

    expect(run.llmCalls).toHaveLength(5);
    const call = run.llmCalls.find((c) => c.role === "security");
    expect(call).toMatchObject({ model: "claude-opus-5-5", inputTokens: 12_000, cacheReadTokens: 40_000, latencyMs: 1234, stopReason: "end_turn" });
    expect(call?.costUsd.toString()).toBe("0.01235");

    expect(run.findings.map((f) => [f.line, f.kept, f.inline, f.finalSeverity, f.agentSeverity, f.dropReason])).toEqual([
      [7, false, false, "nit", "high", "low-value"],
      [42, true, true, "high", "high", null],
    ]);
    expect(run.findings[1]?.sourceAgents).toEqual(["security"]);
  });

  it("runQueued is idempotent and never downgrades the status", async () => {
    await rec.runQueued(job);
    await rec.runQueued(job);
    expect(await prisma.reviewRun.count()).toBe(1);

    await rec.runStatus(runId, "RUNNING");
    await rec.runQueued(job);
    expect((await getRun()).status).toBe("RUNNING");

    await rec.runFinished(runId, { verdict: "COMMENT", reviewId: 1, costUsd: 0, latencyMs: 1, chunks: 1 });
    await rec.runQueued(job);
    expect((await getRun()).status).toBe("PUBLISHED");
  });

  it("runQueued fills in a stub created by an earlier child write", async () => {
    await rec.llmCall(runId, "style", usage, "end_turn", 10, 0.001);
    expect(await getRun()).toMatchObject({ owner: "octo", repo: "demo", pr: 7, headSha: SHA_A.slice(0, 12), status: "QUEUED" });

    await rec.runQueued(job);
    expect(await getRun()).toMatchObject({ headSha: SHA_A, status: "QUEUED" });
    expect(await prisma.llmCall.count({ where: { runId } })).toBe(1);
  });

  it("runStatus upserts a missing run, is repeatable, and keeps PUBLISHED sticky", async () => {
    await rec.runStatus(runId, "RUNNING");
    await rec.runStatus(runId, "RUNNING");
    expect((await getRun()).status).toBe("RUNNING");

    await rec.runStatus(runId, "FAILED", "agent timeout");
    await rec.runStatus(runId, "FAILED", "agent timeout");
    expect(await getRun()).toMatchObject({ status: "FAILED", error: "agent timeout" });
    expect((await getRun()).finishedAt).toBeInstanceOf(Date);

    // A BullMQ retry after a failure runs again and clears the error.
    await rec.runStatus(runId, "RUNNING");
    expect(await getRun()).toMatchObject({ status: "RUNNING", error: null, finishedAt: null });

    await rec.runFinished(runId, { verdict: "COMMENT", reviewId: 99, costUsd: 0.1, latencyMs: 10, chunks: 1 });
    await rec.runStatus(runId, "FAILED", "late failure");
    await rec.runStatus(runId, "SUPERSEDED");
    expect(await getRun()).toMatchObject({ status: "PUBLISHED", error: null, reviewId: 99n });
  });

  it("agentReport upserts by (runId, agent, chunk)", async () => {
    await rec.agentReport(runId, "security", 0, "failed");
    await rec.agentReport(runId, "security", 0, "ok", "retried fine");
    await rec.agentReport(runId, "security", 1, "refused");
    const reports = await prisma.agentReport.findMany({ where: { runId }, orderBy: { chunk: "asc" } });
    expect(reports.map((r) => [r.chunk, r.status, r.summary])).toEqual([
      [0, "ok", "retried fine"],
      [1, "refused", null],
    ]);
  });

  it("llmCall survives a retry and a missing run", async () => {
    await rec.llmCall(runId, "judge", usage, "end_turn", 100, 0.2);
    await rec.llmCall(runId, "judge", usage, "end_turn", 100, 0.2);
    expect(await prisma.llmCall.count({ where: { runId } })).toBe(2); // dedupe not required
    expect(await prisma.reviewRun.count()).toBe(1);
  });

  it("findings are replaced on a second call (and on a retry)", async () => {
    await rec.findings(runId, [judged({ line: 1 }), judged({ line: 2 }), judged({ line: 3 })]);
    await rec.findings(runId, [judged({ line: 10, title: "second pass" }, true)]);
    await rec.findings(runId, [judged({ line: 10, title: "second pass" }, true)]);
    const findings = await prisma.finding.findMany({ where: { runId } });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 10, title: "second pass", inline: true });

    await rec.findings(runId, []);
    expect(await prisma.finding.count({ where: { runId } })).toBe(0);
  });

  it("runFinished is repeatable and upserts a missing run", async () => {
    const result = { verdict: "COMMENT" as const, reviewId: 5, costUsd: 1.23456, latencyMs: 10, chunks: 3 };
    await rec.runFinished(runId, result);
    await rec.runFinished(runId, result);
    const run = await getRun();
    expect(run).toMatchObject({ status: "PUBLISHED", verdict: "COMMENT", reviewId: 5n, chunks: 3 });
    expect(run.costUsd?.toString()).toBe("1.2346");
  });

  it("isolates runs by runId", async () => {
    const other: PrepareJob = { ...job, headSha: SHA_B, runId: runKey(ref, SHA_B) };
    await rec.runQueued(job);
    await rec.runQueued(other);
    await rec.findings(runId, [judged()]);
    await rec.findings(other.runId, [judged(), judged({ line: 2 })]);
    expect(await prisma.finding.count({ where: { runId } })).toBe(1);
    expect(await prisma.finding.count({ where: { runId: other.runId } })).toBe(2);
  });
});

describe("createRecorderFromEnv", () => {
  it("returns the no-op recorder without a URL", async () => {
    const r = createRecorderFromEnv("");
    expect(r.runQueued).toBe(noopRecorder.runQueued);
    await r.close();
  });

  it("returns a working Postgres recorder with a URL", async () => {
    const r = createRecorderFromEnv(`${BASE_URL}?schema=${SCHEMA}`);
    try {
      await r.runQueued(job);
      expect((await getRun()).status).toBe("QUEUED");
    } finally {
      await r.close();
    }
  });
});
