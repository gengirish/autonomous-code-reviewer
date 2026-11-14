// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import { describe, expect, it } from "vitest";
import { isSameUtcDay, startOfUtcDay, toUtcDayKey, utcDaysBetween } from "./dates";

describe("date utils", () => {
  it("startOfUtcDay drops the time of day", () => {
    expect(startOfUtcDay(new Date("2026-03-29T23:59:59Z")).toISOString()).toBe("2026-03-29T00:00:00.000Z");
  });

  it("utcDaysBetween counts calendar days, not 24h periods", () => {
    expect(utcDaysBetween(new Date("2026-03-01T23:00:00Z"), new Date("2026-03-02T01:00:00Z"))).toBe(1);
    expect(utcDaysBetween(new Date("2026-03-05T00:00:00Z"), new Date("2026-03-01T00:00:00Z"))).toBe(-4);
  });

  it("isSameUtcDay compares UTC calendar days", () => {
    expect(isSameUtcDay(new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T23:59:59Z"))).toBe(true);
    expect(isSameUtcDay(new Date("2026-03-01T23:59:59Z"), new Date("2026-03-02T00:00:00Z"))).toBe(false);
  });

  it("toUtcDayKey formats as YYYY-MM-DD", () => {
    expect(toUtcDayKey(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12-31");
  });
});
