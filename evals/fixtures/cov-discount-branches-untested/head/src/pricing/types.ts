// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
export type Coupon = { kind: "percent"; percent: number } | { kind: "fixed"; amountCents: number };

export type LoyaltyTier = "none" | "silver" | "gold" | "platinum";

export interface LoyaltyProfile {
  tier: LoyaltyTier;
  completedOrders: number;
  memberSince: Date;
}
