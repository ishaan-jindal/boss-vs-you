"""Jev fast structure brain (TypeSafe SystemOne).

Live docs: POST https://api.typesafe.ai/v1/systemone with
{state, model: "jev-latest", questions: {id: Question}},
Bearer TYPESAFE_API_KEY. Answers carry choice/noul/score with
probabilities/confidence. Errors 401/422/429/529.

Raw httpx, no new dependency. Reuses providers.SEMAPHORE, 2.5s timeout,
never logs keys.
"""

from __future__ import annotations

import os

import httpx

from . import bosses
from .providers import SEMAPHORE, BrainFields
from .safety import SAFETY_RULES

JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = "jev-latest"
JEV_TIMEOUT = 2.5

# Module-level questions: Jev answers structure, Gemma answers prose.
# Shapes per TypeSafe docs: Choice needs instructions + criteria map,
# Noul instructions + true/false criteria, Score instructions + level list.
QUESTIONS: dict = {
    "tactic": {
        "type": "choice",
        "instructions": (
            "Against this hero's habits, which tactic should dominate? "
            "pressure closes distance and punishes idle spacing; bait holds "
            "ground and punishes the dash and the guard; bombs zone a hero "
            "who runs with ranged area denial."
        ),
        "criteria": {
            "pressure": "trade up close and punish idle spacing",
            "bait": "punish dashes and guard pulls, hold ground",
            "bombs": "zone a runner with ranged denial",
        },
    },
    "next_form": {
        "type": "choice",
        "instructions": (
            "Which body should it wear next to punish what it has learned "
            "about the hero?"
        ),
        "criteria": {f: bosses.FORM_DEFS[f].get("identity", f) for f in bosses.FORMS},
    },
    "transform_now": {
        "type": "noul",
        "instructions": (
            "Should it take the new body immediately, mid-fight, to punish "
            "something it just saw?"
        ),
        "criteria": {
            "true": "a just-observed punishable pattern",
            "false": "hold the morph for the return window",
        },
    },
    "intensity": {
        "type": "score",
        "instructions": "How furious is this fight right now?",
        "criteria": ["cold", "pressing", "enraged"],
    },
    "spawn_call": {
        "type": "noul",
        "instructions": "Should the room summon another add now?",
        "criteria": {
            "true": "thin room, the hero has breathing room",
            "false": "the live adds already pressure enough",
        },
    },
}

# Stub prose defaults — prose is Gemma's job, Jev only does structure.
_JEV_TAUNT = "Come down, hero. The stone remembers every step."


class TypeSafeError(RuntimeError):
    """TypeSafe transport/validation failure (status kept, key never kept)."""


def has_key() -> bool:
    return bool(os.environ.get("TYPESAFE_API_KEY"))


def build_state(req, strategy: str = "") -> dict:
    """Full fight snapshot Jev reasons over (client already sends it each tick).

    strategy is Gemma's latest playstyle read (or the deterministic fallback
    read): the slow strategic assessment the fast tactical questions
    condition on. Omitted when empty.
    """
    b = bosses.get_boss(req.boss_id) or {}
    form = bosses.FORM_DEFS.get(req.form, {})
    state = {
        "boss": {
            "id": req.boss_id,
            "name": b.get("name", ""),
            "title": b.get("title", ""),
            "voice": b.get("taunt_voice", []),
        },
        "form": {
            "id": req.form,
            "identity": form.get("identity", ""),
            "signature": form.get("signature", ""),
        },
        "descent": req.descent,
        "fight_secs": req.fight_secs,
        "boss_hp_pct": req.boss_hp_pct,
        "player_hp_pct": req.player_hp_pct,
        "habits": dict(req.habits or {}),
        "build": list(req.build or []),
        "history": list((req.history or [])[-4:]),
        "last_damage_source": req.last_damage_source or "",
        "transforms": {
            "transforms_this_fight": req.transforms_this_fight,
            "secs_since_transform": req.secs_since_transform,
        },
        "minions_alive": req.minions_alive,
        "safety_rules": SAFETY_RULES,
    }
    if strategy:
        state["strategy_assessment"] = strategy
    return state


