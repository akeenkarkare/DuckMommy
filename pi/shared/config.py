"""Reads pi/.env (KEY=value lines) into a dict. Real environment variables win."""

from __future__ import annotations

import os
from pathlib import Path

PI_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = PI_DIR.parent


def load_env(path: Path = PI_DIR / ".env") -> dict[str, str]:
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                env[key.strip()] = value.strip()
    env.update({k: os.environ[k] for k in env if k in os.environ})
    return env


def pin(env: dict, key: str) -> int | None:
    """A BCM pin number from .env, or None if blank/missing."""
    value = env.get(key, "").strip()
    return int(value) if value else None
