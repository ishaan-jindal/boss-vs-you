"""FastAPI app: nearly stateless — serves boss configs + brain endpoint."""

from __future__ import annotations

import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import bosses
from .brain import BrainRequest, BrainResponse, decide

STATIC_DIR = Path(__file__).resolve().parents[2] / "static"


def create_app() -> FastAPI:
    app = FastAPI(title="Boss vs You")
    started = time.monotonic()

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "uptime_s": round(time.monotonic() - started, 3)}

    @app.get("/api/bosses")
    async def list_bosses() -> dict:
        return {"bosses": bosses.BOSSES}

    @app.post("/api/brain", response_model=BrainResponse)
    async def brain(req: BrainRequest) -> BrainResponse:
        # Unknown boss → rule-based fallback shape, never 500.
        if bosses.get_boss(req.boss_id) is None:
            return BrainResponse(
                tactic_id="default",
                taunt="En garde, hero — show me your footwork!",
                intensity=0.5,
            )
        return await decide(req)

    # Static game client (vendored Phaser, zero runtime deps beyond our API).
    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(str(STATIC_DIR / "index.html"))

    return app


app = create_app()
