from decimal import Decimal

import httpx

from app.config import Settings
from app.shipping.rates import CourierlyClient, Quote


def _settings() -> Settings:
    return Settings(
        database_url="postgresql://localhost/test",
        redis_url="redis://localhost:6379/0",
        debug=False,
        courierly_base_url="https://courierly.test/v2",
        courierly_api_key="test-key",
    )


def test_quotes_are_parsed_into_decimal_amounts():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer test-key"
        return httpx.Response(
            200,
            json={"quotes": [{"service": "standard", "amount": "4.95", "currency": "EUR", "estimated_days": 3}]},
        )

    client = CourierlyClient(_settings(), transport=httpx.MockTransport(handler))

    assert client.quotes("10115", "80331", 1200) == [Quote("standard", Decimal("4.95"), "EUR", 3)]
