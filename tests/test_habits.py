"""Habit-counter tests: normalisation per counter, guards, lines, sampling."""

from __future__ import annotations

import random

from bossfight.habits import (
    MAX_RECORDS,
    counters_for_server,
    fallback_read,
    habit_summary,
    history_lines,
    sample_tactic,
    tactic_distribution,
)


def rec(**kw):
    base = dict(
        descent=1,
        form="crawler",
        outcome="kill",
        fight_secs=60.0,
        hp_at_start=100,
        hp_at_end=50,
        last_damage_source="lunge",
        damage_dealt=140,
        moves_used={"dash": 2, "attack": 20, "guard": 0, "potion": 1},
        damage_blocked=0,
        dodges_landed=1,
    )
    base.update(kw)
    return base


def test_turtle_ratio_guards_over_attacks():
    s = habit_summary(
        [rec(moves_used={"dash": 0, "attack": 1, "guard": 3, "potion": 0})]
    )
    assert s["turtle_ratio"] == 0.75
    assert s["lines"]["turtle_ratio"] == "turtles when hurt"


def test_turtle_ratio_pure_offence_is_zero():
    s = habit_summary(
        [
            rec(
                moves_used={"dash": 4, "attack": 20, "guard": 0, "potion": 0},
                dodges_landed=0,
            )
        ]
    )
    assert s["turtle_ratio"] == 0.0


def test_turtle_ratio_defensive_dashes_count():
    # 4 dashes, all dodged (defensive) + 4 attacks -> half the actions are defence
    s = habit_summary(
        [
            rec(
                moves_used={"dash": 4, "attack": 4, "guard": 0, "potion": 0},
                dodges_landed=4,
            )
        ]
    )
    assert s["turtle_ratio"] == 0.5


def test_dash_spam_rate_times_ineffectiveness():
    # 6 dashes in 60s, none effective -> 0.5 rate x 1.0 waste = 0.5
    s = habit_summary(
        [
            rec(
                moves_used={"dash": 6, "attack": 5, "guard": 0, "potion": 0},
                dodges_landed=0,
            )
        ]
    )
    assert s["dash_spam"] == 0.5
    assert s["lines"]["dash_spam"] == "dashes often"


def test_dash_spam_effective_dashes_are_not_spam():
    s = habit_summary(
        [
            rec(
                moves_used={"dash": 12, "attack": 5, "guard": 0, "potion": 0},
                dodges_landed=12,
            )
        ]
    )
    assert s["dash_spam"] == 0.0


def test_dash_spam_no_dashes_is_zero():
    s = habit_summary(
        [rec(moves_used={"dash": 0, "attack": 5, "guard": 0, "potion": 0})]
    )
    assert s["dash_spam"] == 0.0


def test_stationary_ratio_time_weighted():
    s = habit_summary(
        [rec(still_secs=30.0, fight_secs=60.0), rec(still_secs=0.0, fight_secs=60.0)]
    )
    assert s["stationary_ratio"] == 0.25


def test_stationary_ratio_missing_data_is_zero():
    assert habit_summary([rec()])["stationary_ratio"] == 0.0


def test_potion_timing_pooled_mean():
    s = habit_summary(
        [
            rec(
                moves_used={"dash": 0, "attack": 1, "guard": 0, "potion": 1},
                potion_hp_mean=0.8,
                potion_n=1,
            ),
            rec(
                moves_used={"dash": 0, "attack": 1, "guard": 0, "potion": 3},
                potion_hp_mean=0.2,
                potion_n=3,
            ),
        ]
    )
    assert abs(s["potion_timing"] - 0.35) < 1e-9
    assert s["lines"]["potion_timing"] == "drinks at death's door"


def test_potion_timing_no_potions_is_zero():
    assert (
        habit_summary(
            [rec(moves_used={"dash": 0, "attack": 1, "guard": 0, "potion": 0})]
        )["potion_timing"]
        == 0.0
    )


def test_attack_range_pref_normalised_by_300px():
    s = habit_summary([rec(attack_range_mean=150.0, attack_n=4)])
    assert s["attack_range_pref"] == 0.5
    assert s["lines"]["attack_range_pref"] == "mixes its range"


def test_attack_range_pref_no_hits_is_zero():
    assert habit_summary([rec()])["attack_range_pref"] == 0.0


def test_opener_is_mode_with_alphabetical_ties():
    s = habit_summary([rec(opener="dash"), rec(opener="attack"), rec(opener="dash")])
    assert s["opener"] == "dash"
    assert s["lines"]["opener"] == "opens with a dash"
    tied = habit_summary([rec(opener="dash"), rec(opener="attack")])
    assert tied["opener"] == "attack"  # tie -> alphabetical, deterministic


def test_finish_frac_kills_over_decisive():
    s = habit_summary([rec(outcome="kill"), rec(outcome="kill"), rec(outcome="death")])
    assert abs(s["finish_frac"] - 2 / 3) < 1e-9


