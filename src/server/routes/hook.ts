import type { FastifyInstance, FastifyRequest } from "fastify";
import { ForbiddenError, UnauthorizedError } from "../../core/errors.js";
import type { ActionsClaims, HookDeps } from "../../core/ports.js";
import { HookBody, runKey } from "../../schemas/jobs.js";
import type { PrepareJob } from "../../schemas/jobs.js";

/** The hook body is ~200 bytes; anything much bigger is not from our Action. */
export const HOOK_BODY_LIMIT = 16 * 1024;

function bearerToken(header: string | undefined): string {
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  if (!match?.[1]) throw new UnauthorizedError("missing bearer token");
  return match[1];
}

/**
 * POST /hooks/pr: verify the Actions OIDC token (before the body is parsed), validate the body,
 * bind it to the token's repository, enqueue the idempotent prepare job, reply 202 { runId }.
 * No GitHub or Claude calls happen in this process.
 */
export async function hookRoutes(app: FastifyInstance, deps: HookDeps): Promise<void> {
  const claimsByRequest = new WeakMap<FastifyRequest, ActionsClaims>();

  app.post(
    "/hooks/pr",
    {
      bodyLimit: HOOK_BODY_LIMIT,
      // onRequest runs before content-type parsing: unauthenticated bodies are never parsed.
      onRequest: async (request) => {
        const token = bearerToken(request.headers.authorization);
        claimsByRequest.set(request, await deps.verifyToken(token));
      },
    },
    async (request, reply) => {
      const claims = claimsByRequest.get(request);
      if (!claims) throw new UnauthorizedError("missing bearer token");

      const parsed = HookBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid body", issues: parsed.error.issues });
      }
      const body = parsed.data;

      const [claimOwner, claimRepo] = claims.repository.split("/");
      if (
        !claimOwner ||
        !claimRepo ||
        body.owner.toLowerCase() !== claimOwner.toLowerCase() ||
        body.repo.toLowerCase() !== claimRepo.toLowerCase()
      ) {
        throw new ForbiddenError("body repository does not match token repository");
      }

      // Canonicalise to the token's (GitHub's) casing so case variants share one runId.
      const ref = { owner: claimOwner, repo: claimRepo, pr: body.pr };
      const job: PrepareJob = { ...body, ...ref, runId: runKey(ref, body.headSha) };
      const { runId } = await deps.enqueuePrepare(job);

      request.log.info(
        { runId, repository: claims.repository, pr: body.pr, headSha: body.headSha, event: claims.eventName },
        "review enqueued",
      );
      return reply.code(202).send({ runId });
    },
  );
}
