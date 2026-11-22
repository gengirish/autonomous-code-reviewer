/**
 * StatsReader against real Postgres (docker compose `postgres`, or TEST_DATABASE_URL), in its own
 * schema built from prisma/migrations. Checks the real Decimal → number path and the date window.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrisma, createPrismaStatsReader } from "../../../src/db/index.js";
import type { PrismaClient } from "../../../src/db/index.js";

const BASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://acr:acr@localhost:5432/acr";
const SCHEMA = "acr_test_stats";
const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const NOW = new Date("2026-11-22T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

let admin: pg.Client;
let prisma: PrismaClient;

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

  const run = (id: string, repo: string, age: number, costUsd: string | null, latencyMs: number | null) => ({
    id,
    owner: "octo",
    repo,
    pr: 1,
    headSha: id.padEnd(40, "0"),
    createdAt: daysAgo(age),
    costUsd,
    latencyMs,
  });
  await prisma.reviewRun.createMany({
    data: [
      run("a1", "demo", 1, "0.2000", 60_000),
      run("a2", "demo", 3, "0.4000", 120_000),
      run("a3", "demo", 10, "0.9000", 300_000), // outside a 7-day window
      run("a4", "demo", 2, null, null), // still running: counted, no cost yet
      run("b1", "other", 1, "5.0000", 1_000), // other repo
    ],
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  }
});

describe("createPrismaStatsReader (Postgres)", () => {
  it("aggregates only the repo's runs inside the window; averages skip nulls", async () => {
    const reader = createPrismaStatsReader(prisma, () => NOW);
    expect(await reader.repoStats("octo", "demo", 7)).toEqual({
      owner: "octo",
      repo: "demo",
      sinceDays: 7,
      runs: 3,
      avgCostUsd: 0.3,
      avgLatencyMs: 90_000,
    });
  });

  it("widens the window when asked", async () => {
    const reader = createPrismaStatsReader(prisma, () => NOW);
    expect(await reader.repoStats("octo", "demo", 30)).toMatchObject({ runs: 4, avgCostUsd: 0.5 });
  });

  it("returns null for a repo with no runs, and treats hostile names as plain values", async () => {
    const reader = createPrismaStatsReader(prisma, () => NOW);
    expect(await reader.repoStats("octo", "nope", 30)).toBeNull();
    expect(await reader.repoStats("octo", "demo' OR '1'='1", 30)).toBeNull();
  });
});
