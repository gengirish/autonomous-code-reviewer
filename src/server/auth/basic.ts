import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface BasicCredentials {
  user: string;
  password: string;
}

const REALM = 'Basic realm="acr-admin", charset="UTF-8"';

/** Hash both sides first so timingSafeEqual always compares equal-length buffers (no length leak). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function parseBasicAuth(header: string | undefined): BasicCredentials | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

/** Fastify onRequest hook enforcing HTTP basic auth with a constant-time credential check. */
export function basicAuthHook(expected: BasicCredentials) {
  if (!expected.user || !expected.password) throw new Error("basic auth requires a non-empty user and password");
  return async function basicAuth(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
    const given = parseBasicAuth(request.headers.authorization);
    // Evaluate both comparisons unconditionally (no short-circuit on the user name).
    const userOk = safeEqual(given?.user ?? "", expected.user);
    const passOk = safeEqual(given?.password ?? "", expected.password);
    if (given && userOk && passOk) return undefined;
    return reply.code(401).header("www-authenticate", REALM).send({ error: "unauthorized" });
  };
}
