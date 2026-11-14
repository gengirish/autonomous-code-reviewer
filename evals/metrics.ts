/**
 * Pure eval metrics: matching kept findings to expected ones, and precision / recall /
 * clean-PR false positives / cost / latency / cache aggregation. No I/O.
 */
import { z } from "zod";
import {
  AGENTS,
  type AgentName,
  AgentName as AgentNameSchema,
  AgentReport,
  JudgedFinding,
  type Severity,
  severityRank,
} from "../src/schemas/index.js";
import { type ExpectedFinding, isPrScoped } from "./schema.js";

// ───────────────────────────── run records ─────────────────────────────

/** One pipeline run of one fixture (runCase produces one per repeat). */
export const CaseRunRecord = z.object({
  caseId: z.string(),
  /** 0-based repeat index. */
  run: z.number().int().nonnegative().optional(),
  /** Judged findings with kept: true (what would be posted). */
  kept: z.array(JudgedFinding),
  /** Every judged finding, kept or dropped. */
  allJudged: z.array(JudgedFinding),
  costUsd: z.number().nonnegative(),
  /** Wall clock for prepare → agents → judge. */
  latencyMs: z.number().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  /** Agent + judge calls attempted (denominator of the schema-failure rate). */
  llmCalls: z.number().int().nonnegative().optional(),
  schemaFailures: z.number().int().nonnegative(),
  refusals: z.number().int().nonnegative(),
  failedAgents: z.array(AgentNameSchema).optional(),
  /** Non-refusal, non-schema errors (message only). */
  errors: z.array(z.string()).optional(),
  /** Raw agent outputs, for `--record` (FakeLlm replays). */
  reports: z.array(z.object({ agent: AgentNameSchema, chunk: z.number().int().nonnegative(), report: AgentReport })).optional(),
  judgeSummary: z.string().optional(),
});
export type CaseRunRecord = z.infer<typeof CaseRunRecord>;

// ───────────────────────────── matching ─────────────────────────────

/** A finding's line may sit this many lines outside the expected range. */
export const LINE_TOLERANCE = 3;

/**
 * Category families: a finding matches an expected item when both categories are equal,
 * or both belong to the same family (the family name itself counts as a member).
 * Agents choose free-form kebab-case categories, so list the spellings they actually use.
 */
export const CATEGORY_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  injection: [
    "sql-injection",
    "command-injection",
    "os-command-injection",
    "shell-injection",
    "nosql-injection",
    "template-injection",
    "code-injection",
    "ldap-injection",
    "xpath-injection",
  ],
  secrets: [
    "hardcoded-secret",
    "hard-coded-secret",
    "hardcoded-secrets",
    "hardcoded-credentials",
    "hardcoded-credential",
    "hardcoded-api-key",
    "secret-leak",
    "leaked-secret",
    "exposed-secret",
    "secret-exposure",
    "credential-exposure",
    "api-key-exposure",
  ],
  "prompt-injection": ["prompt-injection-attempt", "untrusted-instructions", "reviewer-manipulation"],
  tests: [
    "missing-test",
    "missing-tests",
    "untested-code",
    "untested-branch",
    "untested-branches",
    "untested-error-path",
    "insufficient-tests",
    "test-coverage",
    "coverage-gap",
    "weak-test",
    "weak-assertion",
    "weak-assertions",
    "no-assertions",
    "missing-assertion",
    "missing-assertions",
    "test-without-assertion",
    "assertion-free-test",
    "ineffective-test",
  ],
  layering: [
    "layering-violation",
    "layer-violation",
    "architecture-violation",
    "boundary-violation",
    "module-boundary-violation",
    "separation-of-concerns",
    "leaky-abstraction",
    "direct-db-access",
  ],
  dependencies: [
    "import-cycle",
    "circular-import",
    "circular-dependency",
    "cyclic-dependency",
    "dependency-cycle",
    "tight-coupling",
    "coupling",
  ],
  contracts: [
    "breaking-change",
    "api-break",
    "api-breaking-change",
    "public-api-break",
    "api-signature-break",
    "signature-change",
    "contract-break",
    "backward-incompatible-change",
    "caller-not-updated",
    "stale-caller",
  ],
  "dead-code": ["unused-code", "unreachable-code", "unused-function", "unused-parameter", "unused-variable"],
  naming: ["misleading-name", "poor-naming", "unclear-name", "inconsistent-naming", "naming-convention"],
  lint: [
    "lint-violation",
    "lint-config-violation",
    "lint-inconsistency",
    "eslint-violation",
    "style-inconsistency",
    "inconsistent-style",
    "convention-violation",
    "repo-convention",
    "no-console",
    "no-default-export",
    "restricted-import",
  ],
};

const FAMILY_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(CATEGORY_FAMILIES).flatMap(([family, members]) => [
    [family, family] as const,
    ...members.map((m) => [m, family] as const),
  ]),
);

export const normalizeCategory = (c: string): string => c.trim().toLowerCase().replace(/[\s_]+/g, "-");

