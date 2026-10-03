"""The immortal boss: ONE entity, four forms. All characters are ORIGINAL.

WHY shared-and-weighted kits instead of four bespoke kits (scope):
four forms in the remaining time cannot each carry a tuned bespoke kit
without the tuning collapsing into guesswork. One shared pattern
vocabulary (swipe / ground-pound / projectile) plus ONE signature move
per form plus per-form weights still produces visibly different fights —
the stub proof is that turtle-vs-aggro already plays differently with no
model at all — and every weight is a single number the crossover-style
tests can actually pin down. Bespoke kits are cut content, not missing
content; add a new pattern only when a form's signature cannot express it.

NUMBERS — why these values (time-to-kill ≈ 2-3 min at average play):

Player kit (fixed by spec): HP 100, melee dmg 8 @ 0.6s cooldown
  → theoretical max 13.3 dps. Special 25 dmg @ 12s → +~2.1 dps if used
  on cooldown → ~15.4 dps ceiling.

Nobody plays at ceiling. Real uptime is low because the skill IS dodging:
  - telegraphs force ~0.8s disengages every few seconds (~70% uptime),
  - chasing a moving boss + whiffed arcs (~60% hit rate),
  - dash/potion repositioning, learning patterns, phase changes.
  0.7 × 0.6 ≈ 40% uptime early, ~10-25% for a learning player vs a
  punishing boss (armour, blink-strikes, feints waste swings).
  Effective DPS ≈ 1.5-4 → TTK:
    Crawler 140 HP / ~2 dps   ≈  70-120s, the baseline read
    Wraith  120 HP / ~2 dps   ≈  60-100s, faster but frailer
    Colossus 200 HP / ~1.8 dps ≈ 110-160s (armour taxes every swing)
    Hollow  150 HP / ~1.5 dps ≈ 100-160s (feints waste your openings)
  First clears land ~2-3 min; rematches trend faster. Good.

Boss damage budget: player has 100 HP + 2×30 potions = 160 effective.
  Attacks deal 8-16, telegraphed, avoidable ~70% of the time once
  learned → ~1 dps incoming → player survives 100s+ per life, potions cover
  mistakes. Enrage (<30%) multiplies speed/damage but fight is nearly over.

Speeds are px/s on an ~800×600 arena; player ~220 px/s (joystick).

TRANSFORM RULES — why each rule exists (enforced server-side by
can_transform, mirrored client-side because only the client knows its
own fight count in real time; the server trusts the client's reported
count, the client is the source of truth for it):
  - no-op rejected: transforming into the form you already wear is a
    wasted set-piece that resets the HP pool for free drama. Never.
  - one mid-fight transform per fight: the set-piece (flash, crack,
    re-learn spacing in seconds) is only readable if it is rare. A
    second mid-fight swap turns tells into noise.
  - below descent 3, transforms on return only: early on the player is
    still learning what each tell MEANS. A mid-fight morph at descent 1
    punishes learning itself.
  - lockout after transforming (transform_cost, 1-2s): the model cannot
    chain-swap across consecutive brain ticks into an unreadable fight
    or soft-lock the player inside back-to-back windups. Small on
    purpose — it prices swapping, not thinking.
"""

from __future__ import annotations

import random

# The immortal boss's four bodies. Same creature throughout (long, wrong, too
# many joints), just wronger. The model picks next_form from this list and the
# client honours it mid-fight or on return (rate-limited on both sides).
# Kept as plain ids: full per-form kits live in FORM_DEFS below.
FORMS: list[str] = ["crawler", "wraith", "colossus", "hollow"]


def legal_form(form: str) -> bool:
    """True when the model named a body the game can actually wear."""
    return form in FORMS


# One entity. The roster endpoint serves this plus the form list; there is
# no selection screen and no ladder anymore.
BOSS_ID = "the-thing-below"

BOSS: dict = {
    "id": BOSS_ID,
    "name": "The Thing Below",
    "title": "It was always the same monster. Just wronger.",
    "colour": 0x6B4D8A,
    "glyph": "◈",
    "taunt_voice": [
        "Down here, hero. The stone remembers every step.",
        "You killed me before. I kept the scars. Keep coming.",
        "Bleed on the floor, hero. Feed what feeds on you.",
    ],
    "enrage": {
        "phase_below_pct": 30,
        "speed_mult": 1.25,
        "damage_mult": 1.25,
        "taunts": [
            "ENOUGH, hero — no more shapes but WRATH!",
            "You tore the skin. Now comes the underneath!",
        ],
    },
}

