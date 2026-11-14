import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { ForbiddenError, UnauthorizedError } from "../../core/errors.js";
import type { ActionsClaims, HookDeps } from "../../core/ports.js";

export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const ACTIONS_JWKS_URL = `${ACTIONS_ISSUER}/.well-known/jwks`;
export const ALLOWED_EVENTS: readonly string[] = ["pull_request", "pull_request_target"];

/** GitHub Actions OIDC tokens are valid for minutes; refuse anything older (replay window). */
const MAX_TOKEN_AGE = "15m";
const CLOCK_TOLERANCE_S = 30;

/** The subset of GitHub's OIDC claims we rely on. Validated: the token is a boundary. */
const ClaimsSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected owner/repo"),
  repository_owner: z.string().min(1),
  event_name: z.string().min(1),
});

export interface ActionsVerifierOptions {
  /** Must equal the `aud` claim (env OIDC_AUDIENCE, default "ai-reviewer"). */
  audience: string;
  /** Repository owners allowed to request reviews (env ALLOWED_OWNERS). Empty list = nobody. */
  allowedOwners: string[];
  /** Key source. Defaults to GitHub's remote JWKS; tests pass `createLocalJWKSet`. */
  jwks?: JWTVerifyGetKey;
}

/**
 * Verifies a GitHub Actions OIDC JWT.
 * - bad signature / malformed / expired / wrong aud or iss / missing claims → UnauthorizedError (401)
 * - owner not allow-listed / event not a PR event → ForbiddenError (403)
 * Errors fetching the JWKS itself (network, timeout) are rethrown and surface as 5xx.
 */
export function createActionsVerifier(opts: ActionsVerifierOptions): HookDeps["verifyToken"] {
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(ACTIONS_JWKS_URL));
  const allowed = new Set(opts.allowedOwners.map((o) => o.trim().toLowerCase()).filter(Boolean));

  return async function verifyToken(token: string): Promise<ActionsClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: ACTIONS_ISSUER,
        audience: opts.audience,
        algorithms: ["RS256"],
        maxTokenAge: MAX_TOKEN_AGE,
        clockTolerance: CLOCK_TOLERANCE_S,
      }));
    } catch (err) {
      if (err instanceof errors.JWKSTimeout) throw err;
      if (err instanceof errors.JWTExpired) throw new UnauthorizedError("token expired", { cause: err });
      if (err instanceof errors.JWTClaimValidationFailed) {
        throw new UnauthorizedError(`token claim "${err.claim}" invalid`, { cause: err });
      }
      if (err instanceof errors.JOSEError || err instanceof TypeError) {
        throw new UnauthorizedError("invalid token", { cause: err });
      }
      throw err;
    }

    const parsed = ClaimsSchema.safeParse(payload);
    if (!parsed.success) throw new UnauthorizedError("token is missing required claims");
    const { repository, repository_owner: owner, event_name: eventName } = parsed.data;

    if (repository.split("/")[0]?.toLowerCase() !== owner.toLowerCase()) {
      throw new UnauthorizedError("token repository and repository_owner disagree");
    }
    if (!allowed.has(owner.toLowerCase())) throw new ForbiddenError("repository owner not allowed");
    if (!ALLOWED_EVENTS.includes(eventName)) throw new ForbiddenError(`event "${eventName}" not allowed`);

    return { repository, owner, eventName };
  };
}
