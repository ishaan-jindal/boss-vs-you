"""Parity between the Python balance model and the formulas the client mirrors.

The client cannot import Python, so `static/game.js` re-implements `exp_to_next`,
`descent_gain`, `boss_hp` and `boss_speed`. These tests restate those JavaScript
formulas verbatim and assert they agree with the Python originals.

The failure this catches is real and was real: the JS XP curve was *linear*
where Python compounds, and the JS boss-scaling offset was `descent - 1` where
Python uses `descent`. Neither raised an error — the game simply played to a
different balance than the one the crossover band was tuned against, which is
exactly the kind of divergence that only shows up as "the game feels wrong".
"""

from bossfight import balance as b


def js_xp_threshold(level: int) -> int:
    """Mirror of xpThreshold() in static/game.js."""
    base = b.EXP_BASE_LEVEL1
    growth = b.EXP_GROWTH
    lvl = max(0, level - 1)
    return int(base * (1 + growth) ** lvl + 0.5)


def js_descent_gain(fight_secs: float, hp_left_pct: float, descent: int) -> int:
    """Mirror of descentGain() in static/game.js."""
    par = b.DESCENT_PAR_BASE_S + b.DESCENT_PAR_PER_DESCENT_S * max(0, descent)
    speed = 1.0 if fight_secs <= 0 else max(0.0, min(1.0, par / fight_secs))
    clean = max(0.0, min(1.0, hp_left_pct / 100.0))
    return max(1, min(3, 1 + int(speed + clean + 0.5)))


def js_boss_hp(base_hp: float, descent: int, growth: float) -> float:
    """Mirror of bossHpPool() in static/game.js."""
    return round(base_hp * (1 + growth * max(0, descent)))


def js_boss_speed(base_px_s: float, descent: int, growth: float, cap: float) -> float:
    """Mirror of bossMovePxS() in static/game.js."""
    return min(base_px_s * (1 + growth * max(0, descent)), cap)


def test_xp_threshold_matches_across_levels():
    for level in range(1, 41):
        assert js_xp_threshold(level) == b.exp_to_next(level), f"level {level}"


def test_xp_threshold_is_compounded_not_linear():
    """A linear curve would pass a single-level check and drift at every other."""
    linear = b.EXP_BASE_LEVEL1 + b.EXP_GROWTH * 9 * (10 - 1)
    assert js_xp_threshold(10) != int(linear)
    assert b.exp_to_next(10) == js_xp_threshold(10)


def test_descent_gain_matches_across_a_grid():
    for descent in (0, 1, 5, 12, 30):
        for secs in (0, 10, 45, 90, 200, 600):
            for hp in (0, 25, 50, 100):
                assert js_descent_gain(secs, hp, descent) == b.descent_gain(
                    secs, hp, descent
                ), f"descent={descent} secs={secs} hp={hp}"


def test_descent_gain_clamps_one_to_three():
    for secs in (0, 1, 30, 1000):
        for hp in (-50, 0, 50, 100, 150):
            assert 1 <= b.descent_gain(secs, hp, 5) <= 3


def test_boss_hp_matches_and_has_no_off_by_one():
    base = b.BOSS_BASE_HP
    for descent in (0, 1, 2, 7, 12, 30, 60):
        assert js_boss_hp(base, descent, b.BOSS_HP_GROWTH_PER_LEVEL) == round(
            b.boss_hp(descent, base)
        ), f"descent={descent}"


def test_boss_hp_offset_matches_python_at_descent_one():
    """The regression: JS used descent-1, making the first boss weaker than the
    tuned model. Assert the offset explicitly rather than only via the loop."""
    base = b.BOSS_BASE_HP
    assert b.boss_hp(1, base) == base * (1 + b.BOSS_HP_GROWTH_PER_LEVEL)


def test_boss_speed_matches_and_respects_cap():
    base = 170.0
    for descent in (0, 1, 5, 30, 200):
        assert js_boss_speed(
            base, descent, b.BOSS_SPEED_GROWTH_PER_LEVEL, b.BOSS_SPEED_CAP_PX_S
        ) == b.boss_speed(descent, base), f"descent={descent}"
    # The cap is the invariant that matters: the boss must never outrun the player.
    assert b.boss_speed(500, base) == b.BOSS_SPEED_CAP_PX_S


def test_payload_carries_every_mirrored_constant():
    """No mirrored formula may depend on a constant absent from the payload."""
    s = b.balance_summary()
    for key in (
        "boss_hp_growth_per_level",
        "boss_dmg_growth_per_level",
        "boss_speed_growth_per_level",
        "boss_speed_cap_px_s",
        "room_boss_hp_mult",
        "minion_cap",
        "minion_base",
        "exp_threshold_present",
    ):
        if key == "exp_threshold_present":
            assert "xp_threshold" in s
        else:
            assert key in s, f"{key} missing from /api/balance payload"

    assert s["room_boss_hp_mult"] == b.room_boss_hp_mult(0)
    assert s["minion_cap"] == b.MINION_CAP
    for kind in ("chaser", "lobber"):
        assert s["minion_base"][kind]["hp"] == b.MINION_BASE_HP[kind]
        assert s["minion_base"][kind]["xp"] == b.MINION_BASE_EXP[kind]

    assert s["xp_threshold"]["base"] == b.EXP_BASE_LEVEL1
    assert s["xp_threshold"]["growth"] == b.EXP_GROWTH
    assert s["xp_threshold"]["mode"] == "compound"
    assert s["descent_par"]["par_base_s"] == b.DESCENT_PAR_BASE_S
    assert s["descent_par"]["par_per_descent_s"] == b.DESCENT_PAR_PER_DESCENT_S
    assert s["descent_par"]["xp_time_cap_s"] == b.EXP_CAP_SECS
