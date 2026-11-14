import { Redis } from "ioredis";

/**
 * Redis connection shared by queues, flow producers and workers.
 * - `maxRetriesPerRequest: null` is required by BullMQ workers (blocking commands).
 * - `family`: 6 on Fly's private network (Upstash via `fly redis create`), 4 locally
 *   (`family: 6` can break `localhost`). Comes from `env.REDIS_FAMILY`.
 */
export function createRedis(url: string, family: 4 | 6 = 4): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, family });
}
