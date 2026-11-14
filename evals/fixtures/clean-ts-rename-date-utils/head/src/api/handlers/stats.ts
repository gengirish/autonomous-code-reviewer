// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import type { Request, Response } from "express";
import { ordersSince } from "../../orders/queries";
import { dailyRevenue } from "../../reports/daily";
import { isSameUtcDay, startOfUtcDay } from "../../utils/dates";

const DEFAULT_WINDOW_DAYS = 30;

export async function getRevenueStats(req: Request, res: Response): Promise<void> {
  const days = Math.min(Math.max(Math.trunc(Number(req.query.days)) || DEFAULT_WINDOW_DAYS, 1), 365);
  const now = new Date();
  const since = startOfUtcDay(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  const orders = await ordersSince(req.user.accountId, since);
  const revenue = dailyRevenue(orders);
  const last = revenue.at(-1);
  res.json({
    since: since.toISOString(),
    days: revenue,
    // today's bucket is still filling up; the dashboard greys it out
    todayIsPartial: last !== undefined && isSameUtcDay(new Date(`${last.day}T00:00:00Z`), now),
  });
}
