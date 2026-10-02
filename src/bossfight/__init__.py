"""Boss vs You — deterministic local reflexes, model brain."""

from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv() -> None:
    """Tiny stdlib .env loader: reads repo-root .env, never overwrites real env."""
    try:
        root = Path(__file__).resolve().parents[2] / ".env"
    except IndexError:
        return
    if not root.is_file():
        return
    for raw in root.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip("'\"")
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv()

__all__ = ["_load_dotenv"]