async def _post(url: str, headers: dict, body: dict) -> httpx.Response:
    async with SEMAPHORE:
        async with httpx.AsyncClient(timeout=JEV_TIMEOUT) as client:
            return await client.post(url, headers=headers, json=body)


def _probs(ans: dict) -> dict:
    p = ans.get("probabilities", ans.get("probs", ans.get("weights", {})))
    if not isinstance(p, dict) or not p:
        raise TypeSafeError("empty tactic probabilities")
    out: dict[str, float] = {}
    for k, v in p.items():
        try:
            out[str(k)] = float(v)
        except (TypeError, ValueError):
            raise TypeSafeError("non-numeric tactic probability") from None
    if not out:
        raise TypeSafeError("empty tactic probabilities")
    return out


def _choice(ans: dict) -> tuple[str, float]:
    for k in ("choice", "value", "label", "option"):
        v = ans.get(k)
        if isinstance(v, str) and v:
            try:
                conf = float(ans.get("confidence", 1.0))
            except (TypeError, ValueError):
                conf = 1.0
            return v, conf
    raise TypeSafeError("missing choice answer")


def _noul(ans: dict) -> float:
    for k in ("noul", "value", "p", "probability", "score", "confidence"):
        v = ans.get(k)
        if isinstance(v, bool):
            return 1.0 if v else 0.0
        if isinstance(v, (int, float)):
            return float(v)
    c = ans.get("choice")
    if isinstance(c, str):
        return 1.0 if c.lower() in ("now", "yes", "true", "spawn") else 0.0
    raise TypeSafeError("missing noul answer")


def _score(ans: dict) -> float:
    for k in ("score", "value", "rank"):
        v = ans.get(k)
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)):
            return float(v)
    c = ans.get("choice", ans.get("label", ""))
    if isinstance(c, str) and c in ("cold", "pressing", "enraged"):
        return float(("cold", "pressing", "enraged").index(c))
    raise TypeSafeError("missing score answer")


async def jev_fields(req, strategy: str = "") -> BrainFields:
    """Structural fields from Jev. Any failure raises RuntimeError (-> stub)."""
    if not has_key():
        raise RuntimeError("no TYPESAFE_API_KEY")
    try:
        key = os.environ.get("TYPESAFE_API_KEY", "")
        body = {
            "state": build_state(req, strategy=strategy),
            "model": JEV_MODEL,
            "questions": QUESTIONS,
        }
        # Key goes on the wire only; errors below report status/type only.
        resp = await _post(JEV_URL, {"Authorization": f"Bearer {key}"}, body)
        resp.raise_for_status()
        data = resp.json()
        answers = data.get("answers", data.get("results", {}))
        if not isinstance(answers, dict) or not answers:
            raise TypeSafeError("empty answers")
        for q in ("tactic", "next_form", "transform_now", "intensity", "spawn_call"):
            if q not in answers or not isinstance(answers[q], dict):
                raise TypeSafeError(f"missing answer: {q}")

        tactics = _probs(answers["tactic"])
        choice, conf = _choice(answers["next_form"])
        next_form = req.form if conf < 0.4 else choice
        if not next_form or not isinstance(next_form, str):
            raise TypeSafeError("missing next_form choice")
        transform_now = _noul(answers["transform_now"]) >= 0.5
        intensity = max(0.0, min(1.0, _score(answers["intensity"]) / 2.0))
        spawn_call = _noul(answers["spawn_call"]) >= 0.5
        return BrainFields(
            tactics=tactics,
            next_form=next_form,
            transform_now=transform_now,
            taunt=_JEV_TAUNT,
            read="",
            intensity=intensity,
            spawn_call=spawn_call,
        )
    except TypeSafeError as exc:
        raise RuntimeError(str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — caller falls through to stub
        if isinstance(exc, RuntimeError) and str(exc):
            raise
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status is not None:
            raise RuntimeError(f"typesafe status={status}") from exc
        raise RuntimeError(f"typesafe: {type(exc).__name__}") from exc
