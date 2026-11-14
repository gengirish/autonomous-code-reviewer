import { UnrecoverableError } from "bullmq";
import type { z } from "zod";
import type { ContextStore } from "../../core/ports.js";
import { isPermanent } from "../../core/errors.js";
import type { PrRef, ReviewContext } from "../../schemas/index.js";

/** The parts of a BullMQ Job the processors use (BullMQ's Job satisfies it; tests pass plain objects). */
export interface JobLike {
  data: unknown;
  id?: string;
  /** Creation time (epoch ms). */
  timestamp?: number;
  attemptsMade?: number;
}

export interface ParentJobLike extends JobLike {
  getChildrenValues(): Promise<Record<string, unknown> | undefined>;
  getIgnoredChildrenFailures(): Promise<Record<string, string> | undefined>;
}

/** Zod-parse our own payload. A malformed payload never becomes valid on retry. */
export function parseJob<S extends z.ZodType>(schema: S, job: JobLike): z.infer<S> {
  const res = schema.safeParse(job.data);
  if (!res.success) throw new UnrecoverableError(`invalid job payload for ${job.id ?? "?"}: ${res.error.message}`);
  return res.data;
}

export interface LoadedRun {
  contexts: ReviewContext[];
  ref: PrRef;
  headSha: string;
}

/** Contexts are the source of ref/headSha downstream of prepare. Expired contexts are not retryable. */
export async function loadRun(store: ContextStore, runId: string): Promise<LoadedRun> {
  const contexts = await store.getContexts(runId);
  const first = contexts?.[0];
  if (!contexts || !first) throw new UnrecoverableError(`contexts for ${runId} are missing (expired?)`);
  return { contexts, ref: { owner: first.owner, repo: first.repo, pr: first.pr }, headSha: first.headSha };
}

/** True when a newer head SHA has been seen for the PR. An absent guard (expired) is not "superseded". */
export async function isSuperseded(store: ContextStore, ref: PrRef, headSha: string): Promise<boolean> {
  const latest = await store.getLatest(ref);
  return latest !== null && latest !== headSha;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Permanent domain errors become UnrecoverableError (no retry); everything else is rethrown for backoff. */
export function toRetryable(err: unknown): never {
  if (isPermanent(err)) throw new UnrecoverableError(`${err.name}: ${err.message}`);
  throw err;
}

/** Map with at most `limit` promises in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(lanes);
  return results;
}
