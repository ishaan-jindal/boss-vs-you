"""Stub-mode tests: no keys, no network. Keys are cleared via fixture."""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

import bossfight.providers as providers
from bossfight import bosses
from bossfight.app import create_app
from bossfight.brain import BrainRequest, score_for, stub_decide
from bossfight.safety import is_taunt_clean


@pytest.fixture(autouse=True)
def keyless(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPINFRA_API_KEY", raising=False)


def req(**kw) -> BrainRequest:
    base = dict(
        boss_id="smoke-courier",
        tick=0,
        boss_hp_pct=100.0,
        player_hp_pct=100.0,
        player_style="mobile",
        current_tactic="",
        phase="normal",
        threats=[],
    )
    base.update(kw)
    return BrainRequest(**base)


def test_brain_contract_legal_accepted():
    out = stub_decide(req(tick=0))
    assert out.tactic_id in bosses.tactic_ids("smoke-courier")
    assert is_taunt_clean(out.taunt)


def test_illegal_tactic_never_500():
    client = TestClient(create_app())
    r = client.post("/api/brain", json=req(boss_id="nope").model_dump())
    assert r.status_code == 200
    body = r.json()
    assert body["tactic_id"] == "default"
    assert is_taunt_clean(body["taunt"])


def test_blocklist_catches_terms():
    assert not is_taunt_clean("I will kill you, ugly loser")
    assert not is_taunt_clean("send me a photo, what's your name?")
    assert is_taunt_clean("Nice footwork, hero — caught you napping!")


def test_overlength_rejected():
    assert not is_taunt_clean("x" * 141)
    assert is_taunt_clean("y" * 140)


def test_phase_field():
    assert bosses.phase_for(100) == "normal"
    assert bosses.phase_for(30) == "normal"
    assert bosses.phase_for(29.9) == "enrage"
    assert bosses.phase_for(5) == "enrage"


def test_stub_cycles_tactics():
    seen = {stub_decide(req(tick=t)).tactic_id for t in range(6)}
    assert len(seen) > 1, "stub stuck on one tactic"


def test_failover_order(monkeypatch):
    calls: list[str] = []

    async def fake_gemini(prompt):
        calls.append("gemini")
        raise RuntimeError("boom")

    async def fake_deep(prompt):
        calls.append("deepinfra")
        return providers.BrainFields(tactic_id="x", taunt="hi", intensity=0.5)

    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.setenv("DEEPINFRA_API_KEY", "d")
    monkeypatch.setattr(providers, "call_gemini", fake_gemini)
    monkeypatch.setattr(providers, "call_deepinfra", fake_deep)
    out = asyncio.run(providers.generate("hi"))
    assert calls == ["gemini", "deepinfra"]
    assert out.tactic_id == "x"


def test_semaphore_cap():
    assert providers.MAX_CONCURRENT == 3
    assert providers.SEMAPHORE._value == 3


def test_bosses_endpoint():
    client = TestClient(create_app())
    r = client.get("/api/bosses")
    assert r.status_code == 200
    data = r.json()["bosses"]
    assert len(data) == 3
    for b in data:
        for f in (
            "id",
            "name",
            "title",
            "hp",
            "move_speed",
            "colour",
            "glyph",
            "attacks",
            "tactics",
            "taunt_voice",
            "enrage",
        ):
            assert f in b, f"boss {b.get('id')} missing {f}"
        for a in b["attacks"]:
            for f in (
                "id",
                "damage",
                "telegraph_ms",
                "cooldown_s",
                "range_px",
                "pattern",
            ):
                assert f in a


def test_health_fast():
    client = TestClient(create_app())
    t0 = time.monotonic()
    r = client.get("/health")
    dt = time.monotonic() - t0
    assert r.status_code == 200 and r.json()["ok"] is True
    assert dt < 1.0


def test_score_formula():
    # base + time bonus + hp bonus, stated plainly.
    assert score_for("smoke-courier", 240, 0) == 1000
    assert score_for("smoke-courier", 120, 50) == 1000 + 600 + 500
    assert score_for("cinderjaw", 100, 80) == 1500 + 700 + 800
    assert score_for("briar-knight", 60, 100) == 2000 + 900 + 1000
    # slow fights get no time bonus, never negative
    assert score_for("cinderjaw", 999, 0) == 1500
