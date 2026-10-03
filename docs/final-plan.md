# THE LAST DESCENT — final design plan

One boss. It is immortal. You have one life.

---

## 1. The thesis

A roguelite with exactly one enemy, **one life, and no win condition.** You kill
it. It gets up. It has become more powerful. You kill it again. Somewhere in the
middle of a fight — or the moment it returns — it *changes shape*.

The hook is not the boss's health bar. It's that **the boss learns you.**

It watches what you actually do — whether you turtle, whether you dash-spam,
whether you only attack after drinking a potion, whether you stand still and
trade hits — and it changes its tactics to punish the thing you just did. It is
immortal, so its memory of you **persists across runs on the device**. Run your
first descent, learn to turtle, and run three later: it opens already holding
the counter to turtling.

That is what the open-source model does here, and it is genuinely not decor:
**the model is the adaptation engine.** It reads a compact profile of the
player's habits plus the run's recap, and returns a tactic, a taunt that names
what just happened, and — critically — **the next form, and when to take it.**
Every kill makes the model smarter about *you* specifically. That is the "AI at
the core" argument, and unlike the earlier ideas it survives the "isn't this just
a rules engine?" question, because the monster's body and the timing of its
transformation are model inferences, not random numbers.

Theme target: **Crawl** (the 2012 roguelike) — gritty stone dungeon, torchlight,
stained stone, no arcade candy. Readable in the dark. Blood is diegetic and
earned: it pools, dries, and builds up across the run until the floor is a
record of your own victories. 13+ / PEGI 12 genre.

---

## 2. The run — one life

This is the spine of the game and it was wrong in the first draft.

- **The player has one life.** When you die, **the run is over.** There is no
  respawn, no retry of the same descent, no second attempt. You start a new run
  from descent 1.
- **The boss is immortal.** It always comes back. Its escalation within a run is
  relentless and endless by design.
- **Between kills you do NOT fully heal.** The HP bar does not refill. Killing
  the boss grants a **potion that restores a portion of your HP** — not all of
  it. Attrition is the run's pressure: a run that goes deep is a run of
  accumulated damage you keep surviving.
- **What resets and what persists:**
  - Player level, stats, and cards: **reset each run.** Every run is a fresh
    build from level 1.
  - Boss power level: **resets each run** (otherwise no run is winnable).
  - **The boss's memory of your habits: persists across runs on the device.**
    This is the one immortal thing besides the boss itself, and it is what makes
    the second run feel different from the first.
  - Best descent reached: persists, shown on the death screen as your record.

The consequence: because death ends everything, the **difficulty governor (§2.4)
is not a comfort feature — it is the difference between a run that reaches
descent 12 and a run that dies at descent 3.** A struggling player must be given
room to recover HP and level up, or the game is unwinnable and unreadable.

---

## 3. What changes, mechanically

### 3.1 The boss — a single creature the model reshapes

One entity, four **forms**, same silhouette language throughout (long, wrong,
too many joints) so every form is recognisably the same monster — just wronger.

| Form | Range | Identity | Kit change |
|---|---|---|---|
| **Crawler** | melee | low, wide, many legs, patient | baseline. Tell, lunges, ground pound |
| **Wraith** | fast | rises to half-float, trailing | ignores ground hazards, blink-strikes, faster tells |
| **Colossus** | slow | rears tall, stone-plated | armoured (flat damage reduction), slams, shockwaves, arena cracking |
| **Hollow** | unpredictable | split silhouette, flickering | shorter/erratic tells, feints, ranged only |

**Gemma decides when it transforms** — not a timer, not a random roll. The model
can return a transform directive with any brain call, and the client honours it
whether it fires:
- **mid-fight** (the model sees you turtling and decides the fight needs a new
  shape), or
- **on return** (the normal case, between descents).

A mid-fight transformation is a set-piece: full-screen flash, health bar resets
to the new form's pool, the arena cracks, and the player has to re-learn the
spacing in seconds. It should be rare enough to feel like an event. The model is
biased toward transforming on return, with a hard client-side rate limit (no more
than one mid-fight transform per fight) so the game stays readable.

