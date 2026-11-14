import type { CaseRunRecord } from "../../../evals/metrics.js";
import type { JudgedFinding } from "../../../src/schemas/index.js";
import { aFinding } from "../../fakes/builders.js";

export const judged = (o: Partial<JudgedFinding> = {}): JudgedFinding => ({
  ...aFinding(),
  sourceIndexes: [0],
  sourceAgents: ["security"],
  kept: true,
  finalSeverity: o.severity ?? "high",
  ...o,
});

export const aRecord = (o: Partial<CaseRunRecord> = {}): CaseRunRecord => {
  const kept = o.kept ?? [];
  return {
    caseId: "case-a",
    run: 0,
    kept,
    allJudged: o.allJudged ?? kept,
    costUsd: 0.4,
    latencyMs: 30_000,
    cacheReadTokens: 0,
    inputTokens: 1000,
    cacheWriteTokens: 0,
    outputTokens: 100,
    llmCalls: 5,
    schemaFailures: 0,
    refusals: 0,
    ...o,
  };
};
