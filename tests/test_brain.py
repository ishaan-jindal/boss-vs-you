"""Stub-mode tests: no keys, no network. Keys are cleared via fixture."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

import bossfight.brain as brain_mod
import bossfight.providers as providers
from bossfight import bosses
from bossfight.app import create_app
from bossfight.brain import BrainRequest, decide, score_for, stub_decide
from bossfight.safety import is_taunt_clean


@pytest.fixture(autouse=True)
def keyless(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPINFRA_API_KEY", raising=False)


def req(**kw) -> BrainRequest:
    base = dict(
        boss_id=bosses.BOSS_ID,
        seq=0,
        descent=1,
        form="crawler",
        boss_hp_pct=100.0,
        player_hp_pct=100.0,
        habits={},
        build=[],
        fight_secs=0.0,
        last_damage_source="",
        history=[],
    )
    base.update(kw)
    return BrainRequest(**base)


def test_brain_contract_full_shape():
    out = stub_decide(req(seq=7))
    assert out.seq == 7
    assert out.tactics and all(v >= 0 for v in out.tactics.values())
    assert out.next_form in bosses.FORMS
    assert is_taunt_clean(out.taunt) and len(out.taunt) <= 140
    assert len(out.read) <= 200
    assert isinstance(out.transform_now, bool)


def test_seq_echoed_through_endpoint():
    client = TestClient(create_app())
    r = client.post("/api/brain", json=req(seq=41).model_dump())
    assert r.status_code == 200
    assert r.json()["seq"] == 41


def test_habits_payload_no_422():
    # Regression: the old player_style enum 422d any habit-rich payload.
    client = TestClient(create_app())
    payload = req(
        habits={"turtle_ratio": 0.9, "dash_spam": 0.7, "stationary_ratio": 0.4},
        build=["Edge", "Vigour"],
        history=["turtled behind guard", "dashed into lunge"],
    ).model_dump()
    r = client.post("/api/brain", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["tactics"] and body["next_form"] in bosses.FORMS


def test_stub_turtle_vs_aggro_differ():
    turtle = stub_decide(req(habits={"turtle_ratio": 0.9}))
    aggro = stub_decide(req(habits={"aggression": 0.9}))
    assert turtle.tactics != aggro.tactics
    assert turtle.next_form != aggro.next_form
    assert turtle.read != aggro.read
    assert turtle.next_form == "wraith"
    assert aggro.next_form == "colossus"


def test_stub_transform_now_only_when_bleeding():
    assert stub_decide(req(habits={"turtle_ratio": 0.9})).transform_now is False
    out = stub_decide(req(habits={"turtle_ratio": 0.9}, boss_hp_pct=20.0, descent=5))
    assert out.transform_now is True
    # Same bleed at descent 1: server-side rule holds the morph for return.
    low = stub_decide(req(habits={"turtle_ratio": 0.9}, boss_hp_pct=20.0, descent=1))
    assert low.transform_now is False
    assert low.next_form == "wraith"  # the body is kept, only the timing is held


def _modelled(monkeypatch, fields=None, error=None):
    """Route decide() at the model path with a scripted generate()."""
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    calls: list[str] = []

    async def fake_generate(prompt: str):
        calls.append(prompt)
        if error is not None and len(calls) == 1:
            raise RuntimeError(error)
        return fields

    monkeypatch.setattr(brain_mod, "generate", fake_generate)
    return calls


def _fields(**kw):
    base = dict(
        tactics={"pressure": 0.5, "bait": 0.3, "bombs": 0.2},
        next_form="wraith",
        transform_now=True,
        open_with="shadow-lunge",
        taunt="You bled on my floor, hero. Bleed again.",
        read="you trade hits; it will armour up",
        intensity=0.7,
    )
    base.update(kw)
    return providers.BrainFields(**base)


def test_illegal_form_falls_back(monkeypatch):
    _modelled(monkeypatch, _fields(next_form="dragon"))
    out = asyncio.run(decide(req()))
    assert out.next_form in bosses.FORMS
    assert out.tactics and all(v >= 0 for v in out.tactics.values())


def test_empty_weights_fall_back(monkeypatch):
    _modelled(monkeypatch, _fields(tactics={}))
    out = asyncio.run(decide(req()))
    assert out.tactics and all(v >= 0 for v in out.tactics.values())


def test_negative_weights_fall_back(monkeypatch):
    _modelled(monkeypatch, _fields(tactics={"pressure": -1.0}))
    out = asyncio.run(decide(req()))
    assert all(v >= 0 for v in out.tactics.values())


def test_transform_now_passes_through(monkeypatch):
    # Server gates shape/legality (same-form, low-descent, lockout); a legal
    # morph passes through, the CLIENT enforces the per-fight count.
    _modelled(monkeypatch, _fields(transform_now=True))
    out = asyncio.run(decide(req(descent=5)))
    assert out.transform_now is True
    assert out.open_with == "shadow-lunge"
    assert out.seq == 0


def test_transform_now_gated_at_low_descent(monkeypatch):
    # Same model reply, descent 1: morph held for the return window.
    _modelled(monkeypatch, _fields(transform_now=True))
    out = asyncio.run(decide(req(descent=1)))
    assert out.transform_now is False
    assert out.next_form == "wraith"


def test_retry_once_then_model_win(monkeypatch):
    calls = _modelled(monkeypatch, _fields(next_form="hollow"), error="boom")
    out = asyncio.run(decide(req(seq=3)))
    assert out.next_form == "hollow"
    assert out.seq == 3
    assert len(calls) == 2


def test_model_taunt_blocked_falls_back(monkeypatch):
    _modelled(monkeypatch, _fields(taunt="you ugly loser, send a photo"))
    out = asyncio.run(decide(req()))
    assert is_taunt_clean(out.taunt)


def test_unknown_boss_never_500():
    client = TestClient(create_app())
    r = client.post("/api/brain", json=req(boss_id="nope", seq=9).model_dump())
    assert r.status_code == 200
    body = r.json()
    assert body["seq"] == 9
    assert body["tactics"] and body["next_form"] in bosses.FORMS
    assert is_taunt_clean(body["taunt"])


def test_blocklist_catches_terms():
    assert not is_taunt_clean("I will kill you, ugly loser")
    assert not is_taunt_clean("send me a photo, what's your name?")
    assert is_taunt_clean("Nice footwork, hero — caught you napping!")


def test_gore_permitted_insults_not():
    # In-fiction combat language is allowed; the person-directed/sexual/
    # outside-the-game terms are still blocked.
    assert is_taunt_clean("The floor drinks your blood, hero. Rise and bleed again.")
    assert is_taunt_clean("You died well. The dark keeps you.")
    assert not is_taunt_clean("you ugly idiot, kiss me")
    assert not is_taunt_clean("kill yourself, hero")
    assert not is_taunt_clean("tell me where do you live")


def test_overlength_rejected():
    assert not is_taunt_clean("x" * 141)
    assert is_taunt_clean("y" * 140)


def test_read_length_validated():
    with pytest.raises(Exception):
        providers.BrainFields(
            tactics={"pressure": 1.0},
            next_form="crawler",
            taunt="hi",
            read="z" * 201,
        )


def test_parse_tolerates_fences():
    raw = (
        '```json\n{"tactics": {"pressure": 0.6, "bait": 0.3, "bombs": 0.1}, '
        '"next_form": "wraith", "taunt": "hi", "read": "turtles"}\n```'
    )
    out = providers.parse_fields(raw)
    assert out.next_form == "wraith"
    assert out.tactics["pressure"] == 0.6


def test_phase_field():
    assert bosses.phase_for(100) == "normal"
    assert bosses.phase_for(30) == "normal"
    assert bosses.phase_for(29.9) == "enrage"
    assert bosses.phase_for(5) == "enrage"


def test_legal_forms():
    assert bosses.FORMS == ["crawler", "wraith", "colossus", "hollow"]
    assert bosses.legal_form("wraith")
    assert not bosses.legal_form("dragon")


def test_failover_order(monkeypatch):
    calls: list[str] = []

    async def fake_gemini(prompt):
        calls.append("gemini")
        raise RuntimeError("boom")

    async def fake_deep(prompt):
        calls.append("deepinfra")
        return _fields()

    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.setenv("DEEPINFRA_API_KEY", "d")
    monkeypatch.setattr(providers, "call_gemini", fake_gemini)
    monkeypatch.setattr(providers, "call_deepinfra", fake_deep)
    out = asyncio.run(providers.generate("hi"))
    assert calls == ["gemini", "deepinfra"]
    assert out.next_form == "wraith"


def test_semaphore_cap():
    assert providers.MAX_CONCURRENT == 3
    assert providers.SEMAPHORE._value == 3


def test_bosses_endpoint():
    client = TestClient(create_app())
    r = client.get("/api/bosses")
    assert r.status_code == 200
    data = r.json()
    # One immortal entity; the legal form list rides along.
    assert len(data["bosses"]) == 1
    assert data["boss"]["id"] == bosses.BOSS_ID
    assert [f["id"] for f in data["forms"]] == bosses.FORMS
    for f in data["forms"]:
        assert f["id"] in bosses.FORMS
        for key in ("name", "signature", "attacks", "weights", "visual"):
            assert key in f, f"form {f.get('id')} missing {key}"
        for a in f["attacks"]:
            for key in (
                "id",
                "damage",
                "telegraph_ms",
                "cooldown_s",
                "range_px",
                "pattern",
            ):
                assert key in a


def test_health_fast():
    import time

    client = TestClient(create_app())
    t0 = time.monotonic()
    r = client.get("/health")
    dt = time.monotonic() - t0
    assert r.status_code == 200 and r.json()["ok"] is True
    assert dt < 1.0


def test_score_formula():
    # base + time bonus + hp bonus, stated plainly. One boss, one base.
    assert score_for(bosses.BOSS_ID, 240, 0) == 1500
    assert score_for(bosses.BOSS_ID, 120, 50) == 1500 + 600 + 500
    assert score_for(bosses.BOSS_ID, 100, 80) == 1500 + 700 + 800
    # slow fights get no time bonus, never negative; unknown ids floor at 1000
    assert score_for(bosses.BOSS_ID, 999, 0) == 1500
    assert score_for("nope", 999, 0) == 1000
