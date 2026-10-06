"""Jev fast-brain tests: mocked HTTP, no network. Mirrors test_brain::_modelled."""

from __future__ import annotations

import asyncio

import pytest

import bossfight.brain as brain_mod
import bossfight.jev as jev_mod
from bossfight import bosses
from bossfight.brain import BrainRequest, decide
from bossfight.safety import is_taunt_clean


@pytest.fixture(autouse=True)
def jev_only(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "t")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPINFRA_API_KEY", raising=False)
    brain_mod._PROSE_CACHE.clear()


def req(**kw) -> BrainRequest:
    base = dict(
        boss_id=bosses.BOSS_ID,
        seq=1,
        descent=5,
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


def _answers(**kw) -> dict:
    base = {
        "tactic": {
            "probabilities": {"pressure": 0.5, "bait": 0.3, "bombs": 0.2},
            "confidence": 0.9,
        },
        "next_form": {"choice": "wraith", "confidence": 0.9},
        "transform_now": {"value": 0.8},
        "intensity": {"score": 1.0},
        "spawn_call": {"value": 0.8},
    }
    base.update(kw)
    return base


def _modelled_jev(monkeypatch, answers=None, status: int = 200):
    """Route decide() at the Jev path with a scripted _post()."""
    calls: list[dict] = []

    async def fake_post(url: str, headers: dict, body: dict):
        calls.append({"url": url, "headers": headers, "body": body})
        assert "TYPESAFE" not in str(body), "key must not ride in body"
        assert body.get("model") == "jev-latest"
        assert set(body.get("questions", {})) == {
            "tactic",
            "next_form",
            "transform_now",
            "intensity",
            "spawn_call",
        }
        import httpx

        payload = {} if answers is None else {"answers": answers}
        return httpx.Response(
            status,
            json=payload,
            request=httpx.Request("POST", "http://test/"),
        )

    monkeypatch.setattr(jev_mod, "_post", fake_post)
    return calls


def test_build_state_keys():
    r = req(
        habits={"aggression": 0.7},
        build=["Edge"],
        history=["a", "b", "c", "d", "e"],
        last_damage_source="slam",
        minions_alive=2,
    )
    s = jev_mod.build_state(r)
    assert s["boss"]["id"] == bosses.BOSS_ID
    assert s["boss"]["name"] and s["boss"]["title"] and s["boss"]["voice"]
    assert s["form"]["id"] == "crawler"
    assert s["form"]["identity"] and s["form"]["signature"]
    assert s["descent"] == 5 and s["fight_secs"] == 0.0
    assert s["boss_hp_pct"] == 100.0 and s["player_hp_pct"] == 100.0
    assert s["habits"] == {"aggression": 0.7}
    assert s["build"] == ["Edge"]
    assert s["history"] == ["b", "c", "d", "e"]
    assert s["last_damage_source"] == "slam"
    assert s["transforms"]["transforms_this_fight"] == 0
    assert s["minions_alive"] == 2
    assert s["safety_rules"]


def test_questions_shape():
    assert set(jev_mod.QUESTIONS) == {
        "tactic",
        "next_form",
        "transform_now",
        "intensity",
        "spawn_call",
    }
    assert set(jev_mod.QUESTIONS["tactic"]["criteria"]) == {
        "pressure",
        "bait",
        "bombs",
    }
    assert set(jev_mod.QUESTIONS["next_form"]["criteria"]) == set(bosses.FORMS)
    for q in jev_mod.QUESTIONS.values():
        assert q["instructions"] and q["type"] in ("choice", "noul", "score")


def test_answers_map_to_fields(monkeypatch):
    _modelled_jev(monkeypatch, _answers())
    out = asyncio.run(jev_mod.jev_fields(req()))
    assert out.tactics == {"pressure": 0.5, "bait": 0.3, "bombs": 0.2}
    assert out.next_form == "wraith"
    assert out.transform_now is True
    assert out.intensity == pytest.approx(0.5)
    assert out.spawn_call is True
    assert is_taunt_clean(out.taunt)


def test_low_confidence_form_keeps_current(monkeypatch):
    _modelled_jev(
        monkeypatch,
        _answers(next_form={"choice": "colossus", "confidence": 0.2}),
    )
    out = asyncio.run(jev_mod.jev_fields(req(form="wraith")))
    assert out.next_form == "wraith"


def test_transform_gated_by_legal_path(monkeypatch):
    # Same Jev reply: legal morph passes at descent 5, held at descent 1 —
    # the server-side can_transform gate in brain._respond.
    _modelled_jev(monkeypatch, _answers())
    hi = asyncio.run(decide(req(descent=5)))
    assert hi.brain is True
    assert hi.transform_now is True
    assert hi.next_form == "wraith"
    lo = asyncio.run(decide(req(descent=1)))
    assert lo.transform_now is False
    assert lo.next_form == "wraith"


def test_illegal_form_falls_back_to_stub(monkeypatch):
    _modelled_jev(monkeypatch, _answers(next_form={"choice": "dragon"}))
    out = asyncio.run(decide(req()))
    assert out.brain is False
    assert out.next_form in bosses.FORMS


def test_missing_answer_falls_back_to_stub(monkeypatch):
    bad = _answers()
    del bad["tactic"]
    _modelled_jev(monkeypatch, bad)
    with pytest.raises(RuntimeError):
        asyncio.run(jev_mod.jev_fields(req()))
    out = asyncio.run(decide(req()))
    assert out.brain is False
    assert out.tactics and all(v >= 0 for v in out.tactics.values())


def test_empty_answers_fall_back_to_stub(monkeypatch):
    _modelled_jev(monkeypatch, {})
    with pytest.raises(RuntimeError):
        asyncio.run(jev_mod.jev_fields(req()))
    out = asyncio.run(decide(req()))
    assert out.brain is False


def test_http_error_falls_back_to_stub(monkeypatch):
    _modelled_jev(monkeypatch, _answers(), status=422)
    with pytest.raises(RuntimeError):
        asyncio.run(jev_mod.jev_fields(req()))
    out = asyncio.run(decide(req()))
    assert out.brain is False


def test_no_key_raises(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        asyncio.run(jev_mod.jev_fields(req()))


def test_live_answer_shapes_parse(monkeypatch):
    # Exact shapes returned by the live API 2026-10-06 (choice carries
    # probabilities+confidence, noul answers under the "noul" key).
    _modelled_jev(
        monkeypatch,
        {
            "tactic": {
                "type": "choice",
                "choice": "pressure",
                "probabilities": {"pressure": 0.79, "bait": 0.19, "bombs": 0.02},
            },
            "next_form": {
                "type": "choice",
                "choice": "crawler",
                "confidence": 0.37,
                "probabilities": {"crawler": 0.52},
            },
            "transform_now": {"type": "noul", "noul": 0.3},
            "intensity": {"type": "score", "score": 0.13, "confidence": 0.81},
            "spawn_call": {"type": "noul", "noul": 0.3},
        },
    )
    out = asyncio.run(jev_mod.jev_fields(req(form="crawler")))
    assert out.tactics["pressure"] == pytest.approx(0.79)
    assert out.transform_now is False
    assert out.spawn_call is False
    assert out.intensity == pytest.approx(0.065)


def test_strategy_assessment_reaches_state(monkeypatch, caplog):
    bodies = _modelled_jev(monkeypatch, _answers())
    brain_mod._PROSE_CACHE[bosses.BOSS_ID] = {"taunt": "T", "read": "you turtle"}
    with caplog.at_level("INFO", logger="bossfight.brain"):
        out = asyncio.run(decide(req(seq=5)))
    assert out.brain is True
    assert bodies[0]["body"]["state"]["strategy_assessment"] == "you turtle"
    assert "jev: tactics=" in caplog.text


def test_strategy_falls_back_without_cache(monkeypatch):
    bodies = _modelled_jev(monkeypatch, _answers())
    out = asyncio.run(decide(req(seq=5, history=[])))
    assert out.brain is True
    sent = bodies[0]["body"]["state"]
    assert isinstance(sent.get("strategy_assessment", ""), str)


def test_build_state_omits_empty_strategy():
    assert "strategy_assessment" not in jev_mod.build_state(req())
    s = jev_mod.build_state(req(), strategy="you rush")
    assert s["strategy_assessment"] == "you rush"
