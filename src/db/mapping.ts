/**
 * Pure mapping helpers between the RunRecorder contract and database rows.
 *
 * This file must NOT import the generated Prisma client (src/db/generated), so unit tests and
 * the typecheck of other modules work without `prisma generate`. The row shapes below are plain
 * objects that are structurally assignable to Prisma's create/update inputs.
 */
import type { LlmUsage, RunStatus } from "../core/ports.js";
import type { AgentName, JudgedFinding, PrepareJob, ReviewEvent } from "../schemas/index.js";

/** Scale of `ReviewRun.costUsd` (@db.Decimal(10, 4)). */
export const RUN_COST_SCALE = 4;
/** Scale of `LlmCall.costUsd` (@db.Decimal(10, 5)). */
export const CALL_COST_SCALE = 5;
/** Total digits of both Decimal columns. */
export const COST_PRECISION = 10;

const PG_INT_MAX = 2_147_483_647;

/**
 * Number → decimal string with a fixed scale, ready for a Prisma `Decimal` column.
 * A string (not a float) is passed so Prisma/Postgres never re-interpret binary floating point.
 * Rejects NaN/Infinity, negatives and values that overflow `Decimal(precision, scale)`.
 */
export function toDecimalString(value: number, scale: number, precision = COST_PRECISION): string {
  if (!Number.isFinite(value)) throw new RangeError(`Expected a finite number for a decimal column, got ${value}`);
  if (value < 0) throw new RangeError(`Expected a non-negative amount, got ${value}`);
  const fixed = value.toFixed(scale);
  const integerDigits = fixed.split(".")[0] ?? "";
  if (integerDigits.replace(/^0+/, "").length > precision - scale) {
    throw new RangeError(`Value ${value} overflows Decimal(${precision}, ${scale})`);
  }
  return fixed;
}

/** GitHub numeric ID (review id, comment id) → BigInt. Must be a positive safe integer. */
export function toBigIntId(id: number): bigint {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError(`Expected a positive safe integer GitHub ID, got ${id}`);
  return BigInt(id);
}

/** Non-negative integer for an `Int` (int4) column: rounds (latencies come from performance.now()). */
export function toInt(value: number, field = "value"): number {
  if (!Number.isFinite(value)) throw new RangeError(`Expected a finite number for ${field}, got ${value}`);
  const n = Math.round(value);
  if (n < 0) throw new RangeError(`Expected a non-negative ${field}, got ${value}`);
  if (n > PG_INT_MAX) throw new RangeError(`${field} ${value} overflows a 32-bit integer column`);
  return n;
}

// ───────────────────────────── Status rules ─────────────────────────────

/** Statuses after which the run is over (they set `finishedAt`). */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["PUBLISHED", "SUPERSEDED", "SKIPPED", "FAILED"]);

export const isTerminalStatus = (status: RunStatus): boolean => TERMINAL_STATUSES.has(status);

/**
 * Whether `runStatus(next)` may overwrite `current`.
 *
 * PUBLISHED is sticky: once the review is on GitHub, a late or retried job can't relabel the run.
 * Every other transition is allowed. A run that was SKIPPED (e.g. draft PR), SUPERSEDED or FAILED
 * can legitimately run again for the same SHA (ready-for-review, force-push back, BullMQ retry).
 */
export function canTransition(current: RunStatus, next: RunStatus): boolean {
  return current !== "PUBLISHED" || next === "PUBLISHED";
}

export const ALL_STATUSES: readonly RunStatus[] = ["QUEUED", "RUNNING", "PUBLISHED", "SUPERSEDED", "SKIPPED", "FAILED"];

/** Current statuses that `next` must not overwrite (used as `status NOT IN (…)` in the update). */
export function statusesBlocking(next: RunStatus): RunStatus[] {
  return ALL_STATUSES.filter((current) => !canTransition(current, next));
}

/**
 * `runQueued` never changes the status of an existing run (a re-delivered webhook must not
 * downgrade RUNNING/PUBLISHED back to QUEUED); it only creates the row.
 */
export const QUEUED_STATUS: RunStatus = "QUEUED";

// ───────────────────────────── Run rows ─────────────────────────────

export interface RunIdentity {
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
}

/**
 * Best-effort identity for a run row created before `runQueued` (e.g. an `llmCall` that arrives
 * first). Parses `runKey` output: `owner__repo__pr__sha12`. GitHub owners can't contain "_",
 * so the first "__" ends the owner; the repo may contain "__". `headSha` is the 12-char prefix
 * until `runQueued` fills in the full SHA. Unparseable IDs get placeholders (headSha = runId,
 * which keeps the (owner, repo, pr, headSha) unique key free of collisions).
 */
