"""The one immortal boss: transform rules, form kits, roster shape."""

from __future__ import annotations

import asyncio
import random
from collections import Counter

import pytest
from fastapi.testclient import TestClient

import bossfight.brain as brain_mod
import bossfight.providers as providers
from bossfight import bosses
from bossfight.app import create_app
from bossfight.brain import BrainRequest


@pytest.fixture(autouse=True)
def keyless(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPINFRA_API_KEY", raising=False)


# --- can_transform: every rejection carries a reason ---


def test_same_form_rejected_with_reason():
    ok, reason = bosses.can_transform("crawler", "crawler", 99.0, 5, 0)
    assert ok is False
    assert reason


def test_second_mid_fight_rejected_with_reason():
    ok, reason = bosses.can_transform("crawler", "wraith", 99.0, 5, 1)
    assert ok is False
    assert reason


def test_low_descent_mid_fight_rejected_with_reason():
    for descent in (1, 2):
        ok, reason = bosses.can_transform("crawler", "wraith", 99.0, descent, 0)
        assert ok is False, f"descent {descent}"
        assert reason


def test_return_transform_allowed_at_low_descent():
    ok, reason = bosses.can_transform("crawler", "wraith", 99.0, 1, 0, mid_fight=False)
    assert ok is True
    assert reason


def test_normal_mid_fight_allowed():
    ok, reason = bosses.can_transform("crawler", "wraith", 99.0, 5, 0)
    assert ok is True
    assert reason


def test_illegal_form_rejected_with_reason():
    ok, reason = bosses.can_transform("crawler", "dragon", 99.0, 5, 0)
    assert ok is False
    assert reason


# --- transform_cost lockout ---


def test_transform_cost_small_and_respected():
    for descent in (1, 5, 10, 30):
        cost = bosses.transform_cost(descent)
        assert 1.0 <= cost <= 2.0, f"descent {descent}: {cost}"
    # Fresh off a transform the gate holds; long past it, it opens.
    ok, reason = bosses.can_transform("crawler", "wraith", 0.0, 5, 0)
    assert ok is False and reason
    ok, _ = bosses.can_transform("crawler", "wraith", 99.0, 5, 0)
    assert ok is True


# --- the four forms are learnably different ---


def test_each_form_has_signature_positive_tell_and_live_weights():
    tells = {}
    for form_id in bosses.FORMS:
        form = bosses.FORM_DEFS[form_id]
        assert form["signature"], form_id
        assert form["signature_tell"] > 0, form_id
        assert any(a["id"] == form["signature"] for a in form["attacks"]), form_id
        assert sum(form["weights"].values()) > 0, form_id
        tells[form_id] = form["signature_tell"]
    assert len(set(tells.values())) == 4, f"tells overlap: {tells}"


def test_signature_moves_are_distinct():
    sigs = {bosses.FORM_DEFS[f]["signature"] for f in bosses.FORMS}
    assert sigs == {"lunge", "blink", "slam", "feint"}


def test_weights_drive_different_fights():
    # Fixed RNG, many samples: a form whose weights are ignored draws the
    # same distribution as every other form. This catches that.
    dists = {}
    for form_id in bosses.FORMS:
        rng = random.Random(0)
        dists[form_id] = Counter(
            bosses.sample_attack(form_id, rng) for _ in range(2000)
        )
        # The signature is each form's most-drawn move.
        top = dists[form_id].most_common(1)[0][0]
        assert top == bosses.FORM_DEFS[form_id]["signature"], (form_id, top)
    ids = list(dists)
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            assert dists[ids[i]] != dists[ids[j]], (ids[i], ids[j])


# --- roster + rules endpoints ---


def test_roster_returns_legal_forms():
    client = TestClient(create_app())
    forms = client.get("/api/bosses").json()["forms"]
    assert [f["id"] for f in forms] == bosses.FORMS
    for f in forms:
        assert f["id"] in bosses.FORMS


def test_balance_carries_transform_rules():
    body = TestClient(create_app()).get("/api/balance").json()
    assert body["transform"]["min_descent_mid_fight"] == 3
    assert body["transform"]["max_mid_fight_per_fight"] == 1


# --- the model path is gated by the same rules ---


def _modelled(monkeypatch, fields):
    monkeypatch.setenv("GEMINI_API_KEY", "g")

    async def fake_generate(prompt: str):
        return fields

    monkeypatch.setattr(brain_mod, "generate", fake_generate)


def _fields(**kw):
    base = dict(
        tactics={"pressure": 0.5, "bait": 0.3, "bombs": 0.2},
        next_form="wraith",
        transform_now=True,
        taunt="You bled on my floor, hero. Bleed again.",
        read="you turtle; it will hold ground",
        intensity=0.7,
    )
    base.update(kw)
    return providers.BrainFields(**base)


def _req(**kw):
    base = dict(
        boss_id=bosses.BOSS_ID,
        seq=0,
        descent=5,
        form="crawler",
        boss_hp_pct=100.0,
        player_hp_pct=100.0,
    )
    base.update(kw)
    return BrainRequest(**base)


def test_model_morph_gated_by_count(monkeypatch):
    _modelled(monkeypatch, _fields())
    out = asyncio.run(
        brain_mod.decide(_req(transforms_this_fight=1, secs_since_transform=99.0))
    )
    assert out.transform_now is False
    assert out.next_form == "wraith"  # body kept for the return window


def test_model_morph_gated_by_lockout(monkeypatch):
    _modelled(monkeypatch, _fields())
    out = asyncio.run(
        brain_mod.decide(_req(transforms_this_fight=0, secs_since_transform=0.0))
    )
    assert out.transform_now is False
