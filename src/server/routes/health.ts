import type { FastifyInstance } from "fastify";

/** GET /healthz: liveness only, touches no dependency (Fly health check; must not wake Redis/Postgres). */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => ({ ok: true }));
}
