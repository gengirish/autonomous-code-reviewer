// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import { couponDiscountCents, loyaltyDiscountCents } from "../pricing/discounts";
import type { Coupon, LoyaltyProfile } from "../pricing/types";
import type { Cart } from "./types";

export interface Totals {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

export function computeTotals(
  cart: Cart,
  coupon: Coupon | null,
  loyalty: LoyaltyProfile | null = null,
  now: Date = new Date(),
): Totals {
  const subtotalCents = cart.items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const couponCents = couponDiscountCents(subtotalCents, coupon);
  const loyaltyCents = loyalty ? loyaltyDiscountCents(subtotalCents, couponCents, loyalty, now) : 0;
  const discountCents = couponCents + loyaltyCents;
  return { subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}
