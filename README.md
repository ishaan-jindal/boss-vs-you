# BOSS vs YOU

A real-time pixel-dungeon boss battler. You descend, room by room, against **one transforming boss played by an LLM** — and it learns your habits across runs to hunt you better.

**Play it live: https://boss-vs-you.onrender.com** (free tier — first load takes ~50s to wake up).

- **Room-clear descent loop** — every descent is a cramped gothic room: kill the minions, crack the boss phase, draft a card, go deeper.
- **A boss with a brain** — Gemini (DeepInfra failover, deterministic stub offline) picks tactics, forms, and minion spawns. Never a 500: every failure lands on the rule-based stub.
- **It learns you** — your last 60 fights (turtle ratio, dash spam, potion timing, range preference, death causes) feed the boss's prompt.
- **Punish-window combat** — telegraphed windups, vulnerable slumps, lunge, dash i-frames, ranged special, 2 potions refilled every room.
- **Procedural everything** — pixel sprites, Web Audio SFX + ambient drone, no assets, no bundler, no build step.

## Quickstart

Requires Python ≥ 3.12.

```sh
uv sync
uv run uvicorn bossfight.app:app --reload
# open http://127.0.0.1:8000
```

No API keys needed to play — without `GEMINI_API_KEY` / `DEEPINFRA_API_KEY`
the boss runs on its deterministic stub brain. Set them (via env or `.env`)
for the model-driven boss:

```sh
GEMINI_API_KEY=...       # primary brain
DEEPINFRA_API_KEY=...    # failover brain
```

## Controls

| Input | Action |
|---|---|
| WASD / arrows / stick | Move (8-dir) |
| J | Attack |
| L | Special (ranged bolt) |
| K | Dash (i-frames, goes where you walk) |
| U | Potion (2 refilled every room) |
| Esc / P | Pause menu |
| M | Mute |

## API

| Route | Notes |
|---|---|
| `GET /health` | Uptime probe (Render healthcheck) |
| `GET /api/bosses` | Boss roster, forms, attack telegraphs |
| `GET /api/balance` | Tuning numbers (Python is ground truth) |
| `POST /api/brain` | Brain decision; additive-optional minion/spawn fields |

The server is stateless — the client sends full fight state per brain call.
Persistence (best descent, run history, habit profile) lives in browser
localStorage (`bvy.*`).

## Tests

```sh
.venv/bin/python -m pytest -q   # 93 passed
```

`tests/test_parity.py` pins the Python↔JS mirrored formulas — retune both
sides in the same commit.

## Deploy

Docker → Render (`Dockerfile`, `render.yaml`). Set the two API keys in the
Render dashboard, never in the repo.

## License

MIT — see [LICENSE](LICENSE).
