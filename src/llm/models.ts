/** The only place model strings and effort settings live. */
export const MODEL = "claude-opus-5-5";

/** SAME for all four agents: a different top-level effort per agent invalidates the shared messages cache. */
export const AGENT_EFFORT = "medium" as const;
export const JUDGE_EFFORT = "high" as const;

export const MAX_TOKENS = 16_000;

/**
 * USD per 1M tokens for MODEL. Source: claude-api skill model table (cached 2026-11-03).
 * Re-check pricing before quoting numbers.
 */
export const PRICING = {
  input: 4,
  output: 20,
  cacheRead: 0.2,
  /** 5-minute TTL cache write = 1.25 × input */
  cacheWrite5m: 5,
} as const;
