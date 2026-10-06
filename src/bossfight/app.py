"""FastAPI app: nearly stateless — serves boss configs + brain endpoint."""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import bosses
from .balance import balance_summary
from .brain import BrainRequest, BrainResponse, decide, stub_decide

STATIC_DIR = Path(
    os.environ.get("STATIC_DIR") or (Path(__file__).resolve().parents[2] / "static")
)


def create_app() -> FastAPI:
    # Our module loggers (bossfight.*) propagate to root, which defaults to
    # WARNING: without a handler/level here, INFO lines (gemini raw, jev
    # picks) never reach the terminal. LOG_LEVEL overrides, default INFO.
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
    app = FastAPI(title="Boss vs You")
    started = time.monotonic()

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "uptime_s": round(time.monotonic() - started, 3)}

    @app.get("/api/bosses")
    async def list_bosses() -> dict:
        # One immortal entity; the legal form list rides along so the client
        # never hardcodes bodies. "bosses" stays as a one-item alias.
        return {
            "bosses": bosses.BOSSES,
            "boss": bosses.BOSS,
            "forms": [bosses.FORM_DEFS[f] for f in bosses.FORMS],
        }

    @app.get("/api/balance")
    async def balance() -> dict:
        # One source of truth: constants from balance.py, bodies + transform
        # rules from bosses. No new endpoint for the rules — this payload.
        return {
            **balance_summary(),
            "forms": list(bosses.FORMS),
            "transform": dict(bosses.TRANSFORM_RULES),
        }

    @app.post("/api/brain", response_model=BrainResponse)
    async def brain(req: BrainRequest) -> BrainResponse:
        # Unknown boss → rule-based fallback shape, never 500.
        if bosses.get_boss(req.boss_id) is None:
            return stub_decide(req)
        return await decide(req)

    # Static game client (procedural pixel Canvas, zero deps beyond our API).
    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(str(STATIC_DIR / "index.html"))

    return app


app = create_app()
