import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().int().positive().default(8080),

  ANTHROPIC_API_KEY: z.string().optional(),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY_B64: z.string().optional(),

  REDIS_URL: z.string().default("redis://localhost:6379"),
  REDIS_FAMILY: z.coerce.number().pipe(z.union([z.literal(4), z.literal(6)])).default(4),

  DATABASE_URL: z.string().optional(),

  OIDC_AUDIENCE: z.string().default("ai-reviewer"),
  ALLOWED_OWNERS: csv,

  BULL_BOARD_USER: z.string().optional(),
  BULL_BOARD_PASSWORD: z.string().optional(),
});
export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parsed process.env (cached). Components that need a secret call `requireEnv`. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source !== process.env) return EnvSchema.parse(source);
  cached ??= EnvSchema.parse(source);
  return cached;
}

export function requireEnv<K extends keyof Env>(key: K, env: Env = getEnv()): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required environment variable ${String(key)}`);
  }
  return value as NonNullable<Env[K]>;
}

/** PEM private key decoded from GITHUB_APP_PRIVATE_KEY_B64. */
export function githubPrivateKey(env: Env = getEnv()): string {
  return Buffer.from(requireEnv("GITHUB_APP_PRIVATE_KEY_B64", env), "base64").toString("utf8");
}
