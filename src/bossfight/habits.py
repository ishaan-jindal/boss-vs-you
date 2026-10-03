"""Habit counters: the boss's memory of you, derived client-side, no model tokens.

Input: a list of run-history records (last 60 kept, see MAX_RECORDS). Each
record may carry {descent, form, outcome, fight_secs, hp_at_start, hp_at_end,
last_damage_source, damage_dealt, moves_used: {dash, attack, guard, potion},
damage_blocked, dodges_landed} plus the small extensions the client tracks
{still_secs, potion_hp_mean/potion_n (or potion_hp_fracs), attack_range_mean/
attack_n (or attack_ranges), opener}. Every field is optional; missing data
degrades to 0, never raises.

Normalisation (each counter in one line):
- turtle_ratio = defensive actions (guard + min(dash, dodges)) / all combat actions (guard+attack+dash); 0 when none.
- dash_spam = min(1, dashes-per-minute / 12) x (1 - dodges/dashes); 0 when no dashes (12/min ~= spam ceiling at a 4s dash cooldown).
- stationary_ratio = total still_secs / total fight_secs (time-weighted); 0 when no timed fights.
- potion_timing = pooled mean HP fraction across potion uses (mean-of-means weighted by count); 0 when no potions (1 = chugs at full HP, 0 = drinks at death's door).
- attack_range_pref = pooled mean hit distance in px / 300, clamped 0..1 (0 = point-blank, 1 = long range); 0 when no hits.
- opener = mode of each fight's first-3-seconds action (attack/dash/potion/guard/still); ties break alphabetically.
- finish_frac = kills / (kills + deaths); 0 when no decisive fights.
- death_causes = count per non-blank last_damage_source / total counted (sums to 1); raw counts kept alongside in death_counts.

# ponytail: last-60-fights on one device is the ceiling (no cross-device sync, no decay weighting); add recency decay only if 60-flat memory feels stale.

Pure functions, no I/O. The JS client mirrors this file for live use; the
Python copy is the tested ground truth (notably sample_tactic, since the
client's Math.random sampling cannot be seeded for the load-bearing check).
"""

from __future__ import annotations

import random
from collections import Counter

MAX_RECORDS = 60  # the boss remembers your last 60 fights on this device

TACTIC_KEYS = ("pressure", "bait", "bombs")

_OPENER_LABELS = {
    "attack": "opens with attacks",
    "dash": "opens with a dash",
    "potion": "opens with a potion",
    "guard": "opens with guard",
    "still": "waits at the bell",
}


def _clamp01(x: float) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, v))


def _num(rec: dict, key: str, default: float = 0.0) -> float:
    try:
        v = float(rec.get(key, default))
    except (TypeError, ValueError):
        return default
    return v if v == v and v not in (float("inf"), float("-inf")) else default


def _moves(rec: dict) -> dict[str, int]:
    raw = rec.get("moves_used")
    if not isinstance(raw, dict):
        raw = {}
    out: dict[str, int] = {}
    for k in ("dash", "attack", "guard", "potion"):
        try:
            out[k] = max(0, int(raw.get(k, 0)))
        except (TypeError, ValueError):
            out[k] = 0
    return out


def _recs(history, max_records: int = MAX_RECORDS) -> list[dict]:
    if not isinstance(history, list):
        return []
    try:
        n = max(0, int(max_records))
    except (TypeError, ValueError):
        n = MAX_RECORDS
    tail = history[-n:] if n else []
    return [r for r in tail if isinstance(r, dict)]


def _opener_of(rec: dict) -> str:
    raw = str(rec.get("opener", "") or "").strip().lower()
    if raw in ("atk", "special", "attack"):
        return "attack"
    if raw in ("dash", "potion", "guard"):
        return raw
    return "still"


