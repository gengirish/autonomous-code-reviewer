import type { RunStats, StatsReader } from "../core/ports.js";
import type { PrismaClient } from "./generated/client.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subset of a Prisma `reviewRun.aggregate` result that `toRunStats` reads. */
export interface RunAggregate {
  _count: { _all: number };
  _avg: { costUsd: { toNumber(): number } | number | null; latencyMs: number | null };
}

/** Pure mapping from the aggregate to the API shape. Null when there are no runs. */
export function toRunStats(owner: string, repo: string, sinceDays: number, agg: RunAggregate): RunStats | null {
  const runs = agg._count._all;
  if (runs === 0) return null;
  const cost = agg._avg.costUsd;
  return {
    owner,
    repo,
    sinceDays,
    runs,
    avgCostUsd: cost === null ? null : typeof cost === "number" ? cost : cost.toNumber(),
    avgLatencyMs: agg._avg.latencyMs,
  };
}

/** Postgres-backed StatsReader. Typed Prisma query only: no raw SQL. */
export function createPrismaStatsReader(prisma: PrismaClient, now: () => Date = () => new Date()): StatsReader {
  return {
    async repoStats(owner, repo, sinceDays) {
      const since = new Date(now().getTime() - sinceDays * DAY_MS);
      const agg = await prisma.reviewRun.aggregate({
        where: { owner, repo, createdAt: { gte: since } },
        _count: { _all: true },
        _avg: { costUsd: true, latencyMs: true },
      });
      return toRunStats(owner, repo, sinceDays, agg);
    },
  };
}
