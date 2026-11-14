import type { Redis } from "ioredis";
import type { ContextStore } from "../core/ports.js";
import { ReviewContext, type PrRef } from "../schemas/index.js";

export interface RedisContextStoreOptions {
  /** Prefix for every key this store writes. Default "acr:". */
  keyPrefix?: string;
  /** TTL of stored ReviewContexts. Default 1h. */
  contextTtlSeconds?: number;
  /** TTL of the "latest SHA" guard. Default 24h. */
  latestTtlSeconds?: number;
}

const ContextList = ReviewContext.array();

/** ContextStore over Redis: JSON values with TTLs. Keys: `<prefix>ctx:<runId>`, `<prefix>latest:<owner>/<repo>#<pr>`. */
export class RedisContextStore implements ContextStore {
  private readonly prefix: string;
  private readonly contextTtl: number;
  private readonly latestTtl: number;

  constructor(
    private readonly redis: Redis,
    opts: RedisContextStoreOptions = {},
  ) {
    this.prefix = opts.keyPrefix ?? "acr:";
    this.contextTtl = opts.contextTtlSeconds ?? 60 * 60;
    this.latestTtl = opts.latestTtlSeconds ?? 24 * 60 * 60;
  }

  contextKey(runId: string): string {
    return `${this.prefix}ctx:${runId}`;
  }

  latestKey(ref: PrRef): string {
    return `${this.prefix}latest:${ref.owner}/${ref.repo}#${ref.pr}`;
  }

  async putContexts(runId: string, contexts: ReviewContext[]): Promise<void> {
    await this.redis.set(this.contextKey(runId), JSON.stringify(contexts), "EX", this.contextTtl);
  }

  async getContexts(runId: string): Promise<ReviewContext[] | null> {
    const raw = await this.redis.get(this.contextKey(runId));
    if (raw === null) return null;
    return ContextList.parse(JSON.parse(raw));
  }

  async setLatest(ref: PrRef, headSha: string): Promise<void> {
    await this.redis.set(this.latestKey(ref), headSha, "EX", this.latestTtl);
  }

  async getLatest(ref: PrRef): Promise<string | null> {
    return this.redis.get(this.latestKey(ref));
  }
}
