/**
 * Pure DATABASE_URL handling for @prisma/adapter-pg (no generated-client import).
 *
 * Prisma-style query parameters that `pg` doesn't understand are translated and stripped:
 * - `schema=<name>`          → adapter `schema` option + `search_path` (Prisma 7 + adapter-pg
 *                               ignore `?schema=` in the URL, so it must be passed explicitly)
 * - `connection_limit=<n>`   → pg pool `max` (size it to worker concurrency; acr-database)
 */
export interface PgConnectionSettings {
  connectionString: string;
  schema?: string;
  max?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseDatabaseUrl(databaseUrl: string): PgConnectionSettings {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`DATABASE_URL must be a postgres URL, got protocol "${url.protocol}"`);
  }

  const settings: PgConnectionSettings = { connectionString: "" };

  const schema = url.searchParams.get("schema");
  if (schema !== null) {
    if (!IDENTIFIER.test(schema)) throw new Error(`Invalid schema name in DATABASE_URL: "${schema}"`);
    if (schema !== "public") settings.schema = schema;
    url.searchParams.delete("schema");
  }

  const limit = url.searchParams.get("connection_limit");
  if (limit !== null) {
    const max = Number(limit);
    if (!Number.isSafeInteger(max) || max < 1) throw new Error(`Invalid connection_limit in DATABASE_URL: "${limit}"`);
    settings.max = max;
    url.searchParams.delete("connection_limit");
  }

  settings.connectionString = url.toString();
  return settings;
}
