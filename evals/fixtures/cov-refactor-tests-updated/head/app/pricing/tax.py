"""VAT for the regions we sell in."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

_CENT = Decimal("0.01")


@dataclass(frozen=True)
class TaxRule:
    region: str
    rate: Decimal


_RULES: dict[str, TaxRule] = {
    rule.region: rule
    for rule in (
        TaxRule("DE", Decimal("0.19")),
        TaxRule("FR", Decimal("0.20")),
        TaxRule("NL", Decimal("0.21")),
        TaxRule("GB", Decimal("0.20")),
    )
}


def rule_for(region: str) -> TaxRule:
    """The VAT rule for an ISO 3166-1 alpha-2 region code."""
    try:
        return _RULES[region]
    except KeyError:
        raise ValueError(f"no tax rule for region {region!r}") from None


def tax_for(region: str, amount: Decimal) -> Decimal:
    return (amount * rule_for(region).rate).quantize(_CENT, rounding=ROUND_HALF_UP)