Every form carries **visible scars from your last run** — gouges, a missing horn,
a dented shoulder — so it is visibly the same creature you have been killing for
an hour.

### 3.2 The learning system — three tiers

**Tier 1: the attempt log.** Every *fight* records `{descent, form, outcome,
time, damage_taken_source, damage_dealt, player_pattern, hp_at_start,
hp_at_end}`. Kept in `localStorage`, capped at the last 60 fights. This is the
raw memory and it survives the run ending.

**Tier 2: habit counters.** Derived from the log by the client (no model tokens
spent on arithmetic):
- `turtle_ratio` — dash/guard used defensively vs offensively
- `dash_spam` — dashes per minute vs effective dashes
- `potion_timing` — average HP at which potions are used
- `attack_range_pref` — mean distance at which the player attacks
- `stationary_ratio` — fraction of the fight spent not moving
- `opener` — what the player does in the first 3 seconds
- `death_causes` — histogram of what actually killed you

**Tier 3: the model call.** On each brain tick (~8s, plus descent transitions) the
client POSTs a compact summary (~250 tokens): current form, habit counters,
recent damage sources, the player's stat build, the descent level, and HP state.
The model returns:

```json
{"tactic_id": "...", "taunt": "...", "next_form": "wraith",
 "transform_now": false, "intensity": 0.7,
 "read": "you turtle and dash-spam; it will hold ground and bait the dash"}
```

`read` is surfaced to the player on the death screen and on descent cards:
*the boss's read on you.* Showing it is a deliberate choice — it makes the
learning legible instead of mysterious, and it is the strongest thing in the
write-up.

`next_form` and `transform_now` are what make the model structurally load-bearing:
the monster's body and the timing of its transformation depend on a model
inference.

**Tolerant validation, rule-based fallback** (already the established discipline
in this codebase): an illegal form, an illegal tactic, or a taunt that trips the
blocklist is discarded and retried once, then replaced by a deterministic rule
choice. The game must never 500 and never freeze on a bad model reply.

### 3.3 The player build — stat drafting on level-up

Player starts level 1, HP 100, EXP 0.

- **EXP is granted relative to the current threshold**, not derived from raw
  damage numbers: each fight grants roughly 60–90% of a level threshold (+25%
  kill bonus), and time-survived EXP is capped at ~90s per fight so dying or
  idling is never the optimal grind.
- On level-up the game **pauses** and offers **3 cards** drawn from a pool of 6,
  the draw weighted toward countering the boss's current form:

| Card | Effect |
|---|---|
| **Vigour** | +25 max HP (and heals that amount) |
| **Edge** | +3 melee damage |
| **Swiftness** | **−10% attack cooldown (multiplicative, floor 0.3s)** |
| **Marrow** | +1 dash charge, −0.5s dash cooldown |
| **Stone Skin** | −1 to all damage taken (floor 1) |
| **Bloodlust** | +40% EXP, but −8 max HP |

**Why cooldown cards are multiplicative.** DPS is damage ÷ cooldown, so a
percentage cooldown reduction scales multiplicatively while a flat `+3 damage`
does not. This is not cosmetic: with flat cards the player provably cannot keep
up with multiplicative boss HP growth past ~descent 38, so the game asymptotes to
"you are now too weak to matter" rather than "you are challenged." Swiftness
multiplicative is what makes a mixed build stay viable to roughly descent 45.

**Card tiers at depth.** From descent 12, the draft pool upgrades (Edge → +5,
Vigour → +40 HP) so late cards remain meaningful choices rather than noise.

**Potions scale with the player**, healing `30 + 3% max HP`. Flat 30 heals go
dead around descent 27 and remove the run's only recovery lever exactly when
attrition is the binding constraint.

Cards are the second skill layer: at depth a pure offence build kills in seconds
and cannot survive the heavy phase, a pure defence build cannot outpace the
escalation. Mixed builds are the survivable ones.

### 3.4 Escalation — the descent meter and the governor

Boss scale grows with descent level: **+6% max HP per level, +5% damage, +2%
speed** (speed hard-capped — the boss must never outrun the player).

**Descent is per-run.** Kills within a run raise it; death records your deepest
descent and resets to 1. This is required, not cosmetic: pairing a level-1 fresh
build with a 13× HP boss is unwinnable by construction, and with one life per
run that would hard-wall every player on their second attempt.

