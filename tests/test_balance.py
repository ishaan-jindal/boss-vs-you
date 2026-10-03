"""Balance math: the crossover band, the cooldown floor, the governor, potions.

The crossover test is the one runnable check that matters: for a matrix of
representative builds, ttk(30)/ttk(0) must land in [0.8, 2.5]. If a build
fails, the constants are wrong — the band never moves.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from bossfight import balance as bal
from bossfight import bosses
from bossfight.app import create_app

BUILDS: dict[str, list[str]] = {
    "all-edge": ["Edge"] * 10,
    "all-swiftness": ["Swiftness"] * 10,
    "all-vigour": ["Vigour"] * 10,
    "mixed": ["Edge"] * 4 + ["Vigour"] * 3 + ["Swiftness"] * 3,
    "bloodlust-heavy": ["Bloodlust"] * 6 + ["Edge"] * 2 + ["Vigour"] * 2,
}


def test_crossover_band():
    print("\nbuild            ttk(0)s  ttk(30)s    ratio")
    for name, build in BUILDS.items():
        t0, t30 = bal.ttk_seconds(0, build), bal.ttk_seconds(30, build)
        ratio = t30 / t0
        print(f"{name:15s} {t0:7.2f} {t30:8.2f} {ratio:8.3f}")
        assert 0.8 - 1e-9 <= ratio <= 2.5 + 1e-9, (
            f"{name}: ratio {ratio:.3f} outside band"
        )


def test_swiftness_floor_never_breached():
    cds = [bal.player_attack_cooldown(["Swiftness"] * n) for n in range(60)]
    assert all(cd >= bal.SWIFTNESS_COOLDOWN_FLOOR_S for cd in cds)
    assert cds[-1] == bal.SWIFTNESS_COOLDOWN_FLOOR_S == 0.3
    assert cds[0] == 0.6  # naked base untouched


def test_descent_gain_clamps_and_monotonic():
    assert bal.descent_gain(10, 100, 1) == 3  # fast + clean: full climb
    assert bal.descent_gain(10_000, 0, 1) == 1  # slow + scrappy: still advances
    assert bal.descent_gain(0, 100, 1) == 3  # zero fight time: no crash, capped
    assert bal.descent_gain(-5, 100, 1) == 3
    # Monotonic-ish in speed: slower fights never gain MORE (hp fixed).
    gains = [bal.descent_gain(secs, 60, 5) for secs in (10, 50, 94, 200, 2000)]
    assert gains == sorted(gains, reverse=True)
    assert all(1 <= g <= 3 for g in gains)
    # Half-up rounding matches the plan's JS Math.round (py round() banks).
    assert bal.descent_gain(10_000, 50, 1) == 2


def test_potion_scales_with_max_hp():
    assert bal.potion_heal(100) == 30 + 0.03 * 100
    assert bal.potion_heal(500) > bal.potion_heal(100)


def test_boss_speed_capped_below_player():
    assert bal.boss_speed(30, 170) <= 200.0  # fastest base, deepest run
    assert bal.boss_speed(0, 170) == 170.0  # uncapped early
    assert bal.boss_speed(30, 90) <= bal.boss_speed(30, 170)


def test_card_tiers_from_descent_12():
    edge = ["Edge"] * 4
    assert bal.player_melee_dmg(edge, 11) == 8 + 4 * 3
    assert bal.player_melee_dmg(edge, 12) == 8 + 4 * 5
    vig = ["Vigour"] * 2
    assert bal.player_max_hp(vig, 11) == 100 + 2 * 25
    assert bal.player_max_hp(vig, 12) == 100 + 2 * 40


def test_balance_endpoint_agrees_with_module():
    client = TestClient(create_app())
    r = client.get("/api/balance")
    assert r.status_code == 200
    body = r.json()
    assert body == {**bal.balance_summary(), "forms": bosses.FORMS}
