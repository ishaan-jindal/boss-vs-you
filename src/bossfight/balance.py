"""Escalation + player-build math: the single tunable source of truth.

Pure functions, no I/O. The client reads these same numbers from
GET /api/balance, so there is exactly one copy of every constant.

Why linear (additive) stacking, not compounding: compounding +6% HP reaches
5.7x by descent 30, which hard-walls every zero-DPS build with no
counterplay and blows the crossover band below. Additive stacking is also the
standard RPG reading of "+X% per level".

Why HP is +5%/level when the draft said +6%: 6% additive gives 2.8x at
descent 30, and a pure-Vigour build (no DPS knob by construction) lands at
exactly that ratio — outside the [0.8, 2.5] crossover band with nothing to
tune on the player side. 5% puts it at 2.5x, inside. The crossover test is the
tripwire that caught this; that is what it is for.

Why the speed cap: the player runs ~220 px/s and spacing/dodging is the
skill ceiling. An uncapped +2%/level boss outruns the player by the mid-20s
and spacing collapses into unavoidable damage, so speed is hard-capped just
under player run speed.
"""

from __future__ import annotations

import math
from collections import Counter

# --- Boss escalation (additive per descent level) ---
BOSS_HP_GROWTH_PER_LEVEL = 0.05
BOSS_DMG_GROWTH_PER_LEVEL = 0.05
BOSS_SPEED_GROWTH_PER_LEVEL = 0.02
BOSS_SPEED_CAP_PX_S = 200.0  # player runs ~220 px/s; the boss never outruns

# --- Player base kit (fixed by spec) ---
PLAYER_BASE_HP = 100.0
PLAYER_BASE_MELEE_DMG = 8.0
PLAYER_BASE_ATTACK_COOLDOWN_S = 0.6

# --- Card effects ---
EDGE_DMG = 3
EDGE_DMG_TIER2 = 5
VIGOUR_HP = 25
VIGOUR_HP_TIER2 = 40
SWIFTNESS_MULT = 0.9  # multiplicative per card; flat -s would go negative
SWIFTNESS_COOLDOWN_FLOOR_S = 0.3
MARROW_DASH_CHARGES = 1
MARROW_DASH_CD_REDUCTION_S = 0.5
STONE_SKIN_REDUCTION = 1
DAMAGE_TAKEN_FLOOR = 1
BLOODLUST_EXP_MULT = 1.4
BLOODLUST_HP_PENALTY = 8
TIER2_DESCENT = 12  # from here Edge -> +5, Vigour -> +40

# --- Potion: flat 30 goes dead ~descent 27, so it scales with max HP ---
POTION_FLAT = 30.0
POTION_PCT_MAX_HP = 0.03

# Mid-form pool for analytic TTK. Ratios are base-independent; the absolute
# lands ~12s analytic, i.e. ~1-2 min at real 10-25% uptime. See bosses.py.
BOSS_BASE_HP = 160.0


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def boss_hp(descent: int, base: float = BOSS_BASE_HP) -> float:
    return base * (1.0 + BOSS_HP_GROWTH_PER_LEVEL * max(0, descent))


def boss_damage(descent: int, base: float) -> float:
    return base * (1.0 + BOSS_DMG_GROWTH_PER_LEVEL * max(0, descent))


def boss_speed(descent: int, base_px_s: float) -> float:
    scaled = base_px_s * (1.0 + BOSS_SPEED_GROWTH_PER_LEVEL * max(0, descent))
    return min(scaled, BOSS_SPEED_CAP_PX_S)


def normalize_card(name: str) -> str:
    """'Stone Skin'/'stone-skin'/'STONE_SKIN' -> 'stoneskin'; unknown -> ''."""
    key = "".join(ch for ch in name.lower() if ch.isalnum())
    return (
        key
        if key in ("vigour", "edge", "swiftness", "marrow", "stoneskin", "bloodlust")
        else ""
    )


def count_cards(build: list[str]) -> Counter:
    """Tolerant count: unknown names ignored, never raises."""
    counts: Counter = Counter()
    for name in build:
        key = normalize_card(name)
        if key:
            counts[key] += 1
    return counts


def _tier2(descent: int) -> bool:
    return descent >= TIER2_DESCENT


