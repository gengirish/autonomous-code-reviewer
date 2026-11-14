// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import moment from "moment";
import { logger } from "../lib/logger";
import { cartRepository } from "../repositories/cartRepository";

/** Abandoned carts older than this are deleted; reminders stop after 7 days. */
const ABANDONED_RETENTION_DAYS = 30;

export default async function purgeAbandonedCarts(now: Date = new Date()): Promise<number> {
  const cutoff = moment(now).subtract(ABANDONED_RETENTION_DAYS, "days").toDate();
  const ids = await cartRepository.findIdsUpdatedBefore(cutoff, { status: "abandoned" });
  if (ids.length === 0) return 0;

  console.log(`purging ${ids.length} abandoned carts last updated before ${cutoff.toISOString()}`);
  const deleted = await cartRepository.deleteMany(ids);
  logger.info("abandoned carts purged", { requested: ids.length, deleted });
  return deleted;
}
