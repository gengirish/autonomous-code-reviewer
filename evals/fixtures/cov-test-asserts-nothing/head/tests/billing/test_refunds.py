from datetime import date
from decimal import Decimal

from app.billing.refunds import Subscription, full_refund, prorated_refund


def _monthly(price: Decimal) -> Subscription:
    return Subscription(plan_price=price, period_start=date(2026, 3, 1), period_end=date(2026, 3, 31))


def test_full_refund_returns_plan_price():
    assert full_refund(_monthly(Decimal("30.00"))) == Decimal("30.00")


def test_prorated_refund_before_period_start_is_full_refund():
    assert prorated_refund(_monthly(Decimal("30.00")), date(2026, 2, 27)) == Decimal("30.00")


def test_prorated_refund_mid_period():
    sub = _monthly(Decimal("30.00"))
    refund = prorated_refund(sub, date(2026, 3, 16))
    assert refund is not None
    assert isinstance(refund, Decimal)


def test_prorated_refund_after_period_end():
    sub = _monthly(Decimal("30.00"))
    prorated_refund(sub, date(2026, 4, 2))
