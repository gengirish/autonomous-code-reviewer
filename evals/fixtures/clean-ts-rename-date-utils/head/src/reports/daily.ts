// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import type { OrderSummary } from "../orders/types";
import { toUtcDayKey } from "../utils/dates";

export interface DailyRevenue {
  day: string;
  orders: number;
  revenueCents: number;
}

/** Revenue per UTC day, oldest day first. */
export function dailyRevenue(orders: OrderSummary[]): DailyRevenue[] {
  const byDay = new Map<string, DailyRevenue>();
  for (const order of orders) {
    const day = toUtcDayKey(order.paidAt);
    const entry = byDay.get(day) ?? { day, orders: 0, revenueCents: 0 };
    entry.orders += 1;
    entry.revenueCents += order.totalCents;
    byDay.set(day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}