**The descent increment is governed** — the boss "recovers" when you barely win:

```js
// on kill, at descent d:
const par     = 90 + 4 * d;                    // par seconds for the fight
const speed   = clamp(par / fightSecs, 0, 1);  // 1 = met par
const clean   = hpLeftPct / 100;
d += clamp(1 + Math.round(speed + clean), 1, 3);   // +1..+3 per kill
deathStreak = 0;

// on death (run ends):
deathStreak++;
// mercy: 3 straight deaths → next run's first boss HP pool ×0.85
// (one lever, non-stacking, resets on any kill)
```

A clean, fast fight advances you up to 3 descents. A scrappy, near-death win
still advances you, but slower — which is what keeps a one-life run survivable
for a new player. This is the anti-frustration governor and with one life it is
load-bearing, not a comfort feature.

**Escalation is always announced.** Every descent shows a "DESCENT n" card with
what changed — harder form, new attack, faster tells, and the boss's read on
you. The player must never be able to ask "why did it get worse?" without an
answer on screen.

**The constants live in one tunable block** (`src/bossfight/balance.py`) and the
one runnable check is a crossover assertion: for a matrix of representative
builds, `TTK(d=30) / TTK(d=0)` must land in `[0.8, 2.5]`. Numbers before content —
that test is what stops the escalation diverging in either direction, and it is
the failure that is otherwise only discoverable by playtesting 30-deep runs.

### 3.5 Combat loop

- Player: melee 8 dmg / 0.6s, dash w/ 0.25s i-frames / 4s, special 25 / 12s,
  potion 30. Boss attacks are telegraphed ground decals (0.8s windup), plus
  feints, shockwaves, and ranged patterns that punish standing still.
- Dash i-frames are the skill expression. Positioning around telegraphed zones
  is the skill ceiling.
- **Boss attack kits are form-specific**, so each form genuinely plays
  differently rather than reskinning the same three moves.

---

## 4. Arena and assets — what must be made

Everything is **procedural** (built in code), no downloaded art. Three.js pinned
and vendored — already in place.

| Asset | How it's made | Notes |
|---|---|---|
| Dungeon floor | procedural stone texture drawn once to a canvas | rough grey-brown stone, not flat green |
| Torch light | warm point lights + strong ambient falloff | darkness is the medium; rim-light the fighters so they stay readable |
| Blood decals | canvas-drawn splatter + pooling, placed per hit/death | pools, dries, darkens; capped ~24, oldest evicted, cleared per run |
| Boss forms | procedural low-poly, **scarred geometry** | one mesh per form, scars as geometry, all <300 tris |
| Player | existing capsule + scar overlays | |
| Particles | pooled dust/ember/blood-mist | capped, pooled, no per-frame allocation |
| Damage text | DOM pops | as now |

**Explicitly not doing** (scope): skeletons, environment maps, real-time shadows
(blob-shadow cheat stands), post-processing.

---

## 5. Audio — deliberately deferred

Procedural sound (WebAudio) would add life but is a scope sink that blocks on
nothing. Deferred to post-submission and flagged honestly in the write-up as a
known gap. If there is time at the end, three procedural sounds (impact,
hit-taken, level-up) are a cheap add.

---

### 3.6 Model call discipline — one in flight, never stale

An 8s tick against a 6–23s call means requests pile up, arrive out of order, and
carry stale snapshots; 50–90 calls a session also invites 429s. The design:

- **One request in flight.** On receipt, immediately fire the next one
  (fetch-next-on-receive). Never more than one outstanding.
- **Sequence guard.** Every request carries a monotonic `seq`; a reply is applied
  only if `seq` is newer than the last applied one, so a slow response can never
  overwrite fresher state.
- **Load-bearing decisions move to the between-fight window.** The form choice and
  tactic weighting are requested on the descent transition and during the death
  screen and card draft — UI that is already paused, so a 23s call costs the
  player nothing. In-fight calls drop to 2–3 per fight (fight start + a form
  change), and in-fight ticks become optional taunt/intensity enrichment with the
  rule-based floor always live.

