import type { FlowProducer } from "bullmq";
import type {
  BuildReviewContext,
  ContextStore,
  CostOf,
  DecideEvent,
  IsSkippedPath,
  LlmClient,
  PrSource,
  RenderContext,
  RenderReview,
  RepoConfig,
  ReviewPublisher,
  RunAgent,
  RunJudge,
  RunRecorder,
} from "../core/ports.js";
import type { Logger } from "../core/logger.js";
import type { ReviewFlowOptions } from "../queue/flows.js";
import type { PrRef } from "../schemas/index.js";

/** Everything the processors need. `src/worker/index.ts` wires the real modules. */
export interface WorkerDeps {
  prSourceFor(ref: PrRef): Promise<PrSource>;
  publisherFor(ref: PrRef): Promise<ReviewPublisher>;
  llm: LlmClient;
  contextStore: ContextStore;
  recorder: RunRecorder;
  repoConfig(ref: PrRef): Promise<RepoConfig>;
  buildReviewContext: BuildReviewContext;
  isSkippedPath: IsSkippedPath;
  renderContext: RenderContext;
  runAgent: RunAgent;
  runJudge: RunJudge;
  decideEvent: DecideEvent;
  renderReview: RenderReview;
  costOf: CostOf;
  logger: Logger;
  /** Must use the same connection prefix as the workers. */
  flowProducer: FlowProducer;
  /** Repo files fetched as lint context. Default: DEFAULT_LINT_CONFIG_PATHS. */
  lintConfigPaths?: string[];
  /** Attempts/backoff for the review flow (tests shorten the delays). */
  flowOptions?: Omit<ReviewFlowOptions, "startedAt">;
}

export const DEFAULT_LINT_CONFIG_PATHS: readonly string[] = [
  "eslint.config.js",
  "eslint.config.mjs",
  ".eslintrc.json",
  ".eslintrc.js",
  ".prettierrc",
  "ruff.toml",
  "pyproject.toml",
];
