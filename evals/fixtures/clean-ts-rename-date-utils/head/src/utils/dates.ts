// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day `date` falls on. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Whole UTC calendar days from `from` to `to` (negative when `to` is earlier). */
export function utcDaysBetween(from: Date, to: Date): number {
  return Math.round((startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / MS_PER_DAY);
}

/** True when both instants fall on the same UTC calendar day. */
export function isSameUtcDay(a: Date, b: Date): boolean {
  return utcDaysBetween(a, b) === 0;
}

/** `YYYY-MM-DD` in UTC, the format our reports and the stats API use as a day key. */
export function toUtcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