# Back-compat: the roster endpoint still serves a "bosses" list, now of one.
BOSSES: list[dict] = [BOSS]

BY_ID: dict[str, dict] = {BOSS_ID: BOSS}


def get_boss(boss_id: str) -> dict | None:
    return BY_ID.get(boss_id)


def tactic_ids(boss_id: str) -> list[str]:
    # Tactic keys are global weights now (plan §3.7), not per-boss labels.
    return ["pressure", "bait", "bombs"] if get_boss(boss_id) else []


def phase_for(boss_hp_pct: float) -> str:
    """'enrage' below 30% boss HP, else 'normal'."""
    return "enrage" if boss_hp_pct < 30 else "normal"


def _atk(
    id: str,
    damage: int,
    telegraph_ms: int,
    cooldown_s: float,
    range_px: int,
    pattern: str,
    **extra,
) -> dict:
    a = {
        "id": id,
        "damage": damage,
        "telegraph_ms": telegraph_ms,
        "cooldown_s": cooldown_s,
        "range_px": range_px,
        "pattern": pattern,
    }
    a.update(extra)
    return a


FORM_DEFS: dict[str, dict] = {
    "crawler": {
        "id": "crawler",
        "name": "Crawler",
        "title": "Low, wide, patient. It has all night.",
        "hp": 140,
        "move_speed": 150,
        "colour": 0x6B4D8A,
        "glyph": "≋",
        # Temperament for the prompt: keeps Gemma's taunts in character.
        "identity": "patient, low, coiled",
        # The windup the player learns to read. Distinct per form on purpose:
        # tells that overlap are tells the player cannot learn.
        "signature_tell": 900,
        "signature": "lunge",
        "armour": 0,
        "attacks": [
            _atk("lunge", 12, 900, 4.0, 220, "lunge"),
            _atk("swipe", 8, 800, 2.5, 90, "cone"),
            _atk("ground-pound", 10, 800, 5.5, 180, "aoe_circle"),
            _atk("projectile", 8, 800, 6.0, 420, "projectile"),
        ],
        "weights": {"lunge": 0.4, "swipe": 0.3, "ground-pound": 0.2, "projectile": 0.1},
        "visual": {
            "recipe": "courier",
            "scale": 1.0,
            "palette": {
                "body": 0x2B2440,
                "trim": 0x6B4D8A,
                "hat": 0x1A1626,
                "eye": 0xCBB7FF,
            },
        },
    },
    "wraith": {
        "id": "wraith",
        "name": "Wraith",
        "title": "Half-floating, fast. It is already behind you.",
        "hp": 120,
        "move_speed": 190,
        "colour": 0x9FD8E8,
        "glyph": "∼",
        "identity": "hungry, quick, vain",
        "signature_tell": 650,
        "signature": "blink",
        "armour": 0,
        "attacks": [
            # Teleport-strike: resolves at the hero's feet, ignores ground
            # hazards (there is nowhere on the floor it cannot leave).
            _atk("blink", 12, 650, 3.5, 9999, "lunge"),
            _atk("swipe", 8, 650, 2.0, 90, "cone"),
            _atk("ground-pound", 9, 700, 6.0, 170, "aoe_circle"),
            _atk("projectile", 10, 650, 3.0, 420, "projectile"),
        ],
        "weights": {
            "blink": 0.45,
            "projectile": 0.3,
            "swipe": 0.15,
            "ground-pound": 0.1,
        },
        "visual": {
            "recipe": "courier",
            "scale": 1.05,
            "palette": {
                "body": 0x3D4A5C,
                "trim": 0x9FD8E8,
                "hat": 0x20262E,
                "eye": 0xE8FBFF,
            },
        },
    },
    "colossus": {
        "id": "colossus",
        "name": "Colossus",
        "title": "Stone-plated. Every swing costs you.",
        "hp": 200,
        "move_speed": 90,
        "colour": 0xE0572B,
        "glyph": "▲",
        "identity": "slow, stone, certain",
        "signature_tell": 1100,
        "signature": "slam",
        # Flat damage reduction per hit (floor 1, never immune).
        "armour": 2,
        "attacks": [
            # Shockwave ring: wide AoE that cracks the arena floor.
            _atk("slam", 16, 1100, 5.0, 200, "aoe_circle"),
            _atk("swipe", 11, 900, 4.5, 130, "cone"),
            _atk("ground-pound", 14, 1000, 6.0, 180, "aoe_circle"),
            _atk("projectile", 8, 1000, 6.0, 300, "projectile"),
        ],
        "weights": {"slam": 0.4, "ground-pound": 0.3, "swipe": 0.2, "projectile": 0.1},
        "visual": {
            "recipe": "cinderjaw",
            "scale": 1.35,
            "palette": {
                "body": 0x5C4A3A,
                "jaw": 0x3A2E24,
                "wing": 0x2E2420,
                "eye": 0xFFD75E,
            },
        },
    },
    "hollow": {
        "id": "hollow",
        "name": "Hollow",
        "title": "Split silhouette, flickering. Do not trust the windup.",
        "hp": 150,
        "move_speed": 130,
        "colour": 0x3FA34D,
        "glyph": "✦",
        "identity": "erratic, mocking, hollow",
        "signature_tell": 450,
        "signature": "feint",
        "armour": 0,
        "attacks": [
            # A telegraph that often fakes out: shortest, least readable.
            _atk("feint", 10, 450, 5.0, 200, "melee", feint_chance=0.5),
            _atk("swipe", 9, 500, 2.5, 110, "cone"),
            _atk("ground-pound", 11, 550, 6.0, 180, "aoe_circle"),
            _atk("projectile", 9, 500, 4.0, 420, "projectile"),
        ],
        "weights": {
            "feint": 0.35,
            "swipe": 0.25,
            "projectile": 0.25,
            "ground-pound": 0.15,
        },
        "visual": {
            "recipe": "hollow",
            "scale": 1.15,
            "palette": {
                "body": 0x1D3A24,
                "dark": 0x0E1F14,
                "eye": 0xB6FF9E,
            },
        },
    },
}