This is what makes "the AI controls the boss" true without ever making the player
wait on a model.

### 3.7 The model must be structurally load-bearing

A bare `{tactic_id, taunt}` reply is a 3-way classifier over client arithmetic —
`stub_decide` already reproduces 90% of that with no model at all, which is the
proof that the current design is thin. The response therefore returns **weights,
not a single label**:

```json
{"tactics": {"pressure": 0.6, "bait": 0.3, "bombs": 0.1},
 "next_form": "wraith", "transform_now": false,
 "open_with": "shadow-lunge", "taunt": "...", "read": "..."}
```

The client samples from those weights per tick, so the model's contribution is a
continuous per-player bias rather than a discrete pick. The check that it is
real: **replacing the model with the stub must visibly change how the fight
plays.** If it does not, the model is decoration and the write-up should not
claim otherwise.

### 3.8 Contract changes that must land in the same commit as the client

Silent-failure hazards, all fixed atomically with the client that depends on them:

- `BrainFields` currently parses only `tactic_id`/`taunt`/`intensity`. **`next_form`
  and `read` would be discarded before the game ever saw them** — the game would
  run, the learning would appear to work, and nothing model-driven would happen.
- `BrainRequest.player_style` is a constrained enum that **422s any habit-rich
  payload**. Replace with `habits: dict[str, float]` (optional, defaults `{}`).
- `stub_decide` must return the same shape, or stub-mode tests prove nothing.
- `safety.py` and the brain persona still say *"kids' game, opponents FAINT,
  never die"* and the blocklist bans the very words the new game needs. Rewrite
  to the Crawl register in the same pass; keep the blocklist's function (no
  real-world harm framing, nothing aimed at the player as a person) while
  permitting in-fiction combat language. Say "what put you down", not "what
  killed you", and let the gore live in the arena rather than the dialogue.

---

## 6. Architecture — what is kept vs rebuilt

**Kept entirely** (already written, tested, and correct):
- `providers.py` — Gemini + DeepInfra failover, thinking-off fix, semaphore,
  backoff. The gem itself.
- `safety.py` — taunt blocklist and character-safety rules, now governing a
  *gory* game's dialogue. Unchanged and still binding: with full gore permitted,
  the blocklist is the only thing standing between a language model and something
  a 13+ submission should not ship.
- Brain endpoint shape, retry-once-then-fallback, stub mode.
- The Three.js scene scaffold, procedural fighter builders, telegraph decal
  system, particles, DOM HUD, keyboard + touch input.

**Rebuilt:**
- `bosses.py` → single boss with 4 form definitions and form-specific kits, plus
  transform directives.
- Arena: dungeon floor + torches + blood decals.
- Progression: XP, level, card draft, per-run HP attrition, potion economy.
- Learning: attempt log, habit counters, model-informed form selection, and the
  `read` surface.
- HUD: descent meter, level/XP bar, card-draft screen, best-descent record,
  death screen with the boss's read.

---

## 7. Judge-proofing (non-negotiable, from experience)

- Every model call is validated and falls back to a rule-based tactic and form —
  a fight must survive a dead, slow, or malformed model.
- Health endpoint touches nothing.
- A full stub-mode run must complete at least two descents with zero network
  calls (for tests and for the "works offline" claim).
- Tests must cover: learning counters, form selection from the model response,
  mid-fight transform rate limit, level-up draft, attrition/potion economy, blood
  decal cap, and the fallback path.

---

## 8. The write-up frame

The honest, differentiated angle — what judges will actually read:

> A roguelite with one enemy, one life, and no win state, where the enemy's only
> real mechanic is that **it learns your habits, reshapes itself against them,
> and remembers across runs.** The open model is not dialogue garnish — it is
> the adaptation engine: it reads a habit profile, returns a tactic, a taunt,
> and the monster's next body and timing, and it gets better about you every time
> you die. The difficulty governor scales to competence, so a one-life run is
> hard without ever being cheap.

Nothing else in the challenge field (study buddies, meal planners, toolkits) is
doing this, and it is provable in the code.

---

## 9. Implementation order — risk first, content last

