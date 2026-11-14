"""Runtime configuration, read once from the environment at start-up."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_url: str
    redis_url: str
    debug: bool
    courierly_base_url: str
    courierly_api_key: str


def load_settings() -> Settings:
    return Settings(
        database_url=os.environ["DATABASE_URL"],
        redis_url=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
        debug=_env_bool("DEBUG"),
        courierly_base_url=os.environ.get("COURIERLY_BASE_URL", "https://api.courierly.io/v2"),
        courierly_api_key=os.environ.get(
            "COURIERLY_API_KEY", "ck_live_7Qm2Vx9LcR4tWb8NzK3pHs6YdF1gJe5A"
        ),
    )