export function sameCategoryFamily(a: string, b: string): boolean {
  const na = normalizeCategory(a);
  const nb = normalizeCategory(b);
  if (na === nb) return true;
  const fa = FAMILY_OF.get(na);
  return fa !== undefined && fa === FAMILY_OF.get(nb);
}

/** found ≥ min, with one level of tolerance (min "high" also accepts "medium"). */
export const severityAccepted = (found: Severity, min: Severity): boolean => severityRank(found) <= severityRank(min) + 1;

export const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

export function findingMatchesExpected(f: JudgedFinding, e: ExpectedFinding): boolean {
  if (!sameCategoryFamily(f.category, e.category)) return false;
  if (!severityAccepted(f.finalSeverity, e.minSeverity)) return false;
  if (isPrScoped(e)) return true;
  if (normalizePath(f.file) !== normalizePath(e.file)) return false;
  return f.line >= e.lineStart - LINE_TOLERANCE && f.line <= e.lineEnd + LINE_TOLERANCE;
}

export interface MatchResult {
  /** expectedIndex ↔ findingIndex; each side appears at most once. */
  pairs: Array<{ expectedIndex: number; findingIndex: number }>;
  unmatchedExpected: number[];
  unmatchedFindings: number[];
}

/**
 * Maximum one-to-one matching of kept findings to expected items (Kuhn's augmenting
 * paths), so a duplicate finding can't claim a second expected item and one greedy
 * choice can't starve another expected item. Candidate order (same agent first, then
 * closest line, then input order) keeps the result deterministic.
 */
export function matchFindings(kept: readonly JudgedFinding[], expected: readonly ExpectedFinding[]): MatchResult {
  const candidates = expected.map((e) =>
    kept
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => findingMatchesExpected(f, e))
      .sort(
        (a, b) =>
          Number(!a.f.sourceAgents.includes(e.agent)) - Number(!b.f.sourceAgents.includes(e.agent)) ||
          lineDistance(a.f, e) - lineDistance(b.f, e) ||
          a.i - b.i,
      )
      .map(({ i }) => i),
  );

  const owner = new Map<number, number>(); // findingIndex → expectedIndex
  const augment = (ei: number, seen: Set<number>): boolean => {
    for (const fi of candidates[ei] ?? []) {
      if (seen.has(fi)) continue;
      seen.add(fi);
      const current = owner.get(fi);
      if (current === undefined || augment(current, seen)) {
        owner.set(fi, ei);
        return true;
      }
    }
    return false;
  };
  expected.forEach((_, ei) => augment(ei, new Set()));

  const pairs = [...owner.entries()]
    .map(([findingIndex, expectedIndex]) => ({ expectedIndex, findingIndex }))
    .sort((a, b) => a.expectedIndex - b.expectedIndex);
  const matchedE = new Set(pairs.map((p) => p.expectedIndex));
  return {
    pairs,
    unmatchedExpected: expected.map((_, i) => i).filter((i) => !matchedE.has(i)),
    unmatchedFindings: kept.map((_, i) => i).filter((i) => !owner.has(i)),
  };
}

function lineDistance(f: JudgedFinding, e: ExpectedFinding): number {
  if (isPrScoped(e)) return 0;
  if (f.line < e.lineStart) return e.lineStart - f.line;
  if (f.line > e.lineEnd) return f.line - e.lineEnd;
  return 0;
}

// ───────────────────────────── per-case evaluation ─────────────────────────────

const MEDIUM = severityRank("medium");
const HIGH = severityRank("high");

export interface AgentCounts {
  /** Kept findings this agent contributed to (merged findings count for every source agent). */
  kept: number;
  matchedKept: number;
  expected: number;
  matchedExpected: number;
  /** Kept findings ≥ medium on clean cases. */
  cleanFalsePositives: number;
  cleanCriticalHighFalsePositives: number;
}

export interface CaseEvaluation {
  caseId: string;
  run: number;
  clean: boolean;
  match: MatchResult;
  missed: ExpectedFinding[];
  falsePositives: JudgedFinding[];
  totals: AgentCounts;
  perAgent: Record<AgentName, AgentCounts>;
  judged: number;
  dropped: number;
}

const zeroCounts = (): AgentCounts => ({
  kept: 0,
  matchedKept: 0,
  expected: 0,
  matchedExpected: 0,
  cleanFalsePositives: 0,
  cleanCriticalHighFalsePositives: 0,
});

const perAgentZero = (): Record<AgentName, AgentCounts> =>
  Object.fromEntries(AGENTS.map((a) => [a, zeroCounts()])) as Record<AgentName, AgentCounts>;

