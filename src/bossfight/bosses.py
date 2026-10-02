"""Boss configs, served to the client. All characters are ORIGINAL.

NUMBERS — why these values (time-to-kill ≈ 2-3 min at average play):

Player kit (fixed by spec): HP 100, melee dmg 8 @ 0.6s cooldown
  → theoretical max 13.3 dps. Special 25 dmg @ 12s → +~2.1 dps if used
  on cooldown → ~15.4 dps ceiling.

Nobody plays at ceiling. Real uptime is low because the skill IS dodging:
  - telegraphs force ~0.8s disengages every few seconds (~70% uptime),
  - chasing a moving boss + whiffed arcs (~60% hit rate),
  - dash/potion repositioning, learning patterns, phase changes.
  0.7 × 0.6 ≈ 40% uptime early, ~10-25% for a learning player vs a
  punishing boss (counter stance, flight phase, decoy feints waste swings).
  Effective DPS ≈ 1.5-4 → TTK:
    Smoke Courier 120 HP / ~2 dps   ≈  60-90s skilled, ~120s learning
    Cinderjaw     200 HP / ~1.8 dps ≈ 110-150s (+ flight phase stalls melee)
    Briar Knight  160 HP / ~1.5 dps ≈ 110-160s (counter stance punishes spam)
  First clears land ~2-3 min; rematches trend faster. Good.

Boss damage budget: player has 100 HP + 2×30 potions = 160 effective.
  Attacks deal 10-16, telegraphed 0.8s, avoidable ~70% of the time once
  learned → ~1 dps incoming → player survives 100s+ per life, potions cover
  mistakes. Enrage (<30%) multiplies speed/damage but fight is nearly over.

Speeds are px/s on an ~800×600 arena; player ~220 px/s (joystick).
"""

from __future__ import annotations