def test_finish_frac_no_decisive_is_zero():
    assert habit_summary([])["finish_frac"] == 0.0
    assert habit_summary([rec(outcome="fled")])["finish_frac"] == 0.0


def test_death_causes_histogram_sums_to_one():
    s = habit_summary(
        [
            rec(outcome="death", last_damage_source="slam"),
            rec(outcome="death", last_damage_source="slam"),
            rec(outcome="death", last_damage_source="lunge"),
            rec(outcome="kill", last_damage_source=""),  # blank causes are skipped
        ]
    )
    assert abs(sum(s["death_causes"].values()) - 1.0) < 1e-9
    assert s["death_causes"] == {"lunge": 1 / 3, "slam": 2 / 3}
    assert s["death_counts"] == {"lunge": 1, "slam": 2}
    assert s["lines"]["death_causes"] == "often put down by slam"


def test_empty_single_zero_move_never_raise_and_zero_actions():
    # Empty / junk histories: no data, so action counters are 0 and opener rests.
    for hist in ([], [None, "junk", 42], None, "not-a-list"):
        s = habit_summary(hist)
        for k in (
            "turtle_ratio",
            "dash_spam",
            "stationary_ratio",
            "potion_timing",
            "attack_range_pref",
        ):
            assert s[k] == 0.0, (hist, k)
        assert s["opener"] == "still"
    # A single record with real moves computes (no raise, valid range) ...
    s = habit_summary([rec()])
    for k in (
        "turtle_ratio",
        "dash_spam",
        "stationary_ratio",
        "potion_timing",
        "attack_range_pref",
        "finish_frac",
    ):
        assert 0.0 <= s[k] <= 1.0
    # ... while all-zero moves mean no action signal at all.
    z = habit_summary(
        [rec(moves_used={"dash": 0, "attack": 0, "guard": 0, "potion": 0})]
    )
    for k in ("turtle_ratio", "dash_spam", "attack_range_pref"):
        assert z[k] == 0.0


def test_max_records_cap():
    s = habit_summary([rec()] * (MAX_RECORDS + 10))
    assert s["fights"] == MAX_RECORDS


def test_lines_deterministic_and_short():
    hist = [
        rec(
            opener="dash",
            still_secs=40,
            fight_secs=60,
            moves_used={"dash": 8, "attack": 4, "guard": 6, "potion": 1},
            potion_hp_mean=0.9,
            potion_n=1,
            attack_range_mean=280,
            attack_n=4,
            outcome="death",
            last_damage_source="slam",
        )
    ]
    a = habit_summary(hist)
    b = habit_summary(hist)
    assert a["lines"] == b["lines"]
    assert a["labels"] == b["labels"]
    assert len(a["lines"]) == 8
    for line in a["lines"].values():
        assert 0 < len(line) <= 64, line
    assert habit_summary([])["labels"] == []  # nothing to read yet -> small prompt


def test_counters_for_server_is_float_only():
    s = habit_summary([rec(opener="dash", last_damage_source="slam")])
    payload = counters_for_server(s)
    assert set(payload) == {
        "turtle_ratio",
        "dash_spam",
        "stationary_ratio",
        "potion_timing",
        "attack_range_pref",
        "finish_frac",
    }
    assert all(isinstance(v, float) and 0.0 <= v <= 1.0 for v in payload.values())
    assert history_lines(s) == s["labels"]


def test_fallback_read_never_blank_and_bounded():
    empty = fallback_read(habit_summary([]))
    assert empty and len(empty) <= 200
    full = fallback_read(
        habit_summary(
            [
                rec(
                    moves_used={"dash": 1, "attack": 2, "guard": 15, "potion": 0},
                    still_secs=50,
                    fight_secs=60,
                    outcome="death",
                    last_damage_source="slam",
                )
            ]
        )
    )
    assert full and len(full) <= 200
    assert full != empty
    assert fallback_read({}) and fallback_read(None)


def test_sample_tactic_floor_and_determinism():
    for w in (None, {}, {"pressure": 0, "bait": 0, "bombs": 0}):
        assert sample_tactic(w, random.Random(0)) in ("pressure", "bait", "bombs")
    a = [
        sample_tactic({"pressure": 0.65, "bait": 0.15, "bombs": 0.2}, random.Random(7))
        for _ in range(20)
    ]
    b = [
        sample_tactic({"pressure": 0.65, "bait": 0.15, "bombs": 0.2}, random.Random(7))
        for _ in range(20)
    ]
    assert a == b
    d = tactic_distribution({"pressure": 0.2, "bait": 0.6, "bombs": 0.2}, n=200, seed=0)
    assert sum(d.values()) == 200
    assert d["bait"] > d["pressure"]  # weights bias the draw, not decoration
