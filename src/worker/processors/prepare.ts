import { addReviewFlow } from "../../queue/flows.js";
import { PrepareJob, type PrRef, type ReviewContext } from "../../schemas/index.js";
import type { PrFile } from "../../core/ports.js";
import { DEFAULT_LINT_CONFIG_PATHS, type WorkerDeps } from "../deps.js";
import { isPermanent } from "../../core/errors.js";
import { errorMessage, mapLimit, parseJob, toRetryable, type JobLike } from "./shared.js";

export const CONTENT_FETCH_CONCURRENCY = 8;
export const NO_PATCH_REASON = "no diff available (binary or too large)";

export type PrepareResult =
  | { status: "skipped"; reason: string }
  | { status: "superseded"; latestSha: string }
  | { status: "queued"; runId: string; chunks: number; files: number; skipped: number };

/**
 * prepare: PR meta → skip/supersede checks → files + contents + lint configs → ReviewContexts
 * (stored in Redis) → review flow. Re-running it is safe: the flow's jobIds are deterministic.
 */
export async function processPrepare(job: JobLike, deps: WorkerDeps): Promise<PrepareResult> {
  const data = parseJob(PrepareJob, job);
  try {
    return await prepare(job, data, deps);
  } catch (err) {
    if (isPermanent(err)) await deps.recorder.runStatus(data.runId, "FAILED", errorMessage(err));
    return toRetryable(err);
  }
}

async function prepare(job: JobLike, data: PrepareJob, deps: WorkerDeps): Promise<PrepareResult> {
  const { runId, headSha } = data;
  const ref: PrRef = { owner: data.owner, repo: data.repo, pr: data.pr };
  const log = deps.logger.child({ runId, stage: "prepare" });

  const source = await deps.prSourceFor(ref);
  const meta = await source.getPr(ref);
  // GitHub's head SHA is authoritative: claiming "latest" with it immediately supersedes older runs,
  // and a re-delivered older hook can never move the guard backwards.
  await deps.contextStore.setLatest(ref, meta.headSha);

  if (meta.state === "closed" || meta.draft) {
    const reason = meta.state === "closed" ? "PR is closed" : "PR is a draft";
    await deps.recorder.runStatus(runId, "SKIPPED", reason);
    log.info({ reason }, "run skipped");
    return { status: "skipped", reason };
  }
  if (meta.headSha !== headSha) {
    await deps.recorder.runStatus(runId, "SUPERSEDED", `head is now ${meta.headSha.slice(0, 12)}`);
    log.info("run superseded before prepare");
    return { status: "superseded", latestSha: meta.headSha };
  }

  const files = await source.listFiles(ref);
  const skipped: Array<{ path: string; reason: string }> = [];
  const reviewable: PrFile[] = [];
  for (const file of files) {
    const reason = deps.isSkippedPath(file.path) ?? (file.patch === undefined ? NO_PATCH_REASON : null);
    if (reason) skipped.push({ path: file.path, reason });
    else reviewable.push(file);
  }

  const contents = new Map<string, string>();
  await mapLimit(reviewable, CONTENT_FETCH_CONCURRENCY, async (file) => {
    // A removed file has no head version; the parser works from its (deletion-only) patch.
    contents.set(file.path, file.status === "removed" ? "" : await source.getContent(ref, file));
  });

  const lintConfigs = new Map<string, string>();
  if (source.getRepoFile) {
    const getRepoFile = source.getRepoFile.bind(source);
    const paths = deps.lintConfigPaths ?? DEFAULT_LINT_CONFIG_PATHS;
    await mapLimit(paths, CONTENT_FETCH_CONCURRENCY, async (path) => {
      const text = await getRepoFile(ref, path, meta.headSha);
      if (text !== null) lintConfigs.set(path, text);
    });
  }

  const built = await deps.buildReviewContext({ runId, ref, meta, files, contents, lintConfigs });
  if (built.length === 0) {
    const reason = "no reviewable files";
    await deps.recorder.runStatus(runId, "SKIPPED", reason);
    log.info({ files: files.length, skipped: skipped.length }, "run skipped: nothing to review");
    return { status: "skipped", reason };
  }
  const contexts = built.map((ctx) => withSkipped(ctx, skipped));

  await deps.contextStore.putContexts(runId, contexts);
  await addReviewFlow(deps.flowProducer, runId, contexts.length, {
    ...deps.flowOptions,
    ...(job.timestamp === undefined ? {} : { startedAt: job.timestamp }),
  });
  await deps.recorder.runStatus(runId, "RUNNING");
  log.info({ files: files.length, reviewable: reviewable.length, skipped: skipped.length, chunks: contexts.length }, "review flow added");
  return { status: "queued", runId, chunks: contexts.length, files: files.length, skipped: skipped.length };
}

/** Make sure every chunk lists what prepare skipped (the parser may already have listed some). */
function withSkipped(ctx: ReviewContext, skipped: Array<{ path: string; reason: string }>): ReviewContext {
  const known = new Set(ctx.skipped.map((s) => s.path));
  const extra = skipped.filter((s) => !known.has(s.path));
  return extra.length === 0 ? ctx : { ...ctx, skipped: [...ctx.skipped, ...extra] };
}
