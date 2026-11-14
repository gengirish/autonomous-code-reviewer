import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { CryptoKey, JWTPayload, JWTVerifyGetKey } from "jose";
import { ACTIONS_ISSUER } from "../../../src/server/auth/oidc.js";

export const AUDIENCE = "ai-reviewer";

export interface TestKeys {
  privateKey: CryptoKey;
  jwks: JWTVerifyGetKey;
}

/** Local RS256 key pair + JWKS: the same shape GitHub serves, no network. */
export async function makeKeys(kid = "test-key"): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

export interface MintOptions {
  claims?: JWTPayload;
  audience?: string;
  issuer?: string;
  /** Seconds relative to now. */
  iatOffset?: number;
  expOffset?: number;
  kid?: string;
}

export async function mintToken(key: CryptoKey, opts: MintOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repository: "octo/demo",
    repository_owner: "octo",
    event_name: "pull_request",
    ref: "refs/pull/7/merge",
    ...opts.claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "test-key" })
    .setIssuer(opts.issuer ?? ACTIONS_ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject("repo:octo/demo:pull_request")
    .setIssuedAt(now + (opts.iatOffset ?? 0))
    .setExpirationTime(now + (opts.expOffset ?? 300))
    .sign(key);
}