def habit_summary(history, max_records: int = MAX_RECORDS) -> dict:
    """Summarise fight records into normalised counters + short prompt lines.

    Never raises on empty/single/zero-move histories; action-derived
    counters degrade to 0. Returns floats for the server payload, the
    opener string, death_causes/death_counts, lines (per-counter, short,
    deterministic) and labels (ordered lines for the history payload;
    empty when there are no fights to read).
    """
    recs = _recs(history, max_records)

    guard = attack = dash = 0
    dodges = 0
    total_secs = 0.0
    still_secs = 0.0
    frac_sum = 0.0
    frac_n = 0
    range_sum = 0.0
    range_n = 0
    kills = deaths = 0
    causes: Counter = Counter()
    openers: Counter = Counter()

    for r in recs:
        m = _moves(r)
        guard += m["guard"]
        attack += m["attack"]
        dash += m["dash"]
        try:
            dodges += max(0, int(r.get("dodges_landed", 0)))
        except (TypeError, ValueError):
            pass
        secs = _num(r, "fight_secs")
        if secs > 0:
            total_secs += secs
            still = _num(r, "still_secs")
            if still > 0:
                still_secs += still
        # potion timing: pooled fractions, else mean x count
        fracs = r.get("potion_hp_fracs")
        if isinstance(fracs, list) and fracs:
            vals = [
                float(v) for v in fracs if isinstance(v, (int, float)) and 0 <= v <= 1
            ]
            frac_sum += sum(vals)
            frac_n += len(vals)
        else:
            mean = r.get("potion_hp_mean", None)
            n = r.get("potion_n", m["potion"])
            try:
                n = max(0, int(n))
            except (TypeError, ValueError):
                n = 0
            try:
                mean_f = float(mean) if mean is not None else None
            except (TypeError, ValueError):
                mean_f = None
            if mean_f is not None and n > 0:
                frac_sum += max(0.0, min(1.0, mean_f)) * n
                frac_n += n
        # attack range: pooled px distances, else mean x count
        rngs = r.get("attack_ranges")
        if isinstance(rngs, list) and rngs:
            vals = [float(v) for v in rngs if isinstance(v, (int, float)) and v >= 0]
            range_sum += sum(vals)
            range_n += len(vals)
        else:
            mean = r.get("attack_range_mean", None)
            n = r.get("attack_n", 0)
            try:
                n = max(0, int(n))
            except (TypeError, ValueError):
                n = 0
            try:
                mean_f = float(mean) if mean is not None else None
            except (TypeError, ValueError):
                mean_f = None
            if mean_f is not None and mean_f >= 0 and n > 0:
                range_sum += mean_f * n
                range_n += n
        outcome = str(r.get("outcome", "") or "").strip().lower()
        if outcome == "kill":
            kills += 1
        elif outcome == "death":
            deaths += 1
        cause = str(r.get("last_damage_source", "") or "").strip().lower()
        if cause:
            causes[cause] += 1
        openers[_opener_of(r)] += 1

    defensive = guard + min(dash, dodges)
    combat = guard + attack + dash
    turtle_ratio = _clamp01(defensive / combat) if combat > 0 else 0.0

    if dash <= 0:
        dash_spam = 0.0
    else:
        dpm = (dash / (total_secs / 60.0)) if total_secs > 0 else 12.0
        eff = _clamp01(dodges / dash)
        dash_spam = _clamp01(min(1.0, dpm / 12.0) * (1.0 - eff))

    stationary_ratio = _clamp01(still_secs / total_secs) if total_secs > 0 else 0.0
    potion_timing = _clamp01(frac_sum / frac_n) if frac_n > 0 else 0.0
    attack_range_pref = _clamp01((range_sum / range_n) / 300.0) if range_n > 0 else 0.0

    opener = "still"
    if openers:
        top = max(openers.values())
        opener = sorted(k for k, v in openers.items() if v == top)[0]

    decisive = kills + deaths
    finish_frac = _clamp01(kills / decisive) if decisive > 0 else 0.0

    total_causes = sum(causes.values())
    death_causes = (
        {k: v / total_causes for k, v in sorted(causes.items())} if total_causes else {}
    )
    death_counts = dict(sorted(causes.items()))

    lines = _summary_lines(
        turtle_ratio,
        dash_spam,
        stationary_ratio,
        potion_timing,
        attack_range_pref,
        opener,
        finish_frac,
        death_causes,
        death_counts,
        frac_n,
        range_n,
    )
    labels = (
        [
            lines[k]
            for k in (
                "turtle_ratio",
                "dash_spam",
                "stationary_ratio",
                "potion_timing",
                "attack_range_pref",
                "opener",
                "finish_frac",
                "death_causes",
            )
        ]
        if recs
        else []
    )
    return {
        "turtle_ratio": turtle_ratio,
        "dash_spam": dash_spam,
        "stationary_ratio": stationary_ratio,
        "potion_timing": potion_timing,
        "attack_range_pref": attack_range_pref,
        "opener": opener,
        "finish_frac": finish_frac,
        "death_causes": death_causes,
        "death_counts": death_counts,
        "lines": lines,
        "labels": labels,
        "fights": len(recs),
    }


