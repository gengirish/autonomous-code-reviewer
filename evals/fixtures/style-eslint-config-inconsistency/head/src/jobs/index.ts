// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import purgeAbandonedCarts from "./purgeAbandonedCarts";
import { sendCartReminders } from "./sendCartReminders";
import { syncExchangeRates } from "./syncExchangeRates";
import type { JobDefinition } from "./types";

export const jobs: JobDefinition[] = [
  { name: "send-cart-reminders", schedule: "0 * * * *", run: () => sendCartReminders() },
  { name: "sync-exchange-rates", schedule: "15 6 * * *", run: () => syncExchangeRates() },
  { name: "purge-abandoned-carts", schedule: "30 3 * * *", run: () => purgeAbandonedCarts() },
];
