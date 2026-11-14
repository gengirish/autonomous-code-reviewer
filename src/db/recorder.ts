import type { RunRecorder, RunStatus } from "../core/ports.js";
import type { PrismaClient } from "./generated/client.js";
import {
  statusesBlocking,
  toAgentReportRow,
  toFindingRow,
  toLlmCallRow,
  toQueuedRun,
  toRunFinished,
  toStatusUpdate,
  toStubRun,
} from "./mapping.js";

/**
 * Postgres-backed RunRecorder. Every write is safe to repeat (BullMQ retries are normal):
 * runs are created with INSERT … ON CONFLICT DO NOTHING and then updated by `runId`, so a child
 * write that arrives before `runQueued` creates a stub run instead of violating the foreign key.
 */
export function createPrismaRecorder(prisma: PrismaClient): RunRecorder {
  /** Creates a stub run row if none exists. Race-safe (ON CONFLICT DO NOTHING). */
  const ensureRun = (runId: string) => prisma.reviewRun.createMany({ data: [toStubRun(runId)], skipDuplicates: true });

  return {
    async runQueued(job) {
      const row = toQueuedRun(job);
      const { count } = await prisma.reviewRun.createMany({ data: [row], skipDuplicates: true });
      if (count === 0) {
        // Already there (re-delivery, retry, or a stub): fill in the identity, never touch the status.
        await prisma.reviewRun.update({
          where: { id: row.id },
          data: { owner: row.owner, repo: row.repo, pr: row.pr, headSha: row.headSha },
        });
      }
    },

    async runStatus(runId: string, status: RunStatus, error?: string) {
      await ensureRun(runId);
      await prisma.reviewRun.updateMany({
        where: { id: runId, status: { notIn: statusesBlocking(status) } },
        data: toStatusUpdate(status, error),
      });
    },

    async agentReport(runId, agent, chunk, status, summary) {
      const row = toAgentReportRow(runId, agent, chunk, status, summary);
      await ensureRun(runId);
      await prisma.agentReport.upsert({
        where: { runId_agent_chunk: { runId, agent, chunk: row.chunk } },
        create: row,
        update: { status: row.status, summary: row.summary },
      });
    },

    async llmCall(runId, label, usage, stopReason, latencyMs, costUsd) {
      const row = toLlmCallRow(runId, label, usage, stopReason, latencyMs, costUsd);
      await ensureRun(runId);
      await prisma.llmCall.create({ data: row });
    },

    async findings(runId, findings) {
      const rows = findings.map((f) => toFindingRow(runId, f));
      // Replace the run's findings atomically. Note: Feedback on replaced findings is cascaded away,
      // which is fine because findings are recorded before the review (and its reactions) exist.
      await prisma.$transaction([
        prisma.reviewRun.createMany({ data: [toStubRun(runId)], skipDuplicates: true }),
        prisma.finding.deleteMany({ where: { runId } }),
        prisma.finding.createMany({ data: rows }),
      ]);
    },

    async runFinished(runId, result) {
      const data = toRunFinished(result);
      await ensureRun(runId);
      await prisma.reviewRun.update({ where: { id: runId }, data });
    },
  };
}
