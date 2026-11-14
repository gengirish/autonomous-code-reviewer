import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";
import { parseDatabaseUrl } from "./url.js";

export type { PrismaClient } from "./generated/client.js";

/**
 * Prisma Client over node-postgres (Prisma 7 requires a driver adapter).
 * Accepts `?schema=` and `?connection_limit=` (see url.ts). Call `$disconnect()` on shutdown.
 */
export function createPrisma(databaseUrl: string): PrismaClient {
  const { connectionString, schema, max } = parseDatabaseUrl(databaseUrl);
  const adapter = new PrismaPg(
    {
      connectionString,
      ...(max !== undefined ? { max } : {}),
      // Unqualified names (e.g. enum casts) must resolve in the same schema as the tables.
      ...(schema !== undefined ? { options: `-c search_path=${schema}` } : {}),
    },
    schema !== undefined ? { schema } : undefined,
  );
  return new PrismaClient({ adapter });
}
