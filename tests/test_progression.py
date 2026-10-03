"""EXP curve + potion scaling: threshold-relative payouts, capped grind.

Covers balance.exp_to_next / exp_grant / potion_heal and the /api/balance
payload the client lane codes against.
"""

from __future__ import annotations

import math

from fastapi.testclient import TestClient

from bossfight import balance as bal
from bossfight.app import create_app


def test_exp_to_next_compounds_and_clamps():
    assert [bal.exp_to_next(lv) for lv in (1, 2, 3, 4, 5)] == [100, 110, 121, 133, 146]
    assert bal.exp_to_next(0) == bal.exp_to_next(-10) == bal.exp_to_next(1) == 100
    # Strictly increasing: the curve never stalls, every level costs more.
    costs = [bal.exp_to_next(lv) for lv in range(1, 31)]
    assert all(b > a for a, b in zip(costs, costs[1:]))
    # Compounding, not linear: each step is ~10% of the last, gaps widen.
    for lv in range(1, 20):
        assert abs(bal.exp_to_next(lv + 1) / bal.exp_to_next(lv) - 1.10) < 0.02


def test_exp_grant_plain_fight_in_band():
    base = bal.exp_to_next(3)
    g = bal.exp_grant(60, 100, 100, 3, 5, False, False)
    assert 0.60 * base <= g <= 0.90 * base


def test_exp_grant_kill_bonus():
    # Intended behaviour: kill adds +25% OF THE BASE THRESHOLD on top of the
    # clamped performance grant (not x1.25 of it). A max-performance kill can
    # therefore reach 1.15x threshold before the one-threshold cap pulls it
    # back; this low-performance fight keeps the bonus visibly inside the
    # band instead of saturating it.
    base = bal.exp_to_next(1)
    plain = bal.exp_grant(0, 0, 0, 1, 1, False, False)
    kill = bal.exp_grant(0, 0, 0, 1, 1, True, False)
    assert kill - plain == math.floor(bal.EXP_KILL_BONUS * base + 0.5)
    assert 0.60 * base <= kill <= 0.90 * base


def test_exp_grant_time_capped_idling_earns_nothing_extra():
    capped = bal.exp_grant(90, 50, 50, 2, 4, False, False)
    idled = bal.exp_grant(900, 50, 50, 2, 4, False, False)
    assert idled == capped


def test_exp_grant_bloodlust():
    plain = bal.exp_grant(0, 0, 0, 1, 1, False, False)
    lust = bal.exp_grant(0, 0, 0, 1, 1, False, True)
    assert lust == math.floor(plain * bal.BLOODLUST_EXP_MULT + 0.5)


def test_exp_grant_never_more_than_one_threshold():
    for lvl in (1, 5, 10, 20):
        base = bal.exp_to_next(lvl)
        g = bal.exp_grant(10_000, 1e9, 0, lvl, 30, True, True)
        assert 0 <= g <= base


def test_exp_grant_negative_inputs_never_negative():
    assert bal.exp_grant(-30, -100, -50, -2, -5, False, False) >= 0
    assert bal.exp_grant(-30, -100, -50, 1, 1, True, True) >= 0


def test_potion_heal_scales_and_caps():
    assert bal.potion_heal(500) > bal.potion_heal(100) > 0
    assert bal.potion_heal(100) == 33  # 30 + 3% keeps the old absolute value
    for hp in (1, 10, 50, 100, 500, 2000):
        assert bal.potion_heal(hp) <= hp
        assert bal.potion_heal(hp, descent=30) <= hp
    # No separate descent term: descent enters through max_hp (Vigour 25->40
    # at descent 12), so the same hero heals the same at any depth.
    assert bal.potion_heal(100, descent=30) == bal.potion_heal(100)


def test_balance_endpoint_exposes_exp_keys():
    body = TestClient(create_app()).get("/api/balance").json()
    for key in ("exp_base_level1", "exp_growth", "exp_kill_bonus", "exp_cap_secs"):
        assert key in body, key
    assert body["exp_base_level1"] == bal.EXP_BASE_LEVEL1 == bal.exp_to_next(1)
    assert body["exp_growth"] == bal.EXP_GROWTH
    assert body["exp_kill_bonus"] == bal.EXP_KILL_BONUS
    assert body["exp_cap_secs"] == bal.EXP_CAP_SECS
    assert len(body["cards"]) == 6


def test_25_fight_run_levels_up_increasingly():
    def run(n: int) -> int:
        level, exp, ups = 1, 0, 0
        for _ in range(n):
            exp += bal.exp_grant(45, 100, 60, level, 5, False, False)
            while exp >= bal.exp_to_next(level):
                exp -= bal.exp_to_next(level)
                level += 1
                ups += 1
        return ups

    counts = [run(n) for n in (5, 10, 15, 20, 25)]
    assert counts[-1] > 0  # the curve fires at all
    assert all(b > a for a, b in zip(counts, counts[1:]))