The three deadline burners, in the order they must be defused. Content is
explicitly last; the escalation math is only discoverable by playtesting
30-deep runs we will not have time for.

1. **`refactor(arena): make combat state mutable and pausable`** — `F.cfg.hp`
   → `F.maxHp`, `PLAYER` → mutable `F.stats`, and a `paused` flag checked in
   `update()` and every `later()` telegraph resolution. Without this the card
   draft screen does not stop the world, attacks land while the game is paused,
   and HP reads garbage after a mid-fight transform. Do it first; keep the test
   suite green as the tripwire.
2. **`feat(contract): extend the brain contract for form, read and weights`** —
   `BrainFields`/`BrainResponse`/`stub_decide` together, `player_style` →
   `habits: dict[str,float]`, `seq` echoed and applied-if-newer, rules fallback
   for an illegal form. Must ship atomically with the client that reads it.
3. **`feat(balance): add the tunable constants block and the crossover test`** —
   `src/bossfight/balance.py` plus the `TTK(30)/TTK(0) ∈ [0.8, 2.5]` assertion
   over a build matrix. Numbers before content.
4. `refactor(boss): collapse three bosses into one transforming entity`
5. `feat(progress): descent meter, xp, level-up draft, attrition`
6. `feat(learning): attempt log, habit counters, model-driven form choice`
7. `feat(arena): dungeon floor, torches and accumulating blood decals`
8. `feat(ui): descent hud, draft screen and the boss-reads-you death screen`
9. `test: cover learning, drafting, attrition and the model fallback path`

Each is independently revertable, and the history tells the story of the build.

### Scope cuts, in order (cut from the bottom up if time runs out)

1. **Hollow form** — erratic-tell tuning is the highest-risk, lowest-return kit.
   Three forms still show the transform mechanic.
2. **Per-form full kits → weighted shared patterns + one signature move per
   form.** Weights, not new pattern types.
3. **Scarred geometry per form → palette and silhouette swap.**
4. **Blood dry-over-time and darkening → static splats under the existing 24-cap**
   (the crack-decal path in `arena.js` already exists; reuse it).
5. **Hero scar overlays → a scar counter number.**
6. **Cards 6 → 4** if the draft screen lags.

Keep regardless of time: the form transform, the learning, the descent
governor, and the death-screen read. Those are the thesis.

---

## 10. Decisions taken

| Question | Answer |
|---|---|
| Blood | Full gore. Blocklist rewritten to the Crawl register, still blocking real-world harm framing. |
| Life model | **One life.** Death ends the run. Boss is immortal and always returns. |
| Healing | **No full heal between kills** — a potion restores a portion; HP attrition is the run's pressure. |
| Persistence | Player build resets each run. **The boss's memory of your habits persists across runs**, plus your best depth. |
| Forms | All four; **Gemma decides when to transform**, mid-fight or on return (one mid-fight transform per fight, rate-limited). |
| Show the learning | Yes — "the boss reads you" is surfaced to the player. |
| Descent | Per-run. Death records deepest depth and resets. |
| Escalation | Boss HP +6%/level, damage +5%, speed +2% (capped). Player scaling is multiplicative (cooldown). |

---

## 3. Arena and assets — what must be made

Everything is **procedural** (built in code), no downloaded art. Three.js,
pinned, vendored — already in place.

| Asset | How it's made | Notes |
|---|---|---|
| Dungeon floor | procedural stone texture drawn once to a canvas | rough grey-brown stone, not flat green |
| Torch light | 2–3 warm point lights + strong ambient falloff | the darkness is the point; keep fighters readable via rim light |
| Blood decals | canvas-drawn splatter, placed per hit/death | diegetic, accumulates, capped ~24, dry over time |
| Boss forms | procedural low-poly, **scarred geometry** | one mesh per form, scars as decal-ish geometry, all <300 tris |
| Player | existing capsule, plus scar overlays | |
| Particles | pooled dust/ember/blood-mist | capped, pooled, no per-frame allocs |
| Damage text | DOM pops | as now |

**Explicitly not doing** (scope): skeletons, textured environment maps,
real-time shadows (blob-shadow cheat stands), post-processing.

---

## 4. Audio — deliberately deferred

