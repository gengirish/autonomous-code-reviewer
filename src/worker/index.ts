/**
 * Worker process: prepare → 4 agents → judge → publish (acr-queue).
 * Wires the real modules into WorkerDeps.
 */
import { FlowProducer } from "bullmq";
import { logger } from "../core/logger.js";
import { DEFAULT_REPO_CONFIG } from "../core/ports.js";
import { runAgent } from "../agents/index.js";
import { createRecorderFromEnv } from "../db/index.js";
import { getEnv, githubPrivateKey, requireEnv } from "../env.js";
import { createGitHubApp, createGitHubFactories } from "../github/index.js";
import { decideEvent, runJudge } from "../judge/index.js";
import { AnthropicLlmClient, costOf } from "../llm/index.js";
import { buildReviewContext, isSkippedPath, renderContext } from "../parser/index.js";
import { createRedis, RedisContextStore } from "../queue/index.js";
import { renderReview } from "../render/index.js";
import { createWorkers, type WorkerDeps } from "./exports.js";

async function main() {
  const env = getEnv();
  requireEnv("ANTHROPIC_API_KEY", env); // fail fast; the SDK reads it from process.env itself

  const connection = createRedis(env.REDIS_URL, env.REDIS_FAMILY);
  const flowProducer = new FlowProducer({ connection });
  const recorder = createRecorderFromEnv(env.DATABASE_URL);
  const github = createGitHubFactories(
    createGitHubApp({ appId: requireEnv("GITHUB_APP_ID", env), privateKey: githubPrivateKey(env) }),
    { logger },
  );

  const deps: WorkerDeps = {
    prSourceFor: github.prSourceFor,
    publisherFor: github.publisherFor,
    llm: new AnthropicLlmClient({ logger }),
    contextStore: new RedisContextStore(connection),
    recorder,
    repoConfig: async () => DEFAULT_REPO_CONFIG, // per-repo .ai-reviewer.yml arrives in phase 7
    buildReviewContext,
    isSkippedPath,
    renderContext,
    runAgent,
    runJudge,
    decideEvent,
    renderReview,
    costOf,
    logger,
    flowProducer,
  };

  const { close } = createWorkers(deps, connection);
  logger.info("worker started");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down: finishing in-flight jobs");
    await close();
    await flowProducer.close();
    await recorder.close();
    await connection.quit();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
