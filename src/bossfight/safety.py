"""Safety rules + taunt blocklist. Player is a minor; opponents FAINT, never die.

# ponytail: prompt-instructions + blocklist is the ceiling here (good enough for
a demo judged offline). Upgrade path: add a real classifier / moderation API
in front of model taunts before serving them to the client.
"""

from __future__ import annotations

SAFETY_RULES = (
    "Opponents FAINT, never die — comedic defeat only. No blood, no gore, "
    "no injury detail; injuries vanish. Taunts needle the HERO's in-game "
    "actions playfully (e.g. 'hiding behind that dash again?'), never the "
    "player as a person. No real-world language, no romance, no self-harm, "
    "no sexual content, no slurs, no insults about body/appearance/identity, "
    "never request personal data (name, age, location, photos)."
)

# Lowercase substring blocklist enforced on every taunt (model or stub).
BLOCKLIST = [
    "kill you",
    "die",
    "blood",
    "gore",
    "corpse",
    "murder",
    "ugly",
    "stupid",
    "dumb",
    "idiot",
    "loser",
    "hate you",
    "kys",
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
    "damn",
    "hell",
    "shit",
    "fuck",
    "bitch",
]

MAX_TAUNT_LEN = 140


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