Procedural sound (WebAudio) would add a lot of life but it is a scope sink and
it blocks on nothing. Deferred to post-submission. Flagged honestly in the
write-up as the known gap. If there is time at the end, three procedural sounds
(impact, hit-taken, level-up) are a cheap add.

---

## 5. Architecture — what is kept vs rebuilt

**Kept entirely** (already written, tested, and correct):
- `providers.py` — Gemini + DeepInfra failover, thinking-off fix (6–23s ticks), semaphore, backoff. The gem itself.
- `safety.py` — taunt blocklist and character-safety rules. Unchanged and still binding (the taunt is where a language model could go wrong around a 13+ player; blocklist stays).
- Brain endpoint shape, retry-once-then-fallback, stub mode. The fallback-to-rules discipline is the reason a demo never 500s.
- Three.js vendored library, importmap, the whole Three.js scene scaffold, procedural fighter builders, telegraph decal system, particles, DOM HUD.

**Rebuilt:**
- `bosses.py` → single boss with 4 form definitions and form-specific kits.
- Arena: dungeon floor + torches + blood decals (new).
- Progression: XP, level, card draft, scars (new).
- Learning: attempt log, habit counters, model-informed form selection (new).
- HUD: descent meter, level/XP bar, card-draft screen, scar counter (new).
- Death screen: boss's read on you + the taunt that killed you + form-change notice.

**Estimated diff:** comparable to the 2D→3D rebuild that just landed. Not a from-scratch project; the hard parts (model layer, 3D scene) already exist and are tested.

---

## 6. Judge-proofing (non-negotiable, from experience today)

- Every model call is validated and falls back to a rule-based tactic — the fight must survive a dead, slow, or malformed model. Already true; must stay true through the rewrite.
- Health endpoint touches nothing.
- Full stub-mode playthrough must complete at least one descent with zero network calls (for tests and for the "it works offline" claim).
- Test suite must cover: learning counters, form selection from the model response, level-up draft, scar accumulation, blood-decay cap, and the fallback path. Keep the existing 11 green.

---

## 7. The write-up frame (for the DEV post)

The honest, differentiated angle — this is what judges will actually read:

> A roguelite with one enemy and no win state, where the enemy's only real
> mechanic is that **it learns your habits and changes to punish them.** The
> open model is not dialogue garnish — it is the adaptation engine: it reads a
> habit profile, returns a tactic and the monster's next form, and gets better
> about you every time you die. The difficulty governor scales to competence so
> it never cheap-runs you and never hard-walls you.

That is a real claim, provable in the code, and nothing else in the challenge
field (study buddies, meal planners, toolkits) is doing it.

---

## 8. Commit plan (scoped, no push, per your instruction)

- `refactor(boss): collapse three bosses into one transforming entity`
- `feat(progress): add descent meter, xp, level-up draft and scars`
- `feat(learning): add attempt log, habit counters and model-driven form choice`
- `feat(arena): dungeon floor, torches and accumulating blood decals`
- `feat(ui): descent hud, draft screen and the boss-reads-you death screen`
- `test: cover learning, drafting, scars and the model fallback path`

Each is independently revertable and the repo tells the story of the build.

---

## 9. Open questions before I write code

1. **Blood, confirmed.** I have taken "do not shy away from blood" as full
   licence for diegetic gore — blood pools, blood-mist on hits, a bloody arena
   that darkens across the run — while keeping the safety blocklist (no
   real-world harm framing, no taunts aimed at the player as a person) since the
   game still ships under a 13+ framing for the write-up. Confirm that's the
   line, or tell me if you want the blocklist relaxed further.
2. **Scar economy — permanent HP loss per death.** This is the harshest and
   most interesting mechanic, but it's also the one most likely to frustrate.
   Keep it, soften it (scars visual-only), or make it opt-in?
3. **Forms: four, or two to start?** Four is a better showcase; two ships
   sooner. Given ~48h of runway, I lean four.
4. **Do you want the "boss reads you" line shown to the player**, or should the
   learning stay invisible (harder, purer)? Showing it makes the AI legible and
   is better for the write-up; hiding it makes the game scarier.

Answer 1–4 and I'll start on the refactor commit immediately.