export function evaluateCase(
  record: CaseRunRecord,
  fixture: { expected: readonly ExpectedFinding[]; clean: boolean },
): CaseEvaluation {
  const match = matchFindings(record.kept, fixture.expected);
  const matchedF = new Set(match.pairs.map((p) => p.findingIndex));
  const matchedE = new Set(match.pairs.map((p) => p.expectedIndex));
  const totals = zeroCounts();
  const perAgent = perAgentZero();

  record.kept.forEach((f, i) => {
    const isMatched = matchedF.has(i);
    const cleanFp = fixture.clean && severityRank(f.finalSeverity) <= MEDIUM;
    const cleanCritHigh = fixture.clean && severityRank(f.finalSeverity) <= HIGH;
    for (const counts of [totals, ...[...new Set(f.sourceAgents)].map((a) => perAgent[a])]) {
      counts.kept++;
      if (isMatched) counts.matchedKept++;
      if (cleanFp) counts.cleanFalsePositives++;
      if (cleanCritHigh) counts.cleanCriticalHighFalsePositives++;
    }
  });
  fixture.expected.forEach((e, i) => {
    for (const counts of [totals, perAgent[e.agent]]) {
      counts.expected++;
      if (matchedE.has(i)) counts.matchedExpected++;
    }
  });

  return {
    caseId: record.caseId,
    run: record.run ?? 0,
    clean: fixture.clean,
    match,
    missed: match.unmatchedExpected.map((i) => fixture.expected[i] as ExpectedFinding),
    falsePositives: match.unmatchedFindings.map((i) => record.kept[i] as JudgedFinding),
    totals,
    perAgent,
    judged: record.allJudged.length,
    dropped: record.allJudged.filter((f) => !f.kept).length,
  };
}

// ───────────────────────────── aggregation ─────────────────────────────

export interface Rate {
  numerator: number;
  denominator: number;
  /** null when the denominator is 0 (nothing to measure). */
  value: number | null;
}

export const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});

export interface AgentMetrics {
  precision: Rate;
  recall: Rate;
  cleanFalsePositives: number;
  cleanCriticalHighFalsePositives: number;
}

export interface EvalMetrics {
  /** Distinct case IDs. */
  cases: number;
  /** Case runs (cases × repeats). */
  runs: number;
  cleanRuns: number;
  overall: AgentMetrics & {
    /** Clean-PR critical/high FPs per clean run: the regression rule compares this. */
    cleanCriticalHighFalsePositivesPerCleanRun: number | null;
    judgeDropRate: Rate;
    schemaFailureRate: Rate;
    schemaFailures: number;
    refusals: number;
  };
  perAgent: Record<AgentName, AgentMetrics>;
  cost: { totalUsd: number; meanPerPrUsd: number | null };
  latency: { meanMs: number | null; p50Ms: number | null; p95Ms: number | null };
  cache: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; readRatio: number | null };
}

/** Nearest-rank percentile; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function agentMetrics(counts: readonly AgentCounts[]): AgentMetrics {
  return {
    precision: rate(sum(counts.map((c) => c.matchedKept)), sum(counts.map((c) => c.kept))),
    recall: rate(sum(counts.map((c) => c.matchedExpected)), sum(counts.map((c) => c.expected))),
    cleanFalsePositives: sum(counts.map((c) => c.cleanFalsePositives)),
    cleanCriticalHighFalsePositives: sum(counts.map((c) => c.cleanCriticalHighFalsePositives)),
  };
}

/**
 * Micro-averages over every run: with `--repeat 3` each case contributes three times, which
 * equals the mean of the per-repeat totals.
 */
export function aggregate(evaluations: readonly CaseEvaluation[], records: readonly CaseRunRecord[]): EvalMetrics {
  const cleanRuns = evaluations.filter((e) => e.clean).length;
  const overall = agentMetrics(evaluations.map((e) => e.totals));
  const latencies = records.map((r) => r.latencyMs);
  const inputTokens = sum(records.map((r) => r.inputTokens));
  const cacheReadTokens = sum(records.map((r) => r.cacheReadTokens));
  const cacheWriteTokens = sum(records.map((r) => r.cacheWriteTokens ?? 0));
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const totalUsd = sum(records.map((r) => r.costUsd));
  const schemaFailures = sum(records.map((r) => r.schemaFailures));

  return {
    cases: new Set(records.map((r) => r.caseId)).size,
    runs: records.length,
    cleanRuns,
    overall: {
      ...overall,
      cleanCriticalHighFalsePositivesPerCleanRun: cleanRuns === 0 ? null : overall.cleanCriticalHighFalsePositives / cleanRuns,
      judgeDropRate: rate(sum(evaluations.map((e) => e.dropped)), sum(evaluations.map((e) => e.judged))),
      schemaFailureRate: rate(schemaFailures, sum(records.map((r) => r.llmCalls ?? 0))),
      schemaFailures,
      refusals: sum(records.map((r) => r.refusals)),
    },
    perAgent: Object.fromEntries(AGENTS.map((a) => [a, agentMetrics(evaluations.map((e) => e.perAgent[a]))])) as Record<
      AgentName,
      AgentMetrics
    >,
    cost: { totalUsd, meanPerPrUsd: records.length === 0 ? null : totalUsd / records.length },
    latency: {
      meanMs: latencies.length === 0 ? null : sum(latencies) / latencies.length,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
    },
    cache: { inputTokens, cacheReadTokens, cacheWriteTokens, readRatio: promptTokens === 0 ? null : cacheReadTokens / promptTokens },
  };
}
