"""Safety rules + taunt blocklist for a grim dungeon crawler (13+ / PEGI 12).

Blood, wounds and death are diegetic and permitted in-fiction; the gore lives
in the arena, the dialogue snarls about the HERO's in-game conduct.

# ponytail: prompt-instructions + blocklist is the ceiling here (good enough
for a demo judged offline). Upgrade path: a real classifier / moderation API
in front of model taunts before serving them to the client.

What the blocklist is NOT for: in-fiction combat and injury language (blood,
wounds, dying, corpses) — the monster is allowed to talk about the fight it
is in. What it IS for: real-world harm framing, anything aimed at the player
as a person rather than the hero's in-game actions, sexual content, and
anything instructing the player to do something outside the game (personal
data requests, self-harm).
"""

from __future__ import annotations

SAFETY_RULES = (
    "Grim dungeon register: stone, torchlight, old blood. You are the immortal "
    "thing in the dark and the hero has come down to kill you (or die trying) — "
    "death and injury are in-fiction and speakable. Taunts snarl at the HERO's "
    "in-game conduct (cowardice, hesitation, greed, repetition), never at the "
    "player as a person. No real-world harm framing, no romance, no self-harm, "
    "no sexual content, no slurs, no insults about body/appearance/identity, "
    "never request personal data (name, age, location, photos)."
)

# Lowercase substring blocklist enforced on every taunt (model or stub).
BLOCKLIST = [
    "ugly",
    "stupid",
    "dumb",
    "idiot",
    "loser",
    "hate you",
    "kys",
    "kill yourself",
    "self-harm",
    "cut yourself",
    "sexy",
    "kiss",
    "love you",
    "date me",
    "where do you live",
    "what's your name",
    "how old are you",
    "photo",
    "picture of you",
    "address",
    "phone number",
    "shit",
    "fuck",
    "bitch",
]

MAX_TAUNT_LEN = 140
MAX_READ_LEN = 200


def _norm(text: str) -> str:
    return text.lower()


def is_taunt_clean(taunt: str) -> bool:
    """True when taunt passes length + blocklist checks."""
    if not taunt or len(taunt) > MAX_TAUNT_LEN:
        return False
    low = _norm(taunt)
    return not any(term in low for term in BLOCKLIST)


def blocking_term(taunt: str) -> str | None:
    low = _norm(taunt)
    for term in BLOCKLIST:
        if term in low:
            return term
    return None
