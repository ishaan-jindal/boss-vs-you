# THE LAST DESCENT — final design plan

One boss. No victory. You get up. It remembers.

---

## 1. The thesis

A roguelite with exactly one enemy and **no win condition**. Every time you kill
it, it gets up stronger. The only question is how deep you get.

The hook is not the boss's health bar. It's that **the boss learns you.**

It watches what you actually do — whether you turtle, whether you dash-spam,
whether you only attack after drinking a potion, whether you stand still and
trade hits — and it changes its tactics to punish the thing you just did. It
remembers across runs on your device. Die the same way twenty times and the
twenty-first attempt opens with that exact tactic waiting for you.

That is what the open-source model does here, and it is genuinely not decor:
**the model is the adaptation engine.** It reads a compact profile of the
player's habits plus the last attempt's recap, and returns a tactic, a taunt
that names what just killed you, and a form-suggestion. Every kill makes the
model smarter about *you* specifically. That is the "AI at the core" argument,
and unlike the earlier ideas it survives the "isn't this just a rules engine?"
question, because the per-player tactic weighting and the taunts are generated.

Theme target: **Crawl** (the 2012 roguelike) — gritty stone dungeon, torchlight,
stained stone, no arcade candy. Readable in the dark. Blood is diegetic and
earned: stains appear, dry, stay, and build up across the run. 13+ / PEGI 12
genre, written up for a 17-year-old.

---

## 2. What actually changes, mechanically

### 2.1 The boss — a single creature that transforms

One entity, four **forms**. Same silhouette language throughout (long, wrong,
too many joints) so every form is recognisably the same monster. Forms are
selected by the model between runs, weighted by how the player fights.

| Form | Range | Identity | Kit change |
|---|---|---|---|
| **Crawler** | melee | low, wide, many legs, patient | baseline. Tell, lunges, ground pound |
| **Wraith** | fast | rises to half-float, trailing | ignores ground hazards, blink-strikes, faster tells |
| **Colossus** | slow | rears tall, stone-plated | armoured (flat damage reduction), slams, shockwaves, arena cracking |
| **Hollow** | unpredictable | split silhouette, flickering | shorter/erratic tells, feints, ranged only |

The transformation is a hard cut: health resets to the new form's pool, the
model re-weights tactics for the new kit, and the screen says what changed.
Every form carries **visible scars from your last run** — gouges, a missing
horn, a dented shoulder — so it is visibly the same creature you have been
killing for an hour.

### 2.2 The learning system — three tiers, all client-computed

**Tier 1: the attempt log.** Every attempt records `{n, form, outcome, time,
damage_taken_source, damage_dealt_source, player_pattern}`. Kept in
`localStorage`, capped at the last 40 attempts. This is the raw memory.

**Tier 2: habit counters.** Derived from the log by the client (no model tokens
on arithmetic):
- `turtle_ratio` — guard/dash used defensively vs offensively
- `dash_spam` — dashes per minute vs effective dashes
- `potion_timing` — average HP at which potions are used
- `attack_range_pref` — mean distance at which the player attacks
- `stationary_ratio` — fraction of the fight spent not moving
- `opener` — what the player does in the first 3 seconds
- `death_causes` — histogram of what actually killed them

**Tier 3: the model call.** On each new attempt the client POSTs a compact
summary (~250 tokens): current form, habit counters, last three death causes,
the player's stat build, and the descent level. The model returns:

```json
{"tactic_id": "...", "taunt": "...", "next_form": "wraith",
 "intensity": 0.7, "read": "you turtle and dash-spam; it will hold ground
 and bait the dash"}
```

`read` is shown to the player on the death screen: *the boss's read on you.* That
is the feature's soul — it makes the learning legible instead of mysterious.

The `next_form` suggestion is what makes the model structurally load-bearing: the
monster's body depends on a model inference, not a random number.

### 2.3 Escalation — the descent meter

Both sides grow forever, so the *ratio* is the only thing that matters.

- **Boss scale** grows with descent level: +~9% max HP per level, +~5% damage,
  +~2% speed (speed capped hard — it must never outrun the player).
- **Descent level** increments on each kill. It increments **faster if the
  player is winning cleanly** (short fight, little damage taken) and **stalls if
  the player is struggling** (dying repeatedly). This is the anti-frustration
  governor: difficulty tracks competence, so a skilled player races upward and a
  struggling player gets breathing room to build stats. Without this, a new
  player hard-stalls at descent 1 forever and a good player outruns the content
  in ten minutes.
- **Escalation is announced.** Every descent level shows a "DESCENT n" card with
  what changed (harder form, new attack, faster tells). The player must always
  know why it got worse.

### 2.4 The player build — stat drafting on level-up

Player starts level 1, HP 100, EXP 0.

- **EXP** from damage dealt, time survived, and boss damage absorbed. Level-up
  thresholds grow ~12% each level.
- On level-up the game **pauses** and offers **3 cards** drawn from a pool of 6,
  the draw weighted toward countering the boss's current form. Example pool:

| Card | Effect |
|---|---|
| **Vigour** | +25 max HP (heal the difference) |
| **Edge** | +3 melee damage |
| **Swiftness** | −0.8s attack cooldown |
| **Marrow** | +1 dash charge, −0.5s dash cooldown |
| **Stone Skin** | −1 to all damage taken (floor 1) |
| **Bloodlust** | +40% EXP, but −8 max HP |

Cards are not cosmetic: at descent 20, a build of Edge/Swiftness kills a boss in
6 seconds and a build of Stone Skin/Vigour can tank its heavy phase. **The build
IS the difficulty slider**, and since the boss escalates forever, the player
needs a build that can keep scaling — so mixed offence/defence cards are the
survivable ones. That tension is the run's second skill layer.

### 2.5 Scar economy — permanent, per device

Every death leaves a scar on the player, visible in the arena, cumulative on the
device:
- Each death: −1 permanent max HP (floor 50) and one visual scar on the hero.
- Every 5th death the boss levels up its base damage by +2 (permanent, on
  device).

This creates real long-arc tension: dying costs you *permanently*, so the game
becomes a genuine "how far can I push before I ruin my own run" — and it gives
the dev-facing write-up something honest to talk about. A `# ponytail:` comment
will name the ceiling: single-device, single-player, no reset button except
"erase all scars" in the menu (deliberately buried and confirmed).

### 2.6 Combat loop (unchanged kit, deeper tuning)

- Player: melee 8 dmg / 0.6s, dash w/ i-frames 4s, special 25 / 12s, potion 30
  ×2. Boss attacks are telegraphed ground decals (0.8s windup), plus feints,
  shockwaves, and ranged patterns that punish standing still.
- Dash i-frames are the skill expression. Positioning around telegraphed zones
  is the skill ceiling.
- **Boss attack kits become form-specific**, so each form genuinely plays
  differently rather than reskinning the same three moves.

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
