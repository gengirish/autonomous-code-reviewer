/**
 * FROZEN CONTRACTS between modules. Parallel builders code against these; the
 * integration step wires real implementations together. Change only with the lead's agreement.
 *
 * Each module's index.ts must export the named implementation typed with the
 * function type below (e.g. `export const runAgent: RunAgent = ...`) so that
 * `npm run typecheck` enforces the contract.
 */
import type { z } from "zod";
import type {
  AgentName,
  AgentReport,
  CheckedFinding,
  Effort,
  HookBody,
  JudgedFinding,
  JudgeOutput,
  PrepareJob,
  PrRef,
  ReviewContext,
  ReviewEvent,
} from "../schemas/index.js";

// ───────────────────────────── GitHub (src/github) ─────────────────────────────

export interface PrMeta {
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
}

export interface PrFile {
  path: string;
  previousPath?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  /** Missing for binary files and very large diffs. */
  patch?: string;
  /** Blob SHA of the head version (GitHub files API `sha`). */
  blobSha: string;
  additions: number;
  deletions: number;
}

export interface PrSource {
  getPr(ref: PrRef): Promise<PrMeta>;
  listFiles(ref: PrRef): Promise<PrFile[]>;
  /** Head-version file contents (UTF-8). */
  getContent(ref: PrRef, file: PrFile): Promise<string>;
  /** Optional repo files used as context (lint configs). Returns null when absent. */
  getRepoFile?(ref: PrRef, path: string, sha: string): Promise<string | null>;
}

export interface ReviewComment {
  path: string;
  line: number;
  startLine?: number;
  side: "RIGHT";
  body: string;
}

export interface ReviewPayload {
  ref: PrRef;
  headSha: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
}

export interface ReviewPublisher {
  /** Review ID if a review whose body carries this SHA's marker already exists. */
  findExistingReview(ref: PrRef, headSha: string): Promise<number | null>;
  /** Posts the review. On a 422 for inline comments, retries once with comments folded into the body. */
  publish(review: ReviewPayload): Promise<{ reviewId: number; inlinePosted: number }>;
}

// ───────────────────────────── LLM (src/llm) ─────────────────────────────

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredRequest<T> {
  /** For logs and usage records. */
  label: AgentName | "judge";
  runId: string;
  /** Frozen system prompt (no dates/IDs) — part of the cache prefix. */
  system: string;
  /** First user message. */
  userContent: string;
  /** Put a cache_control breakpoint on userContent (agents: true, judge: false). */
  cacheUserContent: boolean;
  /** Optional mid-conversation system message after userContent (agent role prompt). */
  roleInstructions?: string;
  schema: z.ZodType<T>;
  effort: Effort;
}

export interface StructuredResult<T> {
  output: T;
  usage: LlmUsage;
  stopReason: string;
  latencyMs: number;
}

