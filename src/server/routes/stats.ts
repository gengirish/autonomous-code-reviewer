import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { StatsReader } from "../../core/ports.js";

/** GitHub owner/repo name characters; also keeps the values short and log-safe. */
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export const StatsQuery = z.object({
  owner: z.string().regex(GITHUB_NAME),
  repo: z.string().regex(GITHUB_NAME),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/**
 * GET /stats/runs?owner=&repo=&days= — review count, average cost and latency for one repo.
 * Registered by buildServer under /admin, behind basic auth; never public.
 */
export async function statsRoutes(app: FastifyInstance, stats: StatsReader): Promise<void> {
  app.get("/stats/runs", async (request, reply) => {
    const parsed = StatsQuery.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid query", issues: parsed.error.issues });
    }
    const { owner, repo, days } = parsed.data;

    request.log.info({ owner, repo, days }, "stats request");
    const result = await stats.repoStats(owner, repo, days);
    if (!result) return reply.code(404).send({ error: "no runs in window" });
    return result;
  });
}