export function parseRunId(runId: string): RunIdentity {
  const m = /^(.+?)__(.+)__(\d+)__([0-9a-f]{1,40})$/.exec(runId);
  if (m) {
    const pr = Number(m[3]);
    if (Number.isSafeInteger(pr) && pr <= PG_INT_MAX) {
      return { owner: m[1] as string, repo: m[2] as string, pr, headSha: m[4] as string };
    }
  }
  return { owner: "unknown", repo: "unknown", pr: 0, headSha: runId };
}

export interface RunCreateRow extends RunIdentity {
  id: string;
  status: RunStatus;
}

/** Row created by `runQueued`. */
export function toQueuedRun(job: PrepareJob): RunCreateRow {
  return { id: job.runId, owner: job.owner, repo: job.repo, pr: job.pr, headSha: job.headSha, status: QUEUED_STATUS };
}

/** Placeholder row so child writes (reports, calls, findings) never violate the foreign key. */
export function toStubRun(runId: string, status: RunStatus = QUEUED_STATUS): RunCreateRow {
  return { id: runId, ...parseRunId(runId), status };
}

export interface RunStatusUpdate {
  status: RunStatus;
  error: string | null;
  finishedAt: Date | null;
}

/** Fields written by `runStatus`. The error is replaced (cleared when not given). */
export function toStatusUpdate(status: RunStatus, error: string | undefined, now: Date = new Date()): RunStatusUpdate {
  return { status, error: error ?? null, finishedAt: isTerminalStatus(status) ? now : null };
}

export interface RunFinishedInput {
  verdict: ReviewEvent;
  reviewId: number;
  costUsd: number;
  latencyMs: number;
  chunks: number;
}

export interface RunFinishedUpdate {
  status: "PUBLISHED";
  verdict: ReviewEvent;
  reviewId: bigint;
  costUsd: string;
  latencyMs: number;
  chunks: number;
  error: null;
  finishedAt: Date;
}

export function toRunFinished(result: RunFinishedInput, now: Date = new Date()): RunFinishedUpdate {
  const chunks = toInt(result.chunks, "chunks");
  if (chunks < 1) throw new RangeError(`Expected at least one chunk, got ${result.chunks}`);
  return {
    status: "PUBLISHED",
    verdict: result.verdict,
    reviewId: toBigIntId(result.reviewId),
    costUsd: toDecimalString(result.costUsd, RUN_COST_SCALE),
    latencyMs: toInt(result.latencyMs, "latencyMs"),
    chunks,
    error: null,
    finishedAt: now,
  };
}

// ───────────────────────────── Child rows ─────────────────────────────

export interface AgentReportRow {
  runId: string;
  agent: AgentName;
  chunk: number;
  status: "ok" | "failed" | "refused";
  summary: string | null;
}

export function toAgentReportRow(
  runId: string,
  agent: AgentName,
  chunk: number,
  status: "ok" | "failed" | "refused",
  summary?: string,
): AgentReportRow {
  if (!Number.isSafeInteger(chunk) || chunk < 0) throw new RangeError(`Expected a non-negative integer chunk, got ${chunk}`);
  return { runId, agent, chunk, status, summary: summary ?? null };
}

export interface LlmCallRow {
  runId: string;
  role: AgentName | "judge";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string;
  latencyMs: number;
  costUsd: string;
}

export function toLlmCallRow(
  runId: string,
  label: AgentName | "judge",
  usage: LlmUsage,
  stopReason: string,
  latencyMs: number,
  costUsd: number,
): LlmCallRow {
  return {
    runId,
    role: label,
    model: usage.model,
    inputTokens: toInt(usage.inputTokens, "inputTokens"),
    outputTokens: toInt(usage.outputTokens, "outputTokens"),
    cacheReadTokens: toInt(usage.cacheReadTokens, "cacheReadTokens"),
    cacheWriteTokens: toInt(usage.cacheWriteTokens, "cacheWriteTokens"),
    stopReason,
    latencyMs: toInt(latencyMs, "latencyMs"),
    costUsd: toDecimalString(costUsd, CALL_COST_SCALE),
  };
}

export interface FindingRow {
  runId: string;
  sourceAgents: AgentName[];
  file: string;
  line: number;
  category: string;
  agentSeverity: string;
  finalSeverity: string;
  kept: boolean;
  dropReason: string | null;
  inline: boolean;
  title: string;
}

/**
 * Judged finding → row. Stores locations, categories, severities and titles only: rationale,
 * evidence (quoted code) and suggestions stay out of the database (acr-database: don't store code).
 */
export function toFindingRow(runId: string, finding: JudgedFinding & { inline: boolean }): FindingRow {
  return {
    runId,
    sourceAgents: [...finding.sourceAgents],
    file: finding.file,
    line: toInt(finding.line, "line"),
    category: finding.category,
    agentSeverity: finding.severity,
    finalSeverity: finding.finalSeverity,
    kept: finding.kept,
    dropReason: finding.dropReason ?? null,
    inline: finding.inline,
    title: finding.title,
  };
}