# Served inside GET /api/balance so the client reads the same rules as the
# server enforces. No new endpoint: one source of truth, no drift.
MIN_DESCENT_MID_FIGHT = 3  # below this, transforms happen on return only
MAX_MID_FIGHT_PER_FIGHT = 1


def transform_cost(descent: int) -> float:
    """Lockout (seconds) after a transform before the next one may fire.

    1.0s early lengthening to 2.0s by descent 10: deeper tells are faster
    and less readable, so back-to-back set-pieces need more air between
    them. Capped — this prices chain-swapping, it never forbids it.
    """
    return 1.0 + 0.1 * max(0, min(int(descent), 10))


TRANSFORM_RULES: dict = {
    "min_descent_mid_fight": MIN_DESCENT_MID_FIGHT,
    "max_mid_fight_per_fight": MAX_MID_FIGHT_PER_FIGHT,
    "lockout_s_at_descent_1": transform_cost(1),
    "lockout_s_at_descent_10": transform_cost(10),
}


def can_transform(
    current_form: str,
    desired_form: str,
    tick: float,
    descent: int,
    transforms_this_fight: int,
    *,
    mid_fight: bool = True,
) -> tuple[bool, str]:
    """Server-side transform gate. Returns (allowed, reason).

    tick is seconds since the last transform (pass a large number on
    descent transitions, where the previous fight's transform is long
    past); it is checked against transform_cost(descent). mid_fight
    distinguishes a mid-fight morph (True) from an on-return one (False):
    the bare 5-arg call tests the mid-fight path, which is the
    rate-limited one.
    """
    if not legal_form(desired_form):
        return False, f"illegal form {desired_form!r} — the game cannot wear it"
    if desired_form == current_form:
        return False, f"already {current_form} — a same-form transform is a no-op"
    cost = transform_cost(descent)
    if tick < cost:
        return False, f"lockout {cost - tick:.1f}s remaining — no chain-swapping"
    if mid_fight:
        if transforms_this_fight >= MAX_MID_FIGHT_PER_FIGHT:
            return False, "one mid-fight transform per fight already used"
        if descent < MIN_DESCENT_MID_FIGHT:
            return (
                False,
                f"descent {descent} < {MIN_DESCENT_MID_FIGHT} — "
                "transforms on return only while the player learns each form",
            )
    return True, "ok"


def sample_attack(form_id: str, rng: random.Random | None = None) -> str:
    """Weighted-random attack id for a form (stdlib random.choices)."""
    form = FORM_DEFS[form_id]
    ids = [a["id"] for a in form["attacks"]]
    weights = [form["weights"].get(i, 0.0) for i in ids]
    r = rng or random
    return r.choices(ids, weights=weights, k=1)[0]