def _summary_lines(
    turtle, spam, still, potion, rng, opener, finish, causes, counts, potion_n, range_n
) -> dict[str, str]:
    if turtle >= 0.6:
        t = "turtles when hurt"
    elif turtle >= 0.35:
        t = "holds guard often"
    else:
        t = "rarely turtles"
    if spam >= 0.6:
        d = "spams dash"
    elif spam >= 0.3:
        d = "dashes often"
    else:
        d = "dashes with purpose"
    if still >= 0.6:
        s = "stands still to trade"
    elif still >= 0.35:
        s = "holds ground often"
    else:
        s = "keeps moving"
    if potion_n <= 0:
        p = "rarely drinks"
    elif potion >= 0.7:
        p = "drinks potions early"
    elif potion >= 0.4:
        p = "drinks mid-fight"
    else:
        p = "drinks at death's door"
    if range_n <= 0:
        g = "no clean hits yet"
    elif rng >= 0.66:
        g = "hits from long range"
    elif rng >= 0.33:
        g = "mixes its range"
    else:
        g = "fights point-blank"
    o = _OPENER_LABELS.get(opener, "waits at the bell")
    if finish <= 0:
        f = "no kills yet"
    elif finish >= 0.6:
        f = "usually finishes fights"
    elif finish >= 0.35:
        f = "trades kills"
    else:
        f = "rarely finishes fights"
    if not counts:
        c = "nothing has put it down yet"
    else:
        top_n = max(counts.values())
        top = sorted(k for k, v in counts.items() if v == top_n)[0][:40]
        c = f"often put down by {top}"
    return {
        "turtle_ratio": t,
        "dash_spam": d,
        "stationary_ratio": s,
        "potion_timing": p,
        "attack_range_pref": g,
        "opener": o,
        "finish_frac": f,
        "death_causes": c,
    }


def counters_for_server(summary: dict) -> dict[str, float]:
    """Float-only habit payload for POST /api/brain (BrainRequest.habits).

    Opener (a string) and death_causes (a histogram) travel as summary
    lines in history instead — the habits dict stays dict[str, float].
    """
    if not isinstance(summary, dict):
        return {}
    return {
        k: _clamp01(summary.get(k, 0.0))
        for k in (
            "turtle_ratio",
            "dash_spam",
            "stationary_ratio",
            "potion_timing",
            "attack_range_pref",
            "finish_frac",
        )
    }


def history_lines(summary: dict) -> list[str]:
    """Short deterministic lines for the history payload (small prompt)."""
    if not isinstance(summary, dict):
        return []
    labels = summary.get("labels")
    return [str(s) for s in labels] if isinstance(labels, list) else []


def fallback_read(summary: dict) -> str:
    """Deterministic habit-derived read when the model returns nothing.

    Empty profile -> an honest "no read yet" (never a blank gap on the
    death screen); otherwise the 1-2 strongest habit lines. Always
    non-empty and <= 200 chars.
    """
    if not isinstance(summary, dict) or summary.get("fights", 0) <= 0:
        return "it has no read on you yet — move, and it will learn."
    lines = summary.get("lines") or {}
    scored = [
        (float(summary.get("turtle_ratio", 0.0)), str(lines.get("turtle_ratio", ""))),
        (float(summary.get("dash_spam", 0.0)), str(lines.get("dash_spam", ""))),
        (
            float(summary.get("stationary_ratio", 0.0)),
            str(lines.get("stationary_ratio", "")),
        ),
    ]
    strong = sorted(((v, s) for v, s in scored if v >= 0.35 and s), reverse=True)
    if strong:
        read = "; ".join(s for _, s in strong[:2])
    else:
        read = str(lines.get("opener", "") or "it watches how you open")
    return read[:200] or "it watches how you open."


def sample_tactic(weights: dict | None, rng=None) -> str:
    """JS sampleTactic mirror: weighted pick over TACTIC_KEYS, uniform floor.

    Pass a random.Random(seed) for deterministic load-bearing checks; the
    client cannot (Math.random), so this mirror is where distribution
    tests live.
    """
    r = rng or random
    w = weights or {}
    total = 0.0
    for k in TACTIC_KEYS:
        try:
            v = max(0.0, float(w.get(k, 0.0)))
        except (TypeError, ValueError):
            v = 0.0
        total += v
    if total <= 0:
        return r.choice(list(TACTIC_KEYS))
    x = r.random() * total
    for k in TACTIC_KEYS:
        try:
            v = max(0.0, float(w.get(k, 0.0)))
        except (TypeError, ValueError):
            v = 0.0
        x -= v
        if x <= 0:
            return k
    return TACTIC_KEYS[0]


def tactic_distribution(
    weights: dict | None, n: int = 200, seed: int = 0
) -> dict[str, int]:
    """Count sample_tactic over n ticks with a fixed RNG (load-bearing proof)."""
    rng = random.Random(seed)
    counts = {k: 0 for k in TACTIC_KEYS}
    for _ in range(max(0, int(n))):
        counts[sample_tactic(weights, rng)] += 1
    return counts
