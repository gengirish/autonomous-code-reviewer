import { describe, expect, it } from "vitest";
import { costOf, MODEL, PRICING } from "../../../src/llm/index.js";

describe("costOf", () => {
  it("prices each token bucket per 1M tokens", () => {
    const usage = { model: MODEL, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf(usage)).toBeCloseTo(PRICING.input);
    expect(costOf({ ...usage, inputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(PRICING.output);
    expect(costOf({ ...usage, inputTokens: 0, cacheReadTokens: 1_000_000 })).toBeCloseTo(PRICING.cacheRead);
    expect(costOf({ ...usage, inputTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(PRICING.cacheWrite5m);
  });

  it("adds the buckets for a typical cached agent call", () => {
    // 2k uncached in ($0.008) + 1.5k out ($0.03) + 40k cache read ($0.008) + 0 write
    const cost = costOf({ model: MODEL, inputTokens: 2_000, outputTokens: 1_500, cacheReadTokens: 40_000, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(0.046, 6);
    expect(costOf({ model: MODEL, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(0);
  });
});
