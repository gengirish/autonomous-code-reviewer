import { describe, expect, it } from "vitest";
import { createPrismaStatsReader, toRunStats } from "../../../src/db/stats.js";
import type { PrismaClient } from "../../../src/db/generated/client.js";

const decimal = (n: number) => ({ toNumber: () => n });

describe("toRunStats", () => {
  it("maps counts and averages, converting the Decimal cost to a number", () => {
    expect(
      toRunStats("octo", "demo", 30, { _count: { _all: 4 }, _avg: { costUsd: decimal(0.1875), latencyMs: 61_000 } }),
    ).toEqual({ owner: "octo", repo: "demo", sinceDays: 30, runs: 4, avgCostUsd: 0.1875, avgLatencyMs: 61_000 });
  });

  it("returns null when there are no runs", () => {
    expect(toRunStats("octo", "demo", 30, { _count: { _all: 0 }, _avg: { costUsd: null, latencyMs: null } })).toBeNull();
  });

  it("keeps null averages when runs have no recorded cost or latency yet", () => {
    expect(
      toRunStats("octo", "demo", 7, { _count: { _all: 2 }, _avg: { costUsd: null, latencyMs: null } }),
    ).toMatchObject({ runs: 2, avgCostUsd: null, avgLatencyMs: null });
  });
});

describe("createPrismaStatsReader", () => {
  it("queries by owner, repo and the window start, with a typed aggregate (no raw SQL)", async () => {
    let args: unknown;
    const prisma = {
      reviewRun: {
        aggregate: async (a: unknown) => {
          args = a;
          return { _count: { _all: 1 }, _avg: { costUsd: decimal(0.3), latencyMs: 1000 } };
        },
      },
    } as unknown as PrismaClient;
    const now = new Date("2026-11-22T00:00:00Z");
    const reader = createPrismaStatsReader(prisma, () => now);

    const result = await reader.repoStats("octo", "demo", 7);

    expect(args).toEqual({
      where: { owner: "octo", repo: "demo", createdAt: { gte: new Date("2026-11-15T00:00:00Z") } },
      _count: { _all: true },
      _avg: { costUsd: true, latencyMs: true },
    });
    expect(result).toMatchObject({ runs: 1, avgCostUsd: 0.3 });
  });
});
