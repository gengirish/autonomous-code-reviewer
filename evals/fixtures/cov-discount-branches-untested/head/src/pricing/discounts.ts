// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import type { Coupon, LoyaltyProfile, LoyaltyTier } from "./types";

const TIER_RATE: Record<LoyaltyTier, number> = { none: 0, silver: 0.05, gold: 0.1, platinum: 0.15 };
const FIRST_ORDER_RATE = 0.1;
const LONG_TENURE_YEARS = 5;
const LONG_TENURE_BONUS = 0.02;
/** Coupon + loyalty together never exceed this share of the subtotal. */
const MAX_COMBINED_SHARE = 0.3;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Discount in cents from a coupon, never more than the subtotal. */
export function couponDiscountCents(subtotalCents: number, coupon: Coupon | null): number {
  if (!coupon || subtotalCents <= 0) return 0;
  const raw = coupon.kind === "percent" ? Math.round((subtotalCents * coupon.percent) / 100) : coupon.amountCents;
  return Math.min(raw, subtotalCents);
}

/**
 * Loyalty discount in cents. Stacks with a coupon, but coupon + loyalty never exceed
 * MAX_COMBINED_SHARE of the subtotal: the loyalty part is reduced first.
 */
export function loyaltyDiscountCents(
  subtotalCents: number,
  couponCents: number,
  profile: LoyaltyProfile,
  now: Date,
): number {
  if (subtotalCents <= 0) return 0;

  let rate = TIER_RATE[profile.tier];
  if (profile.completedOrders === 0) {
    rate = Math.max(rate, FIRST_ORDER_RATE);
  } else if ((now.getTime() - profile.memberSince.getTime()) / MS_PER_YEAR >= LONG_TENURE_YEARS) {
    rate += LONG_TENURE_BONUS;
  }

  const loyalty = Math.round(subtotalCents * rate);
  const headroom = Math.floor(subtotalCents * MAX_COMBINED_SHARE) - couponCents;
  if (headroom <= 0) return 0;
  return Math.min(loyalty, headroom);
}
