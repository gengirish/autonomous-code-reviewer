import type { RunRecorder } from "../core/ports.js";
import { noopRecorder } from "../core/recorder.js";
import { getEnv } from "../env.js";
import { createPrisma } from "./client.js";
import { createPrismaRecorder } from "./recorder.js";

export { createPrisma } from "./client.js";
export type { PrismaClient } from "./client.js";
export { createPrismaRecorder } from "./recorder.js";
export { parseDatabaseUrl } from "./url.js";
export type { PgConnectionSettings } from "./url.js";
export * from "./mapping.js";

/** A RunRecorder that can release its connection pool on shutdown. */
export type ClosableRecorder = RunRecorder & { close(): Promise<void> };

/**
 * Postgres recorder when a database URL is configured (argument, else `DATABASE_URL`),
 * otherwise the no-op recorder (dev, tests, evals).
 */
export function createRecorderFromEnv(databaseUrl: string | undefined = getEnv().DATABASE_URL): ClosableRecorder {
  if (!databaseUrl) return { ...noopRecorder, async close() {} };
  const prisma = createPrisma(databaseUrl);
  return { ...createPrismaRecorder(prisma), close: () => prisma.$disconnect() };
}
