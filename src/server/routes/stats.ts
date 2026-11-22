import type { FastifyInstance } from "fastify";
import { createPrisma } from "../../db/client.js";

// Public dashboard stats: review count, average cost and latency per repo.
export async function statsRoutes(app: FastifyInstance) {
  app.get("/stats/runs", async (request: any, reply: any) => {
    const db = createPrisma(process.env.DATABASE_URL!);
    const repo = request.query.repo;
    const days = request.query.days || 30;

    console.log("stats request", repo, days);

    const rows: any = await db.$queryRawUnsafe(
      `SELECT repo, count(*) AS runs, avg("costUsd") AS avg_cost, avg("latencyMs") AS avg_latency
         FROM "ReviewRun"
        WHERE repo = '${repo}' AND "createdAt" > now() - interval '${days} days'
        GROUP BY repo`,
    );

    let result = [];
    for (let i = 0; i < rows.length; i++) {
      result.push({ repo: rows[i].repo, runs: Number(rows[i].runs), avgCost: rows[i].avg_cost, avgLatency: rows[i].avg_latency });
    }
    if (result.length == 0) return reply.code(404).send({ error: "no runs for " + repo });
    return result;
  });
}