BOSSES: list[dict] = [
    {
        "id": "smoke-courier",
        "name": "The Smoke Courier",
        "title": "The message always gets through. You won't.",
        "hp": 120,
        "move_speed": 170,
        "colour": 0x8A6BC9,
        "glyph": "☁",
        "attacks": [
            {
                "id": "shadow-lunge",
                "damage": 12,
                "telegraph_ms": 800,
                "cooldown_s": 4.0,
                "range_px": 220,
                "pattern": "lunge",
            },
            {
                "id": "smoke-bomb",
                "damage": 10,
                "telegraph_ms": 800,
                "cooldown_s": 5.5,
                "range_px": 260,
                "pattern": "aoe_circle",
            },
            {
                "id": "decoy-feint",
                "damage": 0,
                "telegraph_ms": 800,
                "cooldown_s": 7.0,
                "range_px": 200,
                "pattern": "melee",
            },
            {
                "id": "cinder-shiv",
                "damage": 8,
                "telegraph_ms": 800,
                "cooldown_s": 2.5,
                "range_px": 90,
                "pattern": "melee",
            },
        ],
        "tactics": [
            {
                "id": "relentless-pressure",
                "description": "Stay glued to the hero, chain lunges and shivs, give no room to breathe.",
            },
            {
                "id": "bait-and-punish",
                "description": "Flash decoy feints to waste the hero's dash, then punish with a real lunge.",
            },
            {
                "id": "bomb-carpet",
                "description": "Fall back and carpet the arena with smoke-bomb zones, herd the hero into corners.",
            },
        ],
        "taunt_voice": [
            "Special delivery — and it's all for you, hero!",
            "Blink and I'm gone. Blink twice and you're dizzy.",
            "That dash has footprints, hero. I read them like mail.",
        ],
        "enrage": {
            "phase_below_pct": 30,
            "speed_mult": 1.3,
            "damage_mult": 1.25,
            "taunts": [
                "No more games, hero — express shipping!",
                "You tore the wrapping. Now comes the storm!",
            ],
        },
    },
    {
        "id": "cinderjaw",
        "name": "Cinderjaw",
        "title": "It napped in volcanoes. It woke up cranky.",
        "hp": 200,
        "move_speed": 90,
        "colour": 0xE0572B,
        "glyph": "▲",
        "attacks": [
            {
                "id": "fire-breath",
                "damage": 14,
                "telegraph_ms": 800,
                "cooldown_s": 6.0,
                "range_px": 260,
                "pattern": "cone",
            },
            {
                "id": "magma-slam",
                "damage": 16,
                "telegraph_ms": 800,
                "cooldown_s": 5.0,
                "range_px": 180,
                "pattern": "aoe_circle",
            },
            {
                "id": "fireball",
                "damage": 10,
                "telegraph_ms": 800,
                "cooldown_s": 3.5,
                "range_px": 420,
                "pattern": "projectile",
            },
            {
                "id": "skyfire-rain",
                "damage": 12,
                "telegraph_ms": 800,
                "cooldown_s": 6.0,
                "range_px": 320,
                "pattern": "aoe_circle",
            },
        ],
        "tactics": [
            {
                "id": "cornering",
                "description": "Waddle the hero toward walls with breath and slam, shrink the safe floor.",
            },
            {
                "id": "barrage",
                "description": "Stand off and spam fireballs at mid range, punish approaches.",
            },
            {
                "id": "aerial-bombardment",
                "description": "Take flight (below 50% HP): stay airborne, rain skyfire zones, rarely land.",
            },
        ],
        "taunt_voice": [
            "Little hero, well done — nicely toasted on both sides.",
            "I sneezed whole armies away. You are one sneeze, hero.",
            "Flap those feet! The floor is lava-ish. Mostly lava.",
        ],
        "flight_at_pct": 50,
        "enrage": {
            "phase_below_pct": 30,
            "speed_mult": 1.2,
            "damage_mult": 1.3,
            "taunts": [
                "MY SKY NOW, hero! Count the falling stars!",
                "Burn bright, little spark — I eat sparks!",
            ],
        },
    },
    {
        "id": "briar-knight",
        "name": "The Briar Knight",
        "title": "It counts your swings. Swing wisely.",
        "hp": 160,
        "move_speed": 120,
        "colour": 0x3FA34D,
        "glyph": "✦",
        "attacks": [
            {
                "id": "thorn-combo",
                "damage": 11,
                "telegraph_ms": 800,
                "cooldown_s": 4.5,
                "range_px": 130,
                "pattern": "melee",
            },
            {
                "id": "riposte-stance",
                "damage": 10,
                "telegraph_ms": 800,
                "cooldown_s": 8.0,
                "range_px": 110,
                "pattern": "melee",
            },
            {
                "id": "thorn-wall",
                "damage": 10,
                "telegraph_ms": 800,
                "cooldown_s": 7.0,
                "range_px": 300,
                "pattern": "summon",
            },
            {
                "id": "binding-lunge",
                "damage": 12,
                "telegraph_ms": 800,
                "cooldown_s": 5.0,
                "range_px": 230,
                "pattern": "lunge",
            },
        ],
        "tactics": [
            {
                "id": "patient-counter",
                "description": "Hold riposte stance, let the hero mash into it, reflect their haste back at them.",
            },
            {
                "id": "aggressive-combo",
                "description": "Press with thorn combos and lunges when the hero turtles or retreats.",
            },
            {
                "id": "wall-herd",
                "description": "Raise thorn walls to split the arena, herd the hero into combo range.",
            },
        ],
        "taunt_voice": [
            "Swing, swing, little hero. My thorns keep count.",
            "Patience is a whole garden, and you just walked into it.",
            "That button-mashing tickles. Shall I tickle back?",
        ],
        "enrage": {
            "phase_below_pct": 30,
            "speed_mult": 1.25,
            "damage_mult": 1.25,
            "taunts": [
                "The garden closes in, hero — no path out!",
                "Every thorn remembers that swing. All of them.",
            ],
        },
    },
]

BY_ID: dict[str, dict] = {b["id"]: b for b in BOSSES}


def get_boss(boss_id: str) -> dict | None:
    return BY_ID.get(boss_id)


def tactic_ids(boss_id: str) -> list[str]:
    b = get_boss(boss_id) or {}
    return [t["id"] for t in b.get("tactics", [])]


def phase_for(boss_hp_pct: float) -> str:
    """'enrage' below 30% boss HP, else 'normal'."""
    return "enrage" if boss_hp_pct < 30 else "normal"
