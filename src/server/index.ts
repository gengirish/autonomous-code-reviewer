/**
 * Web process: verifies the Action's OIDC token, enqueues the prepare job, returns 202.
 * No GitHub content or Claude calls happen here (acr-project).
 */
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import { Queue } from "bullmq";
import type { FastifyPluginAsync } from "fastify";
import { logger } from "../core/logger.js";
import { createRecorderFromEnv } from "../db/index.js";
import { getEnv } from "../env.js";
import { createPrepareEnqueuer, createRedis } from "../queue/index.js";
import { Q } from "../schemas/index.js";
import { buildServer } from "./app.js";
import { createActionsVerifier } from "./auth/oidc.js";

async function main() {
  const env = getEnv();
  const connection = createRedis(env.REDIS_URL, env.REDIS_FAMILY);
  const recorder = createRecorderFromEnv(env.DATABASE_URL);
  const prepareQueue = new Queue(Q.prepare, { connection });

  const admin =
    env.BULL_BOARD_USER && env.BULL_BOARD_PASSWORD
      ? { user: env.BULL_BOARD_USER, password: env.BULL_BOARD_PASSWORD }
      : undefined;

  let adminPlugin: FastifyPluginAsync | undefined;
  const boardQueues: Queue[] = [];
  if (admin) {
    boardQueues.push(...[Q.agent, Q.judge, Q.publish].map((name) => new Queue(name, { connection })));
    const serverAdapter = new FastifyAdapter();
    serverAdapter.setBasePath("/admin/queues");
    createBullBoard({
      queues: [prepareQueue, ...boardQueues].map((q) => new BullMQAdapter(q)),
      serverAdapter,
    });
    adminPlugin = async (scope) => {
      await scope.register(serverAdapter.registerPlugin(), { prefix: "/queues" });
    };
  }

  if (env.ALLOWED_OWNERS.length === 0) {
    logger.warn("ALLOWED_OWNERS is empty: every review request will be rejected with 403");
  }

  const app = await buildServer({
    verifyToken: createActionsVerifier({ audience: env.OIDC_AUDIENCE, allowedOwners: env.ALLOWED_OWNERS }),
    enqueuePrepare: createPrepareEnqueuer(prepareQueue, { recorder }),
    adminPlugin,
    admin,
    logger: { level: env.LOG_LEVEL },
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "web shutting down");
    await app.close();
    await Promise.all([prepareQueue, ...boardQueues].map((q) => q.close()));
    await recorder.close();
    await connection.quit();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "web failed to start");
  process.exit(1);
});
