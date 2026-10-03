"""The brain: reads the hero's habits, returns tactic weights + the next body.

Client sends full state each call (stateless server). Sequence guard: seq is
echoed verbatim and the client applies a reply only if newer. Validation
failures → retry once → rule-based fallback. Never a 500 from a bad model.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from . import bosses
from .providers import generate, stubbed
from .safety import MAX_READ_LEN, MAX_TAUNT_LEN, SAFETY_RULES, is_taunt_clean


class BrainRequest(BaseModel):
    boss_id: str
    seq: int = 0  # monotonic; echoed back unchanged
    descent: int = 1
    form: str = "crawler"
    boss_hp_pct: float = 100.0
    player_hp_pct: float = 100.0
    habits: dict[str, float] = Field(default_factory=dict)
    build: list[str] = Field(default_factory=list)
    fight_secs: float = 0.0
    last_damage_source: str = ""
    history: list[str] = Field(default_factory=list)


class BrainResponse(BaseModel):
    seq: int
    tactics: dict[str, float]  # weights, non-empty, values >= 0
    next_form: str  # one of bosses.FORMS
    transform_now: bool = False
    open_with: str = ""  # attack id or tactic id, may be ""
    taunt: str  # <= 140 chars, blocklist-checked
    read: str = ""  # <= 200 chars, the boss's read on the player
    intensity: float = 0.7


# Stub taunts per boss (all clean, grim dungeon register, in-voice).
STUB_TAUNTS: dict[str, list[str]] = {
    "smoke-courier": [
        "You run messages through smoke, hero. I read every one.",
        "That dash kicks dust. The dark keeps count.",
        "Hide behind the gloom again. It will not hide you.",
    ],
    "cinderjaw": [
        "Little ember, well done — come closer to the flame.",
        "I swallowed whole war-bands. You are one mouthful.",
        "Bleed on the stone, hero. Feed the floor.",
    ],
    "briar-knight": [
        "Swing, swing. My thorns keep count of every cut.",
        "Patience is a grave-garden, and you walked into it.",
        "That guard is a coffin lid. I am the nails.",
    ],
}

DEFAULT_TAUNT = "Come down, hero. The stone remembers every step."

# Weight keys match the plan's example; the client samples per tick, so the
# model's contribution is a continuous bias, not a discrete pick.
TACTIC_KEYS = ("pressure", "bait", "bombs")


def _uniform_weights() -> dict[str, float]:
    # ponytail: flat uniform is the ceiling for a fallback (any "smart"
    # fallback is just the stub with extra steps). Upgrade path: weight by
    # the current form's kit if forms ever grow distinct signatures.
    w = 1.0 / len(TACTIC_KEYS)
    return {k: w for k in TACTIC_KEYS}


def _clamp01(x: float) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, v))


def _fallback_form(req: BrainRequest) -> str:
    return req.form if bosses.legal_form(req.form) else "crawler"


def stub_decide(req: BrainRequest) -> BrainResponse:
    """Rule-based floor and offline ground truth: habits in, counter out.

    Turtling (high turtle_ratio / stationary_ratio) draws bait-heavy weights
    and the fast wraith body; heat (aggression / dash_spam) draws
    pressure-heavy weights and the armoured colossus; anything else holds the
    current body with balanced weights. Turtling vs aggression therefore plays
    visibly differently even with no model — the proof the contract is
    load-bearing rather than decorative.
    """
    habits = req.habits or {}
    turtle = _clamp01(
        max(habits.get("turtle_ratio", 0.0), habits.get("stationary_ratio", 0.0))
    )
    heat = _clamp01(max(habits.get("aggression", 0.0), habits.get("dash_spam", 0.0)))

    if turtle >= 0.5 and turtle >= heat:
        tactics = {"pressure": 0.2, "bait": 0.6, "bombs": 0.2}
        next_form = "wraith"
        read = (
            f"you turtle and guard (turtle_ratio {turtle:.2f}); "
            "it will hold ground and bait the dash"
        )
    elif heat >= 0.5:
        tactics = {"pressure": 0.65, "bait": 0.15, "bombs": 0.2}
        next_form = "colossus"
        read = (
            f"you rush and trade hits (heat {heat:.2f}); "
            "it will armour up and punish the approach"
        )
    else:
        tactics = {"pressure": 0.4, "bait": 0.3, "bombs": 0.3}
        next_form = _fallback_form(req)
        read = "you mix ranges and tempo; it will press and probe for a habit"

    # A mid-fight morph is a set-piece, not a tick: only bleed-driven, and
    # the client rate-limits to one per fight regardless.
    transform_now = next_form != _fallback_form(req) and req.boss_hp_pct < 30
    open_with = max(TACTIC_KEYS, key=lambda k: tactics[k])
    taunts = STUB_TAUNTS.get(req.boss_id, [DEFAULT_TAUNT])
    taunt = taunts[req.seq % len(taunts)]
    intensity = 0.85 if req.boss_hp_pct < 30 else (0.7 if heat >= 0.5 else 0.55)
    return BrainResponse(
        seq=req.seq,
        tactics=tactics,
        next_form=next_form,
        transform_now=transform_now,
        open_with=open_with,
        taunt=taunt,
        read=read,
        intensity=intensity,
    )


def build_prompt(req: BrainRequest) -> str:
    b = bosses.get_boss(req.boss_id) or {}
    voice = "\n".join(f'- "{line}"' for line in b.get("taunt_voice", []))
    habits = (
        "; ".join(f"{k}={v:.2f}" for k, v in sorted(req.habits.items())) or "none yet"
    )
    build = ", ".join(req.build) or "none yet"
    notes = "; ".join(req.history[-4:]) or "none yet"
    return (
        f"You are {b.get('name', 'the immortal thing in the dark')}, "
        f"{b.get('title', 'it always gets up')} in a grim dungeon crawler — "
        "stone, torchlight, old blood. The hero has ONE life; you are immortal "
        "and you learn.\n"
        f"{SAFETY_RULES}\n"
        f"Your bodies (reply with EXACTLY one of these ids): "
        f"{', '.join(bosses.FORMS)}. Crawler is baseline melee, wraith is fast "
        "and punishes turtling, colossus is armoured and punishes trading hits, "
        "hollow is erratic and punishes pattern.\n"
        f"Your voice (match this flavour):\n{voice}\n"
        f"State: seq={req.seq} descent={req.descent} form={req.form} "
        f"boss_hp={req.boss_hp_pct:.0f}% hero_hp={req.player_hp_pct:.0f}% "
        f"fight_secs={req.fight_secs:.0f} last_damage=[{req.last_damage_source or 'none'}] "
        f"habits=[{habits}] build=[{build}] recent=[{notes}]\n"
        "Return tactic WEIGHTS (keys pressure/bait/bombs, values >= 0) biasing "
        "how it hunts this hero, the body it should wear next, whether to take "
        "that body NOW mid-fight (true only to punish something you just saw) "
        "or on return, what to open with, a grim taunt "
        f"(≤{MAX_TAUNT_LEN} chars) naming what just happened, and your read on "
        f"the hero (≤{MAX_READ_LEN} chars). "
        'Reply ONLY with JSON: {"tactics": {"pressure": 0.0-1.0, "bait": 0.0-1.0, '
        '"bombs": 0.0-1.0}, "next_form": "...", "transform_now": false, '
        '"open_with": "...", "taunt": "...", "read": "...", "intensity": 0.0-1.0}.'
    )


def _weights_ok(tactics: dict[str, float]) -> bool:
    # NaN fails the >= 0 comparison, so it is rejected here, not sampled.
    return bool(tactics) and all(
        isinstance(v, (int, float)) and v >= 0 for v in tactics.values()
    )


def _legal(req: BrainRequest, out) -> bool:
    return (
        bosses.legal_form(out.next_form)
        and _weights_ok(out.tactics)
        and is_taunt_clean(out.taunt)
    )


def _respond(req: BrainRequest, out) -> BrainResponse:
    # Defensive re-derivation: legal replies pass through unchanged; illegal
    # weights/form resolve to the deterministic floor instead of a 500.
    tactics = dict(out.tactics) if _weights_ok(out.tactics) else _uniform_weights()
    next_form = (
        out.next_form if bosses.legal_form(out.next_form) else _fallback_form(req)
    )
    return BrainResponse(
        seq=req.seq,
        tactics=tactics,
        next_form=next_form,
        transform_now=bool(out.transform_now),
        open_with=out.open_with or "",
        taunt=out.taunt,
        read=out.read or "",
        intensity=out.intensity,
    )


async def decide(req: BrainRequest) -> BrainResponse:
    """Main entry: stub when keyless, else model with retry-once then fallback."""
    if stubbed():
        return stub_decide(req)

    prompt = build_prompt(req)
    # Attempt 1.
    try:
        out = await generate(prompt)
        if _legal(req, out):
            return _respond(req, out)
    except Exception:  # noqa: BLE001 — retry once below
        pass
    # Retry once.
    try:
        out = await generate(prompt)
        if _legal(req, out):
            return _respond(req, out)
    except Exception:  # noqa: BLE001 — fall through to rule-based fallback
        pass
    return stub_decide(req)


def score_for(boss_id: str, fight_seconds: float, player_hp_remaining: float) -> int:
    """Score = base per boss + time bonus + HP-remaining bonus, stated plainly.

    base: smoke-courier 1000, cinderjaw 1500, briar-knight 2000.
    time_bonus: max(0, 240 - fight_seconds) * 5 (faster wins pay, capped at 4 min).
    hp_bonus: player_hp_remaining (0-100) * 10.
    """
    base = {"smoke-courier": 1000, "cinderjaw": 1500, "briar-knight": 2000}.get(
        boss_id, 1000
    )
    time_bonus = max(0.0, 240.0 - fight_seconds) * 5
    hp_bonus = max(0.0, min(100.0, player_hp_remaining)) * 10
    return int(base + time_bonus + hp_bonus)
