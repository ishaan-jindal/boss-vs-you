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

# --- EXP curve (plan §3.3): threshold-relative, never raw damage ---
EXP_BASE_LEVEL1 = 100
EXP_GROWTH = 0.10  # +10% compounded per level
EXP_KILL_BONUS = 0.25  # +25% of the base threshold on kill
EXP_FACTOR_LO = 0.60
EXP_FACTOR_HI = 0.90
EXP_CAP_SECS = 90.0  # time-survived EXP stops accruing here per fight

# Descent governor ("par") time. Fight par = base + per_level * descent; beating
# par counts as fast. Served to the client so the numbers live in one place.
DESCENT_PAR_BASE_S = 90.0
DESCENT_PAR_PER_DESCENT_S = 4.0

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


def potion_heal(max_hp: float, descent: int = 0) -> int:
    # descent accepted (game loop passes it) but adds no separate term: the
    # plan's formula is flat + %max HP, and descent already enters through
    # max_hp (Vigour 25 -> 40 at descent 12). A second per-descent coefficient
    # would be an untripped tunable, so it stays out. Never exceeds max_hp,
    # so a near-dead hero cannot overheal.
    _ = max(0, descent)
    hp = max(0.0, max_hp)
    # math.floor(x + 0.5) = JS Math.round for non-negative x (py round() banks).
    return int(min(math.floor(POTION_FLAT + POTION_PCT_MAX_HP * hp + 0.5), hp))


def exp_to_next(level: int) -> int:
    # Compounding (+10%/level), not linear (+10 XP/level): linear growth means
    # later levels arrive at the same rate as early ones while boss HP keeps
    # stacking, which desynchronises card cadence from boss scaling. Level 1
    # costs 100; each level costs 10% more than the last, rounded.
    lvl = max(1, int(level))
    return int(math.floor(EXP_BASE_LEVEL1 * (1.0 + EXP_GROWTH) ** (lvl - 1) + 0.5))


def exp_grant(
    fight_secs: float,
    damage_dealt: float,
    damage_absorbed: float,
    level: int,
    descent: int,
    killed: bool,
    bloodlust: bool,
) -> int:
    """EXP for one fight: base threshold x a performance factor in
    [0.60, 0.90], +25% of base on kill, x1.4 with Bloodlust, capped at one
    full threshold so a fight can never grant multiple levels at once.
    Performance blends time survived (capped at 90s, so idling past the cap
    earns nothing extra) with damage efficiency (dealt share of total damage
    exchanged, so huge raw numbers saturate instead of farming levels). All
    inputs are guarded, never trusted."""
    secs = max(0.0, fight_secs)
    dealt = max(0.0, damage_dealt)
    absorbed = max(0.0, damage_absorbed)
    lvl = max(1, int(level))
    _ = max(0, descent)  # descent shapes the fight, not the payout curve
    base = exp_to_next(lvl)
    time_score = min(secs, EXP_CAP_SECS) / EXP_CAP_SECS
    total = dealt + absorbed
    efficiency = dealt / total if total > 0 else 0.0
    performance = 0.5 * time_score + 0.5 * efficiency
    factor = clamp(
        EXP_FACTOR_LO + (EXP_FACTOR_HI - EXP_FACTOR_LO) * performance,
        EXP_FACTOR_LO,
        EXP_FACTOR_HI,
    )
    grant = factor * base
    if killed:
        # Additive +25% of the base threshold, not x1.25 of the clamped
        # grant: a max-performance kill can reach 1.15x threshold before the
        # one-threshold cap below pulls it back to 1.0x.
        grant += EXP_KILL_BONUS * base
    if bloodlust:
        grant *= BLOODLUST_EXP_MULT
    grant = min(max(0.0, grant), float(base))
    # math.floor(x + 0.5) = JS Math.round for non-negative x (py round() banks).
    return int(math.floor(grant + 0.5))


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
        "exp_base_level1": EXP_BASE_LEVEL1,
        "exp_growth": EXP_GROWTH,
        "exp_kill_bonus": EXP_KILL_BONUS,
        "exp_cap_secs": EXP_CAP_SECS,
        # Served as data so the client never re-implements these curves.
        # xp_threshold.mode is "compound": a linear reading desynchronises
        # card cadence from boss scaling (see exp_to_next's comment).
        "xp_threshold": {
            "base": EXP_BASE_LEVEL1,
            "growth": EXP_GROWTH,
            "mode": "compound",
        },
        # Governor constants used by descent_gain. The formula itself stays in
        # Python and is mirrored in JS, but only these numbers are duplicated.
        "descent_par": {
            "par_base_s": DESCENT_PAR_BASE_S,
            "par_per_descent_s": DESCENT_PAR_PER_DESCENT_S,
            "xp_time_cap_s": EXP_CAP_SECS,
        },
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
