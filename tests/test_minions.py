"""Minion roster, telegraph defaults, spawn floor, minion balance curves."""

from __future__ import annotations

from bossfight import balance as bal
from bossfight import bosses
from bossfight.brain import BrainRequest, stub_decide


def test_minion_roster_two_kinds_and_cap():
    assert set(bosses.MINIONS) == {"chaser", "lobber"}
    for kind, m in bosses.MINIONS.items():
        assert m["hp"] > 0 and m["move_speed"] > 0, kind
        assert m["damage"] > 0 and m["xp_value"] > 0, kind
        assert "palette" in m, kind
    assert bosses.MINION_CAP == 5


def test_telegraph_defaults_present():
    for form in bosses.FORM_DEFS.values():
        for a in form["attacks"]:
            assert a["windup_ms"] == 300 or a["windup_ms"] > 0
            assert a["slump_s"] == 1.5 or a["slump_s"] > 0
            assert a["vuln_mult"] == 1.5 or a["vuln_mult"] > 0


def test_stub_spawn_floor():
    empty = BrainRequest(boss_id=bosses.BOSS_ID, minions_alive=0)
    out = stub_decide(empty)
    assert out.spawn_call is True
    assert out.minion_pressure == 0.5
    full = BrainRequest(boss_id=bosses.BOSS_ID, minions_alive=5)
    assert stub_decide(full).spawn_call is False


def test_minion_balance_monotonic_and_room_mult():
    assert bal.minion_exp("chaser") > 0 and bal.minion_exp("lobber") > 0
    hps = [bal.minion_hp("chaser", d) for d in (0, 5, 10, 30)]
    assert hps == sorted(hps) and hps[0] > 0
    assert bal.minion_hp("nope", 5) == 0.0
    for d in (0, 5, 30):
        assert 0.7 <= bal.room_boss_hp_mult(d) <= 0.8
