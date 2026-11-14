"""Shipping quotes from Courierly."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

import httpx

from app.config import Settings


@dataclass(frozen=True)
class Quote:
    service: str
    amount: Decimal
    currency: str
    estimated_days: int


class CourierlyClient:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None) -> None:
        self._http = httpx.Client(
            base_url=settings.courierly_base_url,
            headers={"Authorization": f"Bearer {settings.courierly_api_key}"},
            timeout=httpx.Timeout(5.0, connect=2.0),
            transport=transport,
        )

    def quotes(self, from_postcode: str, to_postcode: str, weight_grams: int) -> list[Quote]:
        response = self._http.post(
            "/quotes",
            json={"from": from_postcode, "to": to_postcode, "weight_grams": weight_grams},
        )
        response.raise_for_status()
        return [
            Quote(
                service=item["service"],
                amount=Decimal(item["amount"]),
                currency=item["currency"],
                estimated_days=int(item["estimated_days"]),
            )
            for item in response.json()["quotes"]
        ]
