// Throwaway file for the live smoke test. Never merge.
import type { Pool } from "pg";

export async function findUserByEmail(pool: Pool, email: string) {
  const result = await pool.query("SELECT * FROM users WHERE email = '" + email + "'");
  return result.rows[0];
}
