import type { CostOf } from "../core/ports.js";
import { PRICING } from "./models.js";

/**
 * USD cost of one call from its usage. `inputTokens` is the uncached input only (the API
 * reports cache reads and writes separately), so the four buckets add up without overlap.
 * Priced at MODEL's rates; a reply served by a server-side fallback model is an approximation.
 */
export const costOf: CostOf = (usage) =>
  (usage.inputTokens * PRICING.input +
    usage.outputTokens * PRICING.output +
    usage.cacheReadTokens * PRICING.cacheRead +
    usage.cacheWriteTokens * PRICING.cacheWrite5m) /
  1_000_000;