def player_melee_dmg(build: list[str], descent: int) -> float:
    n = count_cards(build)["edge"]
    return PLAYER_BASE_MELEE_DMG + (EDGE_DMG_TIER2 if _tier2(descent) else EDGE_DMG) * n


def player_attack_cooldown(build: list[str]) -> float:
    # Multiplicative precisely so no card count can drive this negative
    # (flat -0.8s on a 0.6s base = infinite DPS); the floor caps DPS at 2x.
    n = count_cards(build)["swiftness"]
    return max(
        PLAYER_BASE_ATTACK_COOLDOWN_S * (SWIFTNESS_MULT**n), SWIFTNESS_COOLDOWN_FLOOR_S
    )


def player_max_hp(build: list[str], descent: int) -> float:
    counts = count_cards(build)
    per_vigour = VIGOUR_HP_TIER2 if _tier2(descent) else VIGOUR_HP
    hp = (
        PLAYER_BASE_HP
        + per_vigour * counts["vigour"]
        - BLOODLUST_HP_PENALTY * counts["bloodlust"]
    )
    return max(1.0, hp)  # a hero at <= 0 max HP is dead by construction


def player_dps(build: list[str], descent: int) -> float:
    # Sustained melee only: special burst is uptime-gated, not analytic.
    return player_melee_dmg(build, descent) / player_attack_cooldown(build)


def potion_heal(max_hp: float) -> float:
    return POTION_FLAT + POTION_PCT_MAX_HP * max(0.0, max_hp)


def descent_gain(fight_secs: float, hp_left_pct: float, descent: int) -> int:
    """Governor increment (+1..+3 per kill): fast + clean climbs, scrappy wins
    still advance. Zero/negative fight time is treated as maximally fast
    (capped by the clamp, so it cannot overshoot)."""
    par = 90.0 + 4.0 * max(0, descent)
    speed = 1.0 if fight_secs <= 0 else clamp(par / fight_secs, 0.0, 1.0)
    clean = clamp(hp_left_pct / 100.0, 0.0, 1.0)
    # math.floor(x + 0.5) = JS Math.round for non-negative x (py round() banks).
    return int(clamp(1 + math.floor(speed + clean + 0.5), 1, 3))


def ttk_seconds(descent: int, build: list[str]) -> float:
    """Boss HP at descent ÷ analytic player DPS from the card list."""
    return boss_hp(descent) / player_dps(build, descent)


def balance_summary() -> dict:
    """Exact payload served at GET /api/balance (forms merged in by app)."""
    return {
        "boss_hp_growth_per_level": BOSS_HP_GROWTH_PER_LEVEL,
        "boss_dmg_growth_per_level": BOSS_DMG_GROWTH_PER_LEVEL,
        "boss_speed_growth_per_level": BOSS_SPEED_GROWTH_PER_LEVEL,
        "boss_speed_cap_px_s": BOSS_SPEED_CAP_PX_S,
        "tier2_descent": TIER2_DESCENT,
        "potion": {"flat": POTION_FLAT, "pct_max_hp": POTION_PCT_MAX_HP},
        "cards": {
            "edge": {"melee_dmg": EDGE_DMG, "melee_dmg_tier2": EDGE_DMG_TIER2},
            "vigour": {"max_hp": VIGOUR_HP, "max_hp_tier2": VIGOUR_HP_TIER2},
            "swiftness": {
                "cooldown_mult": SWIFTNESS_MULT,
                "cooldown_floor_s": SWIFTNESS_COOLDOWN_FLOOR_S,
            },
            "marrow": {
                "dash_charges": MARROW_DASH_CHARGES,
                "dash_cd_reduction_s": MARROW_DASH_CD_REDUCTION_S,
            },
            "stone_skin": {
                "dmg_reduction": STONE_SKIN_REDUCTION,
                "dmg_taken_floor": DAMAGE_TAKEN_FLOOR,
            },
            "bloodlust": {
                "exp_mult": BLOODLUST_EXP_MULT,
                "max_hp_penalty": BLOODLUST_HP_PENALTY,
            },
        },
        "player_base": {
            "max_hp": PLAYER_BASE_HP,
            "melee_dmg": PLAYER_BASE_MELEE_DMG,
            "attack_cooldown_s": PLAYER_BASE_ATTACK_COOLDOWN_S,
        },
        "boss_base_hp": BOSS_BASE_HP,
    }