export interface LlmClient {
  callStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export type CostOf = (usage: LlmUsage) => number;

// ───────────────────────────── Context store (src/queue) ─────────────────────────────

export interface ContextStore {
  putContexts(runId: string, contexts: ReviewContext[]): Promise<void>;
  getContexts(runId: string): Promise<ReviewContext[] | null>;
  /** "latest SHA" guard used to supersede older runs. */
  setLatest(ref: PrRef, headSha: string): Promise<void>;
  getLatest(ref: PrRef): Promise<string | null>;
}

// ───────────────────────────── Recorder (src/db) ─────────────────────────────

export type RunStatus = "QUEUED" | "RUNNING" | "PUBLISHED" | "SUPERSEDED" | "SKIPPED" | "FAILED";

export interface RunRecorder {
  runQueued(job: PrepareJob): Promise<void>;
  runStatus(runId: string, status: RunStatus, error?: string): Promise<void>;
  agentReport(runId: string, agent: AgentName, chunk: number, status: "ok" | "failed" | "refused", summary?: string): Promise<void>;
  llmCall(runId: string, label: AgentName | "judge", usage: LlmUsage, stopReason: string, latencyMs: number, costUsd: number): Promise<void>;
  findings(runId: string, findings: Array<JudgedFinding & { inline: boolean }>): Promise<void>;
  runFinished(runId: string, result: { verdict: ReviewEvent; reviewId: number; costUsd: number; latencyMs: number; chunks: number }): Promise<void>;
}

// ───────────────────────────── Pipeline functions ─────────────────────────────

/** src/parser/index.ts → `export const buildReviewContext: BuildReviewContext` */
export type BuildReviewContext = (input: {
  runId: string;
  ref: PrRef;
  meta: PrMeta;
  files: PrFile[];
  /** path → head contents, for every non-skipped file */
  contents: Map<string, string>;
  /** path → text of repo lint configs found (.eslintrc*, eslint.config.*, .prettierrc*, ruff.toml, …) */
  lintConfigs: Map<string, string>;
  /** Max tokens per rendered chunk (default 60k). Counting is approximate (chars/4) unless a counter is given. */
  maxTokensPerChunk?: number;
  countTokens?: (text: string) => Promise<number>;
}) => Promise<ReviewContext[]>;

/** src/parser/index.ts → `export const isSkippedPath: IsSkippedPath` (lockfiles, dist/, vendor/, *.min.*, binaries…) */
export type IsSkippedPath = (path: string) => string | null; // reason or null

/** src/parser/index.ts → deterministic, byte-stable rendering used as the cached prompt prefix. */
export type RenderContext = (ctx: ReviewContext) => string;

/** src/agents/index.ts → `export const runAgent: RunAgent` */
export type RunAgent = (
  agent: AgentName,
  ctx: ReviewContext,
  deps: { llm: LlmClient; renderContext: RenderContext },
) => Promise<{ report: AgentReport; checked: CheckedFinding[]; usage: LlmUsage; stopReason: string; latencyMs: number }>;

/** src/judge/index.ts → `export const runJudge: RunJudge` */
export type RunJudge = (
  input: {
    runId: string;
    /** Flat list across agents and chunks; JudgedFinding.sourceIndexes point into it. */
    findings: CheckedFinding[];
    reports: AgentReport[];
    contexts: ReviewContext[];
    failedAgents: AgentName[];
  },
  deps: { llm: LlmClient },
) => Promise<{ output: JudgeOutput; usage: LlmUsage; stopReason: string; latencyMs: number }>;

export interface RepoConfig {
  allowApprove: boolean; // default false
  includeNits: boolean; // default false
  maxInline: number; // default 15
}
export const DEFAULT_REPO_CONFIG: RepoConfig = { allowApprove: false, includeNits: false, maxInline: 15 };

/** src/judge/index.ts → `export const decideEvent: DecideEvent` */
export type DecideEvent = (findings: JudgedFinding[], cfg: RepoConfig) => ReviewEvent;

/** src/render/index.ts → `export const renderReview: RenderReview` */
export type RenderReview = (input: {
  runId: string;
  headSha: string;
  event: ReviewEvent;
  judge: JudgeOutput;
  /** Flat input list the judge saw (same order as RunJudge input.findings). */
  inputFindings: CheckedFinding[];
  reports: AgentReport[];
  failedAgents: AgentName[];
  contexts: ReviewContext[];
  cfg: RepoConfig;
}) => { body: string; comments: ReviewComment[]; inlineFindingIndexes: number[] };

// ───────────────────────────── Server (src/server) ─────────────────────────────

export interface ActionsClaims {
  repository: string; // "owner/repo"
  owner: string;
  eventName: string;
}

export interface HookDeps {
  verifyToken(token: string): Promise<ActionsClaims>;
  /** Idempotent: same runId for the same (ref, headSha). */
  enqueuePrepare(job: PrepareJob): Promise<{ runId: string }>;
}

export type { HookBody };
