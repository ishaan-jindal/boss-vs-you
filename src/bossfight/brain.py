"""The brain: picks a tactic exploiting the hero's pattern + a taunt.

Client sends full state each call (stateless server). Validation failures
→ retry once → rule-based fallback. Never a 500 from a bad model.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from . import bosses
from .providers import generate, stubbed
from .safety import SAFETY_RULES, is_taunt_clean


class BrainRequest(BaseModel):
    boss_id: str
    tick: int = 0
    boss_hp_pct: float = 100.0
    player_hp_pct: float = 100.0
    player_style: str = Field(default="mobile", pattern="^(turtly|mobile|aggressive)$")
    current_tactic: str = ""
    phase: str = ""
    threats: list[str] = Field(default_factory=list)


class BrainResponse(BaseModel):
    tactic_id: str
    taunt: str
    intensity: float = 0.5


# Stub canned taunts per boss (all clean, playful, in-voice).
STUB_TAUNTS: dict[str, list[str]] = {
    "smoke-courier": [
        "Special delivery, hero — try to keep up!",
        "That dash leaves footprints. I read them like mail.",
        "Blink twice and you're dizzy, hero!",
    ],
    "cinderjaw": [
        "Flap those feet, hero — floor's lava-ish!",
        "One sneeze and you're toast. Kidding. Mostly.",
        "Well done — nicely toasted on both sides!",
    ],
    "briar-knight": [
        "Swing, swing. My thorns keep count, hero.",
        "Patience is a garden, and you walked into it.",
        "Careful with that button — the thorns tickle back.",
    ],
}

# Style → tactic index hint so the stub visibly adapts, not just rotates.
STYLE_HINT: dict[str, int] = {"turtly": 1, "mobile": 0, "aggressive": 2}


def stub_decide(req: BrainRequest) -> BrainResponse:
    """Rule-based fallback: cycle tactics across ticks, adapt slightly to style.

    Cycles so consecutive ticks don't stick on one tactic.
    """
    tactics = bosses.tactic_ids(req.boss_id)
    if not tactics:
        return BrainResponse(
            tactic_id="default", taunt="Let's see what you've got, hero!", intensity=0.5
        )
    hint = STYLE_HINT.get(req.player_style, 0)
    idx = (req.tick + hint) % len(tactics)
    # Avoid echoing the current tactic when alternatives exist.
    if len(tactics) > 1 and tactics[idx] == req.current_tactic:
        idx = (idx + 1) % len(tactics)
    taunts = STUB_TAUNTS.get(req.boss_id, ["En garde, hero — show me your footwork!"])
    taunt = taunts[req.tick % len(taunts)]
    intensity = (
        0.85
        if req.boss_hp_pct < 30
        else (0.65 if req.player_style == "aggressive" else 0.5)
    )
    return BrainResponse(tactic_id=tactics[idx], taunt=taunt, intensity=intensity)


def build_prompt(req: BrainRequest) -> str:
    b = bosses.get_boss(req.boss_id) or {}
    tactics = "\n".join(
        f"- {t['id']}: {t['description']}" for t in b.get("tactics", [])
    )
    voice = "\n".join(f'- "{line}"' for line in b.get("taunt_voice", []))
    threats = "; ".join(req.threats) if req.threats else "none yet"
    return (
        f"You are {b.get('name', 'a boss')}, {b.get('title', '')} in a playful kids' "
        "action game (opponents FAINT, never die; comedic, no blood/gore).\n"
        f"{SAFETY_RULES}\n"
        f"Tactics (reply with EXACTLY one of these ids):\n{tactics}\n"
        f"Your voice (match this flavour):\n{voice}\n"
        f"State: tick={req.tick} boss_hp={req.boss_hp_pct:.0f}% "
        f"hero_hp={req.player_hp_pct:.0f}% hero_style={req.player_style} "
        f"phase={req.phase or bosses.phase_for(req.boss_hp_pct)} "
        f"current_tactic={req.current_tactic or 'none'} recent_events=[{threats}]\n"
        "Pick the tactic that best exploits the hero's pattern and a playful "
        "taunt (<=140 chars) reacting to recent events. "
        'Reply ONLY with JSON: {"tactic_id": "...", "taunt": "...", "intensity": 0.0-1.0}.'
    )


def _legal(req: BrainRequest, tactic_id: str, taunt: str) -> bool:
    return tactic_id in bosses.tactic_ids(req.boss_id) and is_taunt_clean(taunt)


async def decide(req: BrainRequest) -> BrainResponse:
    """Main entry: stub when keyless, else model with retry-once then fallback."""
    if stubbed():
        return stub_decide(req)

    prompt = build_prompt(req)
    # Attempt 1.
    try:
        out = await generate(prompt)
        if _legal(req, out.tactic_id, out.taunt):
            return BrainResponse(
                tactic_id=out.tactic_id, taunt=out.taunt, intensity=out.intensity
            )
    except Exception:  # noqa: BLE001 — retry once below
        pass
    # Retry once.
    try:
        out = await generate(prompt)
        if _legal(req, out.tactic_id, out.taunt):
            return BrainResponse(
                tactic_id=out.tactic_id, taunt=out.taunt, intensity=out.intensity
            )
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
