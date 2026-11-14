from decimal import Decimal

import pytest

from app.pricing.tax import TaxRule, rule_for, tax_for


@pytest.mark.parametrize(
    ("region", "expected"),
    [
        ("DE", Decimal("19.00")),
        ("FR", Decimal("20.00")),
        ("NL", Decimal("21.00")),
        ("GB", Decimal("20.00")),
    ],
)
def test_tax_for_each_region(region: str, expected: Decimal):
    assert tax_for(region, Decimal("100.00")) == expected


def test_tax_rounds_half_up_to_the_cent():
    # 0.50 * 0.21 = 0.105: half-up gives 0.11 (banker's rounding would give 0.10)
    assert tax_for("NL", Decimal("0.50")) == Decimal("0.11")


def test_rule_for_returns_the_region_rule():
    assert rule_for("NL") == TaxRule("NL", Decimal("0.21"))


def test_unknown_region_is_rejected():
    with pytest.raises(ValueError, match="no tax rule for region 'US'"):
        tax_for("US", Decimal("10.00"))
