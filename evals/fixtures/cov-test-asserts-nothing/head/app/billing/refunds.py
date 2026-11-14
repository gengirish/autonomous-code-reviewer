"""Refund amounts for cancelled subscriptions."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_EVEN, Decimal

_CENT = Decimal("0.01")


@dataclass(frozen=True)
class Subscription:
    plan_price: Decimal
    period_start: date
    period_end: date


def full_refund(sub: Subscription) -> Decimal:
    return sub.plan_price


def prorated_refund(sub: Subscription, cancelled_on: date) -> Decimal:
    """Refund for the unused days of the current period, rounded to the cent."""
    if cancelled_on <= sub.period_start:
        return full_refund(sub)
    if cancelled_on >= sub.period_end:
        return Decimal("0.00")
    total_days = (sub.period_end - sub.period_start).days
    unused_days = (sub.period_end - cancelled_on).days
    amount = sub.plan_price * Decimal(unused_days) / Decimal(total_days)
    return amount.quantize(_CENT, rounding=ROUND_HALF_EVEN)
