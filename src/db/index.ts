import type { RunRecorder, StatsReader } from "../core/ports.js";
import { noopRecorder } from "../core/recorder.js";
import { getEnv } from "../env.js";
import { createPrisma } from "./client.js";
import { createPrismaRecorder } from "./recorder.js";
import { createPrismaStatsReader } from "./stats.js";

export { createPrisma } from "./client.js";
export type { PrismaClient } from "./client.js";
export { createPrismaRecorder } from "./recorder.js";
export { createPrismaStatsReader, toRunStats } from "./stats.js";
export type { RunAggregate } from "./stats.js";
export { parseDatabaseUrl } from "./url.js";
export type { PgConnectionSettings } from "./url.js";
export * from "./mapping.js";

/** A RunRecorder that can release its connection pool on shutdown. */
export type ClosableRecorder = RunRecorder & { close(): Promise<void> };

/** Recorder and stats reader sharing one connection pool. `stats` is absent without a database. */
export interface Db {
  recorder: RunRecorder;
  stats?: StatsReader;
  close(): Promise<void>;
}

/**
 * Postgres-backed Db when a database URL is configured (argument, else `DATABASE_URL`),
 * otherwise the no-op recorder and no stats (dev, tests, evals).
 */
export function createDbFromEnv(databaseUrl: string | undefined = getEnv().DATABASE_URL): Db {
  if (!databaseUrl) return { recorder: noopRecorder, async close() {} };
  const prisma = createPrisma(databaseUrl);
  return {
    recorder: createPrismaRecorder(prisma),
    stats: createPrismaStatsReader(prisma),
    close: () => prisma.$disconnect(),
  };
}

/** Recorder-only view of `createDbFromEnv` (the worker never reads stats). */
export function createRecorderFromEnv(databaseUrl: string | undefined = getEnv().DATABASE_URL): ClosableRecorder {
  const db = createDbFromEnv(databaseUrl);
  return { ...db.recorder, close: db.close };
}
