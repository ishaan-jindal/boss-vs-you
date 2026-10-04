/* Boss vs You — 3D arena-battler client. Plain JS module, no bundler.
 *
 * One immortal boss, four forms, no win condition. The menu goes straight
 * into descent 1; a kill is a descent transition (new form, fresh pool),
 * death ends the run.
 *
 * DESIGNER HOOKS (stable names for a later visual pass):
 * DOM screens: #screen-menu, #screen-end (sections, .active shows),
 *   #screen-draft (level-up pick; driven directly, never via showScreen)
 *   #screen-pause (pause menu; driven directly, never via showScreen)
 * HUD: #hud, #hp-player-fill, #hp-player-num, #hp-boss-fill, #hp-boss-num,
 *   #boss-name, #clock, #descent-badge, #cooldowns, #potion-count, #hint-bar
 * Draft: #draft-title, #draft-sub, #draft-cards (+ .draft-card, .key,
 *   .draft-meta/.draft-name/.draft-fx/.draft-why, .draft-tier)
 * End: #end-kicker, #end-title, #end-flavour, #end-stats (.stat-card),
 *   #end-build, #end-read, #end-ladder, #btn-rematch, #btn-bosses
 * Pause: #btn-resume, #btn-restart, #btn-pause-mute, #btn-quit
 * Controls: #joy-zone (+ #joy-base, #joy-knob), #btn-attack, #btn-special,
 *   #btn-dash, #btn-potion
 * Juice: #arena-canvas, #pop-layer (.pop, .pop.static for reduced-motion),
 *   #taunt-balloon, #taunt-region (role=status), #bv-banner (+ kicker/title/sub,
 *   --splash accent per moment: boss colour, ember flight, red enrage, gold win),
 *   #bv-vignette, #bv-flash
 * 3D: static/arena.js exports createArena (fighters, telegraphs, particles,
 *   dust, crack decals). Impact feel: hitstop freezes update for a beat on
 *   every landed hit (see hitstop()); shake is heavy on purpose; dust and
 *   cracks sell the weight. All comic, never gore: debris and dust only.
 * localStorage: 'bvy.best_descent' (int, deepest descent ever),
 *   'bvy.run_history' (last ≤60 fight records, survives the run — the
 *   attempt log the learning lane reads) and 'bvy.habit_profile' (the
 *   derived summary {counters:{turtle_ratio,dash_spam,stationary_ratio,
 *   potion_timing,attack_range_pref,finish_frac}, lines:{...}, labels:[...],
 *   fights:n, updatedAt:ms} — THIS is what survives death: written on every
 *   kill and every death, loaded on run start so run 2 opens with the boss
 *   already countering run 1). Player stats are NEVER persisted.
 *
 * Combat contract (matches bosses.py numbers exactly):
 * player HP 100, melee dmg 8 @ 0.6s, special 25 @ 12s, dash i-frames 0.25s @ 4s,
 * potion heal 30 x2. Brain ticks every ~8s; tactics arrive as WEIGHTS and
 * are sampled per decision (see sampleTactic); uniform floor until the first
 * reply lands so the boss is never inert.
 *
 * Fight state (F) — single mutable per-run object:
 *   F.stats: live player numbers (maxHp, hp, damage, specialDmg, attackCd,
 *     specialCd, dashCd, dashCharges, dmgReduction, speed, atkRange,
 *     specialRange, potionHeal, potionsLeft, level, xp, descent). Draft
 *     cards mutate these live; nothing caches them elsewhere. F.build is
 *     the run's card-taken list (names, reset each run, shown on death).
 *   F.boss: { form, hp, maxHp } — the current form's live pool, scaled by
 *     descent (see bossHpPool). A transform/return resets form/maxHp/hp
 *     together. F.maxHp aliases F.boss.maxHp. Never use F.cfg.hp for live
 *     math (it is the design-time value).
 *   F.runHistory: in-memory attempt log (mirrored to localStorage, ≤60).
 *   F.transitioning: true between boss-hp-0 and the boss's return, so the
 *     per-frame ending check cannot re-enter killBoss mid-draft.
 *   F.paused: true while any menu/draft/overlay is open. Simulation
 *     (update + all deferred damage) freezes; rendering continues.
 *   F.lastAppliedSeq: seq guard — brain replies with seq <= this are stale.
 *   F.transformedThisFight / F.pendingNextForm: client half of the
 *     one-mid-fight-transform-per-fight rule (see applyBrain).
 */
import { createArena } from './arena.js';
import { sfx, toggle as toggleMute, isMuted } from './sfx.js';

/* single immortal boss: forms arrive from /api/bosses, never hardcoded */
const PX = 1 / 30; // legacy px -> world units (arena ~22 x 16 units)

/* ---------- feel constants (NOT balance — do not tune difficulty here) ----------
 * One block for control feel only. Nothing here changes damage, cooldowns,
 * ranges, potion heals, XP, i-frames, or dash distance — those live in
 * /api/balance and defaultStats(). These shape HOW input maps to motion.
 * Values and why:
 * - STICK_DEADZONE 0.15: below this the stick is rest tremor, not intent.
 * - STICK_EXPO 1.35: response = t^1.35 past the deadzone. Exponent >1 keeps
 *   gain low near center (small corrections precise) while full tilt still
 *   reaches full speed. Slight: 1.0 is linear/twitchy, 2.0+ feels dead.
 * - ACCEL_RATE 9/s: velocity chases input with 1-exp(-rate*dt), so starting
 *   takes ~330ms to 95% — no longer instant, never sluggish.
 *   FRICTION_RATE 14/s (~210ms to stop): higher than accel so releases feel
 *   crisp while starts stay weighty.
 * - TURN_RATE 12 rad/s: a 180° pivot reads as a turn (~260ms), not a snap,
 *   but never lags behind the stick.
 * - DASH_TIME 0.18 / DASH_PEAK 7.6: mirrors of the OLD flat 3.2x dash —
 *   the ease-out integral 1+(PEAK-1)/3 equals 3.2 exactly, so total dash
 *   distance is UNCHANGED (not a retune). I-frames stay 0.25s (balance).
 * - DASH_MAX_FRAC 0.45: safety cap — one dash travels at most 45% of the
 *   arena's short side (~7 units on 22x16; the real dash covers ~4.2, so
 *   this never binds, it just guarantees no build can cross the arena).
 * # ponytail: keyboard + touch stick only; add gamepad polling here if that ever matters. */
const FEEL_STICK_DEADZONE = 0.15;
const FEEL_STICK_EXPO = 1.35;
const FEEL_ACCEL_RATE = 9.0;
const FEEL_FRICTION_RATE = 14.0;
const FEEL_TURN_RATE = 12.0;
const FEEL_DASH_TIME = 0.18;
const FEEL_DASH_PEAK = 7.6;
const FEEL_DASH_MAX_FRAC = 0.45;
/* ---------- tuning (difficulty/bounds feel — single block, UPPER_SNAKE) ----------
 * Breathing room + arena containment. Numbers are gameplay, not rendering.
 * # ponytail: client-side cooldowns, move to server brain tick if multiplayer */
const DASH_COOLDOWN_S = 0.9; // dash refill: 4s left no escape vs adds, 0.9s dodges without spam
const HERO_MAX_SPEED_MUL = 1.0; // velocity cap = stats.speed: input magnitude never boosts
const BOSS_MIN_GAP_S = 1.1; // minimum gap between boss strikes so tells read
const BOSS_SLUMP_GAP_S = 0.15; // +per slump: punishing windows stretch the next gap
const BOSS_WINDUP_FLOOR_MS = 350; // payload windup_ms respected, never below readable tell
const CHASER_COOL_S = 1.8; // chaser contact: 1.2s stun-locked, 1.8s lets you trade
const LOBBER_INTERVAL_S = 4.2; // lobber lob: 3s rained, 4.2s leaves approach lanes
const MINION_GRACE_S = 1.0; // spawn grace: no damage for 1s so spawns never instant-hit
const BOUND_HERO_M = 0.7; // half-sprite margin: hero edge, not center, hits the wall
const BOUND_BOSS_M = 1.0; // half-sprite margin: boss body is wider than hero
const BOUND_MINION_M = 0.7; // half-sprite margin: adds share hero size
const BOUND_PROJ_M = 0.5; // projectiles die at wall face, never fly into the wings
const HERO_SPECIAL_PROJ_SPEED = 340 * PX; // hero special bolt outruns boss lobs (260*PX) so the trade-up reads
const POTIONS_AT_ENTRY = 2; // every room entry resets to 2: attrition across rooms, never a stockpile
const FLOOR_Z_MIN = -5.14; // w2s y=168+z*10.5 hits floor-top 114px here: z below is back-wall UI strip
/* Clamp a ground entity into the playable rect; smallest-penetration first so
 * corners slide instead of sticking (fixing one axis is the minimal push). */
function clampArena(pt, margin, W, H) {
  const minX = -W + margin, maxX = W - margin;
  const minZ = Math.max(-H + margin, FLOOR_Z_MIN), maxZ = H - margin;
  const dxOut = pt.x < minX ? minX - pt.x : pt.x > maxX ? pt.x - maxX : 0;
  const dzOut = pt.z < minZ ? minZ - pt.z : pt.z > maxZ ? pt.z - maxZ : 0;
  if (dxOut > 0 && dzOut > 0) {
    if (dxOut < dzOut) pt.x = pt.x < minX ? minX : maxX; // smallest axis first, then the other
    else pt.z = pt.z < minZ ? minZ : maxZ;
  }
  if (pt.x < minX) pt.x = minX; else if (pt.x > maxX) pt.x = maxX;
  if (pt.z < minZ) pt.z = minZ; else if (pt.z > maxZ) pt.z = maxZ;
  return pt;
}
/* Analog stick response: deadzone then expo, magnitude-preserving (out ≤ 1).
 * Returns a scalar: caller reapplies the stick's direction. */
function stickResponse(m) {
  if (!(m > FEEL_STICK_DEADZONE)) return 0;
  const t = (m - FEEL_STICK_DEADZONE) / (1 - FEEL_STICK_DEADZONE);
  return Math.pow(clamp(t, 0, 1), FEEL_STICK_EXPO);
}
/* Boss tactics: sampled per decision from the brain's weights
 * (weighted random over keys — Math.random against cumulative mass).
 * Until the first reply lands, the uniform floor keeps the boss live. */
const TACTIC_KEYS = ['pressure', 'bait', 'bombs'];
const UNIFORM_TACTICS = { pressure: 1 / 3, bait: 1 / 3, bombs: 1 / 3 };
function sampleTactic(weights) {
  const w = weights || UNIFORM_TACTICS;
  let total = 0;
  for (const k of TACTIC_KEYS) total += Math.max(0, Number(w[k]) || 0);
  if (total <= 0) return TACTIC_KEYS[Math.floor(Math.random() * TACTIC_KEYS.length)];
  let r = Math.random() * total;
  for (const k of TACTIC_KEYS) {
    r -= Math.max(0, Number(w[k]) || 0);
    if (r <= 0) return k;
  }
  return TACTIC_KEYS[0];
}
/* Base player numbers (fresh run, level 1). Copied into F.stats per fight —
 * F.stats is the live table from then on. */
function defaultStats() {
  return {
    maxHp: 100, hp: 100,
    damage: 8, specialDmg: 25,
    attackCd: 0.6, specialCd: 12, dashCd: DASH_COOLDOWN_S, dashCharges: 1, dmgReduction: 0,
    speed: 220 * PX, atkRange: 100 * PX, specialRange: 150 * PX,
    potionHeal: 30, potionsLeft: 2,
    level: 1, xp: 0, descent: 1,
  };
}

/* ---------- balance (single source of truth: GET /api/balance) ----------
 * Fetched at boot and re-fetched on every run restart. Anything absent from
 * the payload gets a TODO(balance: <key>) naming the exact key the balance
 * lane should add, plus a temporary local fallback so the flow still works. */
let BAL = null;
async function loadBalance() {
  try {
    BAL = await api('/api/balance');
  } catch {
    BAL = null; // offline: every helper below falls back to its temp constant
  }
  return BAL;
}
function refreshBalance() { loadBalance().catch(() => {}); } // fire-and-forget on run restart
function balNum(path, fallback) {
  let v = BAL;
  for (const k of path) {
    if (v == null || typeof v !== 'object') return fallback;
    v = v[k];
  }
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}
/* Potion scales with the player: flat + pct*maxHp (payload: potion.flat/pct_max_hp). */
function potionHealFor(maxHp) {
  return balNum(['potion', 'flat'], 30) + balNum(['potion', 'pct_max_hp'], 0.03) * Math.max(0, maxHp);
}
/* XP needed for the next level. Mirrors balance.py::exp_to_next exactly —
 * COMPOUNDED, not linear. A linear reading desynchronises card cadence from
 * boss scaling, which is precisely what the Python side documents against.
 * Values arrive in the payload (xp_threshold); the fallback is only for the
 * window before /api/balance resolves. */
const XP_THRESHOLD_FALLBACK = 100;
function xpThreshold(level) {
  const t = BAL && BAL.xp_threshold;
  const base = t && typeof t === 'object' ? Number(t.base) : NaN;
  const growth = t && typeof t === 'object' ? Number(t.growth || 0) : NaN;
  const b = isFinite(base) && base > 0 ? base : XP_THRESHOLD_FALLBACK;
  const g = isFinite(growth) && growth > 0 ? growth : 0.10;
  return Math.floor(b * Math.pow(1 + g, Math.max(0, level - 1)) + 0.5);
}
/* Governor par time. The numbers arrive in the payload (descent_par); the
 * fallbacks match balance.py and only apply before /api/balance resolves. */
const DESCENT_PAR_BASE_FALLBACK = 90, DESCENT_PAR_PER_LEVEL_FALLBACK = 4, XP_TIME_CAP_FALLBACK_S = 90;
function descentGain(fightSecs, hpLeftPct, descent) {
  const parBase = balNum(['descent_par', 'par_base_s'], DESCENT_PAR_BASE_FALLBACK);
  const parPer = balNum(['descent_par', 'par_per_descent_s'], DESCENT_PAR_PER_LEVEL_FALLBACK);
  const par = parBase + parPer * Math.max(0, descent);
  const speed = fightSecs <= 0 ? 1 : clamp(par / fightSecs, 0, 1);
  const clean = clamp(hpLeftPct / 100, 0, 1);
  return clamp(1 + Math.round(speed + clean), 1, 3);
}
/* Boss pools scale additively per descent (descent 1 wears the base pool
 * exactly; payload: boss_{hp,dmg,speed}_growth_per_level + speed cap). */
/* Boss pools scale additively per descent. Offset matches balance.py:
 * boss_hp(descent) = base * (1 + g * max(0, descent)). An earlier `- 1` here
 * made descent 1 weaker than Python's own model, which silently desynced the
 * client from the tuned crossover band. */
function bossHpPool(def, descent) {
  const g = balNum(['boss_hp_growth_per_level'], 0.05);
  return Math.round(def.hp * (1 + g * Math.max(0, descent)));
}
function bossDmgMul(descent) {
  return 1 + balNum(['boss_dmg_growth_per_level'], 0.05) * Math.max(0, descent);
}
function bossMovePxS(def, descent) {
  const g = balNum(['boss_speed_growth_per_level'], 0.02);
  const cap = balNum(['boss_speed_cap_px_s'], 200);
  return Math.min(def.move_speed * (1 + g * Math.max(0, descent)), cap);
}
function tier2Descent() { return Math.round(balNum(['tier2_descent'], 12)); }

/* ---------- room-clear (small room, LLM-driven adds, punish windows) ----------
 * One room per descent: seeded pillars cramp the floor, the boss pool is
 * scaled by room_boss_hp_mult (payload, fallback 0.75), and up to 5 minions
 * join on the brain's spawn_call. Clear = boss down + adds dead. */
const MINION_CAP = 5;
const MINION_BASE = {
  chaser: { hp: 20, speed: 170, dmg: 5, xp: 8 },
  lobber: { hp: 14, speed: 90, dmg: 6, xp: 10 },
};
function roomMult() { return balNum(['room_boss_hp_mult'], 0.75); }
function roomBossPool(def, descent) {
  return Math.max(1, Math.round(bossHpPool(def, descent) * roomMult()));
}
function minionHp(kind, descent) {
  const b = (MINION_BASE[kind] || {}).hp || 10;
  return Math.round(b * (1 + balNum(['boss_hp_growth_per_level'], 0.05) * Math.max(0, descent)));
}
function minionXp(kind) { return (MINION_BASE[kind] || {}).xp || 0; }
function pickKind() { return ((F.minions || []).length % 2) ? 'lobber' : 'chaser'; } // alternate: every room fields both taxes
function randFormId() {
  if (!FORMS.length) return null;
  return FORMS[(Math.random() * FORMS.length) | 0].id;
}
/* Seeded pillars: 2-4 rects, deterministic per descent so a room is
 * learnable across runs. */
// # ponytail: mulberry32 seeded by descent only — same pillars every run at a given depth; hash run-id into the seed if rooms ever need per-run variety.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedRoom(descent) {
  if (!F || !arena) return;
  for (let i = 0; i < 4; i++) { try { arena.killWall('pillar' + i); } catch { /* visual only */ } }
  const rng = mulberry32(Math.max(1, descent | 0));
  void rng;
  F.pillars = [];
  F.room = 'active';
}
/* Circle-vs-rect push-out against pillars (walls are bounds via clamps). */
function collidePillars(o, r) {}
function spawnMinion(kind) {
  if (!F || !arena || (F.minions || []).length >= MINION_CAP || F.boss.hp <= 0) return;
  kind = MINION_BASE[kind] ? kind : pickKind();
  const W = arena.ARENA_X, H = arena.ARENA_Z;
  const side = Math.random() < 0.5 ? -1 : 1;
  const m = {
    id: 'm' + (F.minionSeq++), kind,
    x: side * (W - 1.5), z: (Math.random() * 2 - 1) * (H - 2),
    cool: 0, lobT: LOBBER_INTERVAL_S + Math.random(), age: 0,
  };
  m.maxHp = m.hp = minionHp(kind, F.stats.descent);
  m.dmg = Math.max(1, Math.round((MINION_BASE[kind].dmg || 5) * bossDmgMul(F.stats.descent)));
  m.speed = (MINION_BASE[kind].speed || 100) * PX;
  { const pt = { x: m.x, z: m.z }; clampArena(pt, BOUND_MINION_M, W, H); m.x = pt.x; m.z = pt.z; }
  F.minions.push(m);
  try { arena.spawnProjectile('mx' + m.id, m.x, m.z); arena.dust(m.x, m.z, 6); } catch { /* visual only */ }
}
function hitMinion(m, dmg, special) {
  m.hp -= dmg;
  hitstop(0.06);
  arena.burst(m.x, m.z, special ? 0xffd75e : 0xffffff, 6, 3);
  if (m.hp > 0) {
    sfx('hit');
    spawnPop(m.x, 1.6, m.z, '-' + dmg, 'hit');
    return;
  }
  const i = (F.minions || []).indexOf(m);
  if (i !== -1) F.minions.splice(i, 1);
  try { arena.killProjectile('mx' + m.id); } catch { /* visual only */ }
  arena.burst(m.x, m.z, 0xffe9a8, 12, 4);
  sfx('death');
  const xp = minionXp(m.kind);
  F.stats.xp += xp;
  F.stats.potionsLeft = Math.min(3, F.stats.potionsLeft + 1); // adds feed the potion path, capped so rooms never print heals
  refreshPotions();
  spawnPop(m.x, 1.8, m.z, '+' + xp + ' XP +POT', 'heal');
  F.events.push(m.kind + ' slain');
}

/* ---------- run persistence (best + attempt log only, never player stats) ---------- */
const LS_BEST = 'bvy.best_descent';
const LS_HISTORY = 'bvy.run_history';
const LS_HABITS = 'bvy.habit_profile'; // the immortal memory: derived summary, survives death
const HISTORY_CAP = 60;
function loadBest() {
  try { return Math.max(0, parseInt(localStorage.getItem(LS_BEST) || '0', 10) || 0); }
  catch { return 0; }
}
function saveBest(d) { try { localStorage.setItem(LS_BEST, String(d)); } catch { /* private mode: record lost, run survives */ } }
function loadHistory() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]');
    return Array.isArray(v) ? v.slice(-HISTORY_CAP) : [];
  } catch { return []; }
}
function pushHistory(rec) {
  if (!F) return;
  F.runHistory.push(rec);
  while (F.runHistory.length > HISTORY_CAP) F.runHistory.shift();
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(F.runHistory)); } catch { /* run survives */ }
}

/* ---------- habit profile: the thing that survives death ----------
 * summarizeHistory mirrors src/bossfight/habits.py (the Python copy is the
 * tested ground truth). Counters are shares/means over the last ≤60 fights;
 * every field optional, missing data degrades to 0, never throws. */
function summarizeHistory(recs) {
  const list = Array.isArray(recs)
    ? recs.slice(-HISTORY_CAP).filter((r) => r && typeof r === 'object')
    : [];
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  let guard = 0, attack = 0, dash = 0, dodges = 0, totalSecs = 0, stillSecs = 0;
  let fracSum = 0, fracN = 0, rangeSum = 0, rangeN = 0, kills = 0, deaths = 0;
  const causes = {}, openers = {};
  for (const r of list) {
    const mv = (r.moves_used && typeof r.moves_used === 'object') ? r.moves_used : {};
    guard += Math.max(0, parseInt(mv.guard, 10) || 0);
    attack += Math.max(0, parseInt(mv.attack, 10) || 0);
    dash += Math.max(0, parseInt(mv.dash, 10) || 0);
    dodges += Math.max(0, parseInt(r.dodges_landed, 10) || 0);
    const secs = num(r.fight_secs);
    if (secs > 0) { totalSecs += secs; const st = num(r.still_secs); if (st > 0) stillSecs += st; }
    if (Array.isArray(r.potion_hp_fracs) && r.potion_hp_fracs.length) {
      for (const v of r.potion_hp_fracs) { const f = Number(v); if (isFinite(f) && f >= 0 && f <= 1) { fracSum += f; fracN++; } }
    } else {
      const mean = Number(r.potion_hp_mean), n = Math.max(0, parseInt(r.potion_n ?? mv.potion, 10) || 0);
      if (isFinite(mean) && n > 0) { fracSum += clamp(mean, 0, 1) * n; fracN += n; }
    }
    if (Array.isArray(r.attack_ranges) && r.attack_ranges.length) {
      for (const v of r.attack_ranges) { const d = Number(v); if (isFinite(d) && d >= 0) { rangeSum += d; rangeN++; } }
    } else {
      const mean = Number(r.attack_range_mean), n = Math.max(0, parseInt(r.attack_n, 10) || 0);
      if (isFinite(mean) && mean >= 0 && n > 0) { rangeSum += mean * n; rangeN += n; }
    }
    const oc = String(r.outcome || '').toLowerCase();
    if (oc === 'kill') kills++; else if (oc === 'death') deaths++;
    const cause = String(r.last_damage_source || '').trim().toLowerCase();
    if (cause) causes[cause] = (causes[cause] || 0) + 1;
    const op = normOpener(r.opener);
    openers[op] = (openers[op] || 0) + 1;
  }
  const defensive = guard + Math.min(dash, dodges), combat = guard + attack + dash;
  const turtle = combat > 0 ? clamp(defensive / combat, 0, 1) : 0;
  let spam = 0;
  if (dash > 0) {
    const dpm = totalSecs > 0 ? dash / (totalSecs / 60) : 12;
    spam = clamp(Math.min(1, dpm / 12) * (1 - clamp(dodges / dash, 0, 1)), 0, 1);
  }
  const still = totalSecs > 0 ? clamp(stillSecs / totalSecs, 0, 1) : 0;
  const potion = fracN > 0 ? clamp(fracSum / fracN, 0, 1) : 0;
  const range = rangeN > 0 ? clamp((rangeSum / rangeN) / 300, 0, 1) : 0;
  let opener = 'still';
  const oks = Object.keys(openers);
  if (oks.length) { const top = Math.max(...oks.map((k) => openers[k])); opener = oks.filter((k) => openers[k] === top).sort()[0]; }
  const decisive = kills + deaths;
  const finish = decisive > 0 ? clamp(kills / decisive, 0, 1) : 0;
  const totalCauses = Object.values(causes).reduce((s, n) => s + n, 0);
  const deathCauses = {}, deathCounts = {};
  for (const k of Object.keys(causes).sort()) {
    deathCounts[k] = causes[k];
    deathCauses[k] = totalCauses ? causes[k] / totalCauses : 0;
  }
  const lines = {
    turtle_ratio: turtle >= 0.6 ? 'turtles when hurt' : turtle >= 0.35 ? 'holds guard often' : 'rarely turtles',
    dash_spam: spam >= 0.6 ? 'spams dash' : spam >= 0.3 ? 'dashes often' : 'dashes with purpose',
    stationary_ratio: still >= 0.6 ? 'stands still to trade' : still >= 0.35 ? 'holds ground often' : 'keeps moving',
    potion_timing: fracN <= 0 ? 'rarely drinks' : potion >= 0.7 ? 'drinks potions early' : potion >= 0.4 ? 'drinks mid-fight' : 'drinks at death\'s door',
    attack_range_pref: rangeN <= 0 ? 'no clean hits yet' : range >= 0.66 ? 'hits from long range' : range >= 0.33 ? 'mixes its range' : 'fights point-blank',
    opener: { attack: 'opens with attacks', dash: 'opens with a dash', potion: 'opens with a potion', guard: 'opens with guard', still: 'waits at the bell' }[opener] || 'waits at the bell',
    finish_frac: finish <= 0 ? 'no kills yet' : finish >= 0.6 ? 'usually finishes fights' : finish >= 0.35 ? 'trades kills' : 'rarely finishes fights',
    death_causes: totalCauses <= 0 ? 'nothing has put it down yet'
      : 'often put down by ' + Object.keys(causes).filter((k) => causes[k] === Math.max(...Object.values(causes))).sort()[0].slice(0, 40),
  };
  const keys = ['turtle_ratio', 'dash_spam', 'stationary_ratio', 'potion_timing', 'attack_range_pref', 'opener', 'finish_frac', 'death_causes'];
  return {
    counters: { turtle_ratio: turtle, dash_spam: spam, stationary_ratio: still, potion_timing: potion, attack_range_pref: range, finish_frac: finish },
    opener, death_causes: deathCauses, death_counts: deathCounts,
    lines, labels: list.length ? keys.map((k) => lines[k]) : [], fights: list.length,
  };
}
function normOpener(raw) {
  const o = String(raw || '').trim().toLowerCase();
  if (o === 'atk' || o === 'special' || o === 'attack') return 'attack';
  if (o === 'dash' || o === 'potion' || o === 'guard') return o;
  return 'still';
}
/* Deterministic habit-derived read for when the model returns nothing —
 * the death screen and descent cards never render a blank gap. */
function fallbackRead(summary) {
  if (!summary || !(summary.fights > 0)) return 'it has no read on you yet — move, and it will learn.';
  const c = summary.counters || {}, L = summary.lines || {};
  const scored = [
    [Number(c.turtle_ratio) || 0, L.turtle_ratio || ''],
    [Number(c.dash_spam) || 0, L.dash_spam || ''],
    [Number(c.stationary_ratio) || 0, L.stationary_ratio || ''],
  ].filter(([v, s]) => v >= 0.35 && s).sort((a, b) => b[0] - a[0]);
  const read = scored.length ? scored.slice(0, 2).map(([, s]) => s).join('; ') : (L.opener || 'it watches how you open');
  return (read || 'it watches how you open.').slice(0, 200);
}
function loadHabitProfile() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_HABITS) || 'null');
    if (v && v.counters && typeof v.counters === 'object') return v;
  } catch { /* corrupted profile: recompute from history at run start */ }
  return null;
}
function saveHabitProfile() {
  if (!F) return;
  try {
    const s = summarizeHistory(F.runHistory);
    F.habitProfile = { counters: s.counters, lines: s.lines, labels: s.labels, fights: s.fights };
    localStorage.setItem(LS_HABITS, JSON.stringify({ ...F.habitProfile, updatedAt: Date.now() }));
  } catch { /* run survives */ }
}
/* One builder for the attempt-log record both kill and death share, so the
 * habit counters read the same shape either way. */
function openerFrom(acts) {
  if (!acts || !acts.length) return 'still';
  const counts = {};
  for (const a of acts) { const k = normOpener(a); counts[k] = (counts[k] || 0) + 1; }
  const top = Math.max(...Object.values(counts));
  return Object.keys(counts).filter((k) => counts[k] === top).sort()[0];
}
function resetFightTrackers() {
  if (!F) return;
  F.moves = { dash: 0, attack: 0, guard: 0, potion: 0 }; // no guard mechanic: guard stays 0 by construction
  F.dodges = 0; F.stillSecs = 0; F.potionFracs = []; F.attackDists = []; F.openerActs = [];
}
function fightRecord(outcome, hpEnd) {
  const mv = (F.moves && typeof F.moves === 'object') ? F.moves : {};
  const pf = F.potionFracs || [], ad = F.attackDists || [];
  return {
    descent: F.stats.descent, form: F.boss.form, outcome,
    fight_secs: Math.round(((performance.now() - F.fightT0) / 1000) * 10) / 10,
    hp_at_start: Math.round(F.fightHpStart), hp_at_end: hpEnd,
    last_damage_source: F.lastDamageSource || (F.events.length ? F.events[F.events.length - 1] : ''),
    damage_dealt: Math.round(F.damageDealt || 0),
    moves_used: { dash: mv.dash || 0, attack: mv.attack || 0, guard: 0, potion: mv.potion || 0 },
    damage_blocked: 0, // no block mechanic: nothing ever blocks (schema kept so the counter reads it)
    dodges_landed: F.dodges || 0,
    still_secs: Math.round((F.stillSecs || 0) * 10) / 10,
    potion_hp_mean: pf.length ? Math.round((pf.reduce((s, v) => s + v, 0) / pf.length) * 100) / 100 : 0,
    potion_n: pf.length,
    attack_range_mean: ad.length ? Math.round((ad.reduce((s, v) => s + v, 0) / ad.length) * 10) / 10 : 0,
    attack_n: ad.length,
    opener: openerFrom(F.openerActs),
  };
}
const KEYMAP = [
  ['Move', 'WASD / arrows / left stick'],
  ['Attack', 'J / Space'],
  ['Dash (dodge!)', 'K / Shift'],
  ['Special', 'L / E'],
  ['Potion', 'U / Q'],
];
const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'KeyQ', 'KeyE',
  'Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function css(colour) {
  return '#' + (colour >>> 0).toString(16).padStart(6, '0');
}
function scoreFor(secs, hpLeft) {
  return Math.round(1500 + Math.max(0, 240 - secs) * 5 + clamp(hpLeft, 0, 100) * 10);
}
function api(path, opts) {
  return fetch(path, opts).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
}

/* ---------- DOM juice (all guarded) ---------- */
function showBanner(kicker, title, sub, accent) {
  const b = $('bv-banner');
  if (!b) return;
  $('bv-banner-kicker').textContent = kicker;
  $('bv-banner-title').textContent = title;
  $('bv-banner-sub').textContent = sub || '';
  /* dark splash panel: tint the frame per moment (boss colour, ember, gold win) */
  if (accent) b.style.setProperty('--splash', accent);
  else b.style.removeProperty('--splash');
  b.setAttribute('aria-hidden', 'false');
  b.classList.remove('show');
  void b.offsetWidth;
  b.classList.add('show');
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => b.setAttribute('aria-hidden', 'true'), 2300);
}
function setVignette(on) { const v = $('bv-vignette'); if (v) v.classList.toggle('on', !!on); }
function domFlash() {
  const f = $('bv-flash');
  if (!f || REDUCED) return;
  f.classList.remove('hit');
  void f.offsetWidth;
  f.classList.add('hit');
}

/* ---------- app state ---------- */
let BOSS = null;   // the one immortal entity ({id, name, enrage, ...})
let FORMS = [];    // form defs in legal order, from /api/bosses
let ENRAGE = {};
let state = 'menu'; // menu | fight | end
let arena = null;
let F = null; // fight state
let fightSeq = 0;
let canvas = null;

/* Impact freeze: skip world updates for a beat so landed hits thud.
 * Rendering continues (a held frame), telegraphs freeze too. Off under
 * reduced-motion — a freeze is still a jolt. */
function hitstop(sec) {
  if (!F || REDUCED) return;
  F.stopT = Math.max(F.stopT || 0, sec);
}

/* Pause: single flag, no stack (one overlay owns it at a time).
 * # ponytail: single active pause source rather than a pause stack;
 * add a stack only if two overlays ever pause at once. */
function setPaused(v) {
  if (!F || F.paused === v) return;
  const now = performance.now() / 1000;
  if (v) { F.paused = true; F.pauseT0 = now; return; }
  /* resume: shift wall-clock timers forward so cooldowns and the clock freeze across the menu */
  const dt = now - (F.pauseT0 || now);
  F.paused = false;
  F.atkT += dt; F.specT += dt; F.dashT += dt; F.ifrT += dt; F.lastSwitch += dt;
  if (F.slumpUntil) F.slumpUntil += dt; // the punish window freezes with the world
  if (F.lastBossAtkT) F.lastBossAtkT += dt; // global strike gap freezes too
  F.startT += dt * 1000;
  for (const k in F.atkTmap) F.atkTmap[k] += dt;
}

function showScreen(name) {
  state = name;
  for (const s of ['menu', 'end']) {
    $('screen-' + s).classList.toggle('active', s === name);
  }
  $('hud').classList.toggle('active', name === 'fight');
}

function spawnPop(x, y, z, text, cls) {
  const layer = $('pop-layer');
  if (!layer || !arena) return;
  const p = arena.project(x, y, z);
  const d = document.createElement('div');
  d.className = 'pop ' + (cls || '') + (REDUCED ? ' static' : '');
  d.textContent = text;
  d.style.left = p.x + 'px';
  d.style.top = p.y + 'px';
  layer.appendChild(d);
  setTimeout(() => d.remove(), REDUCED ? 600 : 750);
}

function say(line) {
  if (!F) return;
  const bal = $('taunt-balloon');
  if (bal) {
    bal.textContent = (F.cfg.name || 'Boss') + ': ' + line;
    bal.classList.add('show');
  }
  const sr = $('taunt-region');
  if (sr) sr.textContent = (F.cfg.name || 'Boss') + ': ' + line;
  clearTimeout(say._t);
  say._t = setTimeout(() => { if (bal) bal.classList.remove('show'); }, 2600);
}

/* ---------- menu / end ---------- */
function formById(id) { return FORMS.find((f) => f.id === id) || null; }

function buildMenu() {
  const best = loadBest();
  $('menu-status').textContent = best > 0
    ? 'It is waiting below. It remembers you. Best: descent ' + best + '.'
    : 'It is waiting below. It remembers you.';
  $('btn-fight').onclick = () => startFight();
}

function showEnd(r) {
  $('end-kicker').textContent = 'THE RUN ENDS AT DESCENT ' + F.stats.descent;
  $('end-title').textContent = 'IT GETS UP. YOU DO NOT.';
  $('end-flavour').textContent = '\u201C' + (F.lastTaunt || 'Down here, hero.') + '\u201D';
  const m = Math.floor(r.secs / 60), s = Math.floor(r.secs % 60);
  $('end-stats').innerHTML =
    statCard('TIME', m + ':' + String(s).padStart(2, '0')) +
    statCard('DESCENT', String(F.stats.descent)) +
    statCard('LEVEL', String(F.stats.level)) +
    statCard('SCORE', String(r.score));
  const build = (F.build || []).map(cardName).filter(Boolean);
  $('end-build').textContent = build.length
    ? 'Final build (Lv ' + F.stats.level + '): ' + build.join(' · ')
    : 'No cards taken. The dark keeps the deposit.';
  $('end-read').textContent = '\u201CIts read on you: ' + (F.lastRead || fallbackRead(F.habitProfile)) + '\u201D';
  const best = loadBest();
  $('end-ladder').textContent = 'Best descent ' + Math.max(best, F.stats.descent) + '. One life. No win. Descend again.';
  $('btn-rematch').textContent = 'DESCEND AGAIN';
  $('btn-rematch').onclick = () => startFight();
  const nb = $('btn-next');
  if (nb) nb.style.display = 'none';
  const bb = $('btn-bosses');
  if (bb) { bb.textContent = 'MENU'; bb.onclick = () => { buildMenu(); showScreen('menu'); }; }
  showScreen('end');

  function statCard(k, v) {
    return '<div class="stat-card"><span class="stat-k">' + k + '</span><span class="stat-v">' + v + '</span></div>';
  }
}

/* ---------- fight setup ---------- */
function startFight() {
  const cfg = formById('crawler') || FORMS[0];
  if (!cfg) return; // forms not loaded yet — menu stays until /api/bosses lands
  refreshBalance(); // re-fetch the single source of truth on every run restart
  hideDraft(); // a dead run never leaves its draft open behind the new one
  hidePause(); // same: a restart never leaves the pause open behind the new run
  const mySeq = ++fightSeq;
  const prev = F; // stale minion markers die here — the fresh F below cannot reach them
  const W = arena.ARENA_X, H = arena.ARENA_Z;
  F = {
    cfg, mySeq,
    bossId: (BOSS && BOSS.id) || 'the-thing-below',
    paused: false, pauseT0: 0,
    lastAppliedSeq: -1,
    stats: defaultStats(),
    build: [], // card names taken this run — reset every run, shown on death
    runHistory: loadHistory(), // attempt log: persists across runs, ≤60
    habitProfile: null, // seeded just below: persisted profile or live summary (needs F.runHistory first)
    boss: { form: cfg.id, hp: roomBossPool(cfg, 1), maxHp: roomBossPool(cfg, 1) },
    bossDmgMul: bossDmgMul(1), bossMovePxS: bossMovePxS(cfg, 1),
    room: 'active', pillars: [], minions: [], minionSeq: 0, spawnT: 0,
    slumpUntil: 0, vulnMult: 1.5, slumpN: 0, lastBossAtkT: -99, needApproach: false,
    tacticWeights: null, lastNextForm: null, lastTaunt: '', lastRead: '',
    transformedThisFight: false, pendingNextForm: null, lastTransformT: -99,
    transitioning: false, // boss-hp-0 → boss-returns window (draft lives here)
    damageDealt: 0, lastDamageSource: '',
    px: 0, pz: H - 2.5,
    atkT: -99, specT: -99, dashT: -99, ifrT: -99,
    dashLeft: 1, dashRefillT: 0,
    dashDx: 0, dashDz: 0, dashing: 0, dashDist: 0, vx: 0, vz: 0, facing: Math.PI,
    bx: 0, bz: Math.max(-H + 2.5, FLOOR_Z_MIN + 0.1), flyY: 0,
    enraged: false, flying: false,
    atkTmap: {}, tactic: 'pressure', speedMul: 1, dmgMul: 1, intensity: 0.5,
    over: false, won: false, startT: performance.now(), fightT0: performance.now(),
    fightHpStart: 100, tick: 0,
    lastSwitch: -99, events: [], hist: [], brainTimer: 0, stopT: 0,
    projectiles: [], walls: [], projSeq: 0, wallSeq: 0,
    moved10: 0, movedDecay: 0, actT: 0, timeouts: [],
    joy: { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0, dz: 0 },
  };
  /* F.maxHp aliases F.boss.maxHp so a form transform has one live pool to reset. */
  const selfF = F;
  /* THE FEATURE — the boss is immortal, so its memory outlives your run:
   * the persisted habit profile (written on every kill and death) seeds the
   * first brain call, so run 2 opens already countering run 1's habits.
   * Falls back to summarising history live (fresh device / older client). */
  F.habitProfile = loadHabitProfile() || summarizeHistory(F.runHistory);
  resetFightTrackers(); // per-fight habit trackers start clean every run
  Object.defineProperty(F, 'maxHp', {
    get() { return selfF.boss.maxHp; },
    set(v) { selfF.boss.maxHp = v; },
    configurable: true,
  });
  arena.setBoss((cfg.visual && cfg.visual.recipe) || 'courier', cfg.visual || {});
  arena.clearTelegraphs();
  arena.clearCracks();
  for (const pr of F.projectiles) arena.killProjectile(pr.id);
  for (const wl of F.walls) arena.killWall(wl.id);
  F.projectiles = []; F.walls = [];
  seedRoom(1); // descent 1 pillars; boss pool already scaled by roomMult above
  F.stats.potionsLeft = POTIONS_AT_ENTRY; // room entry resets to exactly 2
  if (prev && prev.minions) for (const m of prev.minions) { try { arena.killProjectile('mx' + m.id); } catch { /* visual only */ } }
  setVignette(false);
  setBossChrome(cfg);
  $('hint-bar').classList.add('show');
  refreshPotions();
  showScreen('fight');
  resizeArena();
  /* boss intro splash */
  showBanner('DESCENT 1 — IT WEARS ' + cfg.name.toUpperCase(),
    cfg.name.toUpperCase() + ' RISES!', cfg.title, css(cfg.colour));
  say((BOSS && BOSS.taunt_voice && BOSS.taunt_voice[0]) || ('I am ' + cfg.name + '!'));
  arena.shake(0.7);
  arena.dust(0, 0, 10, 0xd8c49a, 3);
  sfx('ui');
  think(true);
}

function setBossChrome(def) {
  $('boss-name').textContent = '◆ ' + (BOSS ? BOSS.name.toUpperCase() : 'THE THING') + ' — ' + def.name.toUpperCase();
  $('boss-name').style.color = css(def.colour);
  $('boss-name').style.textShadow = '0 0 14px ' + css(def.colour) + ', 2px 2px 0 #000';
}

/* Transform set-piece: flash, crack/shudder, silhouette rebuild, fresh pool,
 * and a banner naming the new form AND its signature tell — the player must
 * always be able to tell what the new move is and how to read it. */
function doTransform(newForm, isMidFight, read) {
  const def = formById(newForm);
  if (!def || !F || newForm === F.boss.form) return false;
  F.cfg = def;
  F.boss.form = newForm;
  F.boss.maxHp = roomBossPool(def, F.stats.descent);
  F.boss.hp = F.boss.maxHp;
  F.bossDmgMul = bossDmgMul(F.stats.descent);
  F.bossMovePxS = bossMovePxS(def, F.stats.descent);
  F.enraged = false;
  arena.setBoss((def.visual && def.visual.recipe) || 'courier', def.visual || {});
  arena.clearTelegraphs(); // old windups die with the old body — never resolve stale
  arena.spawnCrack(F.bx, F.bz, Math.random() * Math.PI * 2, 1.6);
  arena.dust(F.bx, F.bz, 14, 0xd8c49a, 4);
  arena.shake(1.0);
  sfx('clear');
  domFlash();
  setVignette(false);
  setBossChrome(def);
  const sig = def.attacks.find((a) => a.id === def.signature) || def.attacks[0];
  const effRead = read || fallbackRead(F.habitProfile); // an empty model read never renders blank
  const sub = '\u201CIts read on you: ' + effRead + '\u201D — ' + def.title;
  showBanner((isMidFight ? 'IT BECOMES — ' : 'DESCENT ' + F.stats.descent + ' — ') + def.name.toUpperCase(),
    'NEW MOVE: ' + sig.id.toUpperCase() + ' — ' + (sig.telegraph_ms / 1000).toFixed(2) + 's WINDUP',
    sub, css(def.colour));
  say((BOSS && BOSS.taunt_voice && BOSS.taunt_voice[1]) || def.title);
  F.events.push('boss became ' + newForm);
  return true;
}

function later(ms, fn) {
  if (!F) return;
  const mySeq = F.mySeq;
  /* Respects F.paused: while a menu/draft is open the callback re-queues
   * instead of firing, so telegraphs and stance timers freeze with the world. */
  const fire = () => {
    if (!F || F.mySeq !== mySeq || F.over) return;
    if (F.paused) { F.timeouts.push(setTimeout(fire, 100)); return; }
    fn();
  };
  F.timeouts.push(setTimeout(fire, ms));
}

function syncMuteBtn() {
  const b = $('btn-mute');
  if (b) b.textContent = isMuted() ? 'SOUND: OFF' : 'SOUND: ON';
}

function refreshPotions() {
  if (!F) return;
  const S = F.stats;
  const heal = Math.round(potionHealFor(S.maxHp));
  $('potion-count').textContent = 'POT ×' + S.potionsLeft + (S.potionsLeft ? ' (+' + heal + ')' : ' (empty)');
}

/* ---------- player actions ---------- */
function tryAttack(special) {
  if (!F || F.over || F.paused || state !== 'fight') return; // paused: no input damage
  const now = performance.now() / 1000;
  const S = F.stats;
  if (special) {
    if (now - F.specT < S.specialCd) return;
    F.specT = now;
  } else {
    if (now - F.atkT < S.attackCd) return;
    F.atkT = now;
  }
  logHist('atk');
  if (F.moves) F.moves.attack++; // habit hook: swing counted, distance only on a hit below
  $('hint-bar').classList.remove('show');
  F.facing = Math.atan2(F.bx - F.px, F.bz - F.pz); // auto-face boss
  if (special) {
    const dx = F.bx - F.px, dz = F.bz - F.pz;
    const m = Math.hypot(dx, dz) || 1;
    const id = 'h' + (F.projSeq++);
    F.projectiles.push({ id, hero: true, x: F.px, z: F.pz, vx: (dx / m) * HERO_SPECIAL_PROJ_SPEED, vz: (dz / m) * HERO_SPECIAL_PROJ_SPEED, dmg: S.specialDmg, life: 2.5 });
    arena.spawnProjectile(id, F.px, F.pz);
    arena.burst(F.px, F.pz, 0xffd75e, 6, 3);
    sfx('shoot');
    return;
  }
  const range = S.atkRange;
  const dmg = S.damage;
  const reach = range + 1.1;
  const vuln = performance.now() / 1000 < (F.slumpUntil || 0) ? (F.vulnMult || 1.5) : 1; // slump: the punish window pays 1.5x
  let hitAny = false;
  if (dist2(F.px, F.pz, F.bx, F.bz) <= reach) {
    hitAny = true;
    (F.attackDists = F.attackDists || []).push(Math.round((dist2(F.px, F.pz, F.bx, F.bz) / PX) * 10) / 10); // habit hook: hit distance in px
    const eff = Math.max(1, Math.round(dmg * vuln) - (F.cfg.armour || 0)); // colossus plating taxes every swing, never immune
    F.boss.hp -= eff;
    F.damageDealt = (F.damageDealt || 0) + eff; // the attempt log's damage_dealt
    F.events.push('boss hit');
    hitstop(0.05);
    arena.burst(F.bx, F.bz, 0xffffff, 9, 4.5, 1.0 + F.flyY);
    sfx('hit');
    arena.dust(F.bx, F.bz, 7);
    spawnPop(F.bx, 2.1 + F.flyY, F.bz, 'THWACK! -' + eff, 'hit');
    if (!REDUCED) arena.shake(0.35);
    else domFlash();
  }
  for (let i = (F.minions || []).length - 1; i >= 0; i--) { // swings catch adds too
    const m = F.minions[i];
    if (dist2(F.px, F.pz, m.x, m.z) <= reach) { hitAny = true; hitMinion(m, dmg, false); }
  }
  if (!hitAny) {
    spawnPop(F.px, 1.8, F.pz, 'WHIFF!', 'miss');
  }
}

function tryDash() {
  if (!F || F.over || F.paused || state !== 'fight') return; // paused: no movement
  if ((F.dashLeft || 0) <= 0) return; // out of charges — refill ticks in update()
  const now = performance.now() / 1000;
  if (now - F.dashT < 0.25) return; // double-tap guard, not the cooldown (charges own that)
  F.dashLeft--;
  F.dashT = now;
  F.ifrT = now + 0.25; // i-frames UNCHANGED (balance, not feel)
  F.dashing = FEEL_DASH_TIME; // duration UNCHANGED — mirrors the old 0.18 literal
  F.dashDist = 0;
  let dx = F.joy.dx, dz = F.joy.dz;
  if (Math.hypot(dx, dz) < 0.2) { // dash away from boss by default
    dx = F.px - F.bx; dz = F.pz - F.bz;
    const m = Math.hypot(dx, dz) || 1; dx /= m; dz /= m;
  } else { const m = Math.hypot(dx, dz); dx /= m; dz /= m; }
  F.dashDx = dx; F.dashDz = dz;
  logHist('dash');
  if (F.moves) F.moves.dash++; // habit hook: dash counted (dodges counted on i-frame save in hurtPlayer)
  F.events.push('player dashed');
  arena.burst(F.px, F.pz, 0x9cc8ff, 6, 2.5);
  arena.dust(F.px, F.pz, 5);
  arena.puffSmoke();
}

function tryPotion() {
  if (!F || F.over || F.paused || state !== 'fight') return; // paused: no healing
  const S = F.stats;
  if (S.potionsLeft <= 0 || S.hp >= S.maxHp) return;
  S.potionsLeft--;
  (F.potionFracs = F.potionFracs || []).push(S.maxHp > 0 ? clamp(S.hp / S.maxHp, 0, 1) : 0); // habit hook: HP fraction at drink time
  if (F.moves) F.moves.potion++; // habit hook
  logHist('potion'); // opener hook: a first-3s potion counts as the opener
  const heal = Math.round(potionHealFor(S.maxHp)); // 30 + 3% max HP: flat heals go dead ~descent 27
  S.hp = Math.min(S.maxHp, S.hp + heal);
  refreshPotions();
  F.events.push('player healed');
  arena.burst(F.px, F.pz, 0x7cff6b, 10, 3.5);
  sfx('potion');
  spawnPop(F.px, 1.8, F.pz, '+' + heal + ' PATCHED!', 'heal');
}

function hurtPlayer(dmg, why) {
  if (!F || F.over || F.paused) return; // paused: no HP mutation
  const now = performance.now() / 1000;
  if (now < F.ifrT) { // i-frames save you
    F.dodges = (F.dodges || 0) + (dmg > 0 ? 1 : 0); // habit hook: an i-frame save is an effective (defensive) dash
    if (dmg > 0) spawnPop(F.px, 1.8, F.pz, 'TOO SLOW!', 'heal');
    return;
  }
  if (why) F.lastDamageSource = why; // the attempt log's last_damage_source
  const eff = Math.max(1, dmg - (F.stats.dmgReduction || 0)); // Stone Skin taxes every hit, floor 1, never immune
  F.stats.hp -= eff;
  F.events.push('player hit' + (why ? ' (' + why + ')' : ''));
  if (eff > 0) {
    sfx('hurt');
    hitstop(0.07);
    arena.burst(F.px, F.pz, 0xff5a4e, 10, 4);
    arena.dust(F.px, F.pz, 8);
    spawnPop(F.px, 2.0, F.pz, '-' + eff, 'bad');
    arena.shake(0.7);
    domFlash();
  }
}

function logHist(kind) {
  if (!F) return;
  const t = performance.now() / 1000;
  F.hist.push({ t, kind });
  // opener hook (smallest one: a timestamp check): actions in the first 3s of
  // the fight seed the opener counter. Guard kind never fires (no guard input).
  if (F.fightT0 && performance.now() - F.fightT0 < 3000) (F.openerActs = F.openerActs || []).push(kind);
}

/* ---------- brain ---------- */
/* Habit counters, derived client-side (no model tokens spent on arithmetic):
 * stillness vs motion, swing rate, dash rate. The model reads these. */
function habits() {
  if (!F) return {};
  // No data yet: the floor, never spawn-turtle. (moved10 starts at 0, which
  // the old formula read as "never moved" -> turtle 1 on the very first tick,
  // punishing new players for having no history. A fresh run sends zeros until
  // the fight has 3s of behaviour behind it.)
  if (!F.fightT0 || performance.now() - F.fightT0 < 3000) {
    return { turtle_ratio: 0, stationary_ratio: 0, aggression: 0, dash_spam: 0 };
  }
  const now = performance.now() / 1000;
  F.hist = F.hist.filter((h) => now - h.t < 10);
  let atk = 0, dash = 0;
  for (const h of F.hist) { if (h.kind === 'atk') atk++; if (h.kind === 'dash') dash++; }
  return {
    turtle_ratio: clamp(1 - F.moved10 / 60, 0, 1),
    stationary_ratio: clamp(1 - F.moved10 / 60, 0, 1),
    aggression: clamp(atk / 8, 0, 1),
    dash_spam: clamp(dash / 4, 0, 1),
  };
}
function think(first) {
  if (!F || F.over || F.paused) return; // paused: no new brain ticks while a menu is open
  const self = F;
  const bossPct = Math.max(0, (self.boss.hp / self.boss.maxHp) * 100);
  const now = performance.now() / 1000;
  const phase = bossPct < 30 ? 'enrage' : 'normal';
  if (phase === 'enrage' && !self.enraged && self.boss.hp > 0) enterEnrage();
  const seq = self.tick++;
  /* Habits sent = the immortal profile (cross-run memory, seeded from
   * localStorage on run start) merged with the live 10s window: long-term
   * counters persist, live spikes react. Summary LINES go in history so the
   * prompt stays small (~250 tokens); raw floats never do. */
  const live = habits();
  const prof = (self.habitProfile && self.habitProfile.counters) || {};
  const num = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
  const mergedHabits = {
    turtle_ratio: Math.max(num(prof.turtle_ratio), num(live.turtle_ratio)),
    dash_spam: Math.max(num(prof.dash_spam), num(live.dash_spam)),
    stationary_ratio: Math.max(num(prof.stationary_ratio), num(live.stationary_ratio)),
    potion_timing: num(prof.potion_timing),
    attack_range_pref: num(prof.attack_range_pref),
    finish_frac: num(prof.finish_frac),
    aggression: num(live.aggression), // live-only: current-fight rush the profile cannot know yet
  };
  const habitLines = (self.habitProfile && self.habitProfile.labels) || [];
  const body = {
    boss_id: self.bossId, tick: seq, seq,
    descent: self.stats.descent, form: self.boss.form,
    boss_hp_pct: Math.round(bossPct), player_hp_pct: Math.round(Math.max(0, self.stats.hp)),
    habits: mergedHabits, build: (self.build || []).slice(),
    fight_secs: (performance.now() - self.startT) / 1000,
    last_damage_source: self.events.length ? self.events[self.events.length - 1] : '',
    history: habitLines.concat(self.events.slice(-4)).slice(-12),
    transforms_this_fight: self.transformedThisFight ? 1 : 0,
    secs_since_transform: now - (self.lastTransformT || -99),
    minions_alive: (self.minions || []).length,
  };
  self.events = [];
  api('/api/brain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((out) => applyBrain(out, { mySeq: self.mySeq, seq, first: !!first }))
    .catch(() => { /* fight survives a dead model - local AI keeps going */ });
}

/* Single choke point for brain replies. Drops any reply with
 * seq <= F.lastAppliedSeq so a slow 6–23s response can never overwrite
 * fresher state. Replies without a seq (current server) always apply.
 * Safe while paused: tactic/taunt/transform bookkeeping never mutates
 * HP or positions directly (the transform path rebuilds via doTransform).
 *
 * Rate limit lives on BOTH sides: the server gates transform_now for
 * shape/legality (same-form, low-descent, lockout) against the count the
 * client reports, but only the client knows its live fight count in real
 * time — so a transform_now already honoured this fight is ignored here
 * and held as pendingNextForm for the next descent transition instead. */
function applyBrain(out, ctx) {
  if (!out || !F || F.mySeq !== ctx.mySeq || F.over) return;
  const seq = typeof out.seq === 'number' ? out.seq : ctx.seq;
  if (seq <= F.lastAppliedSeq) return; // stale reply — ignore
  F.lastAppliedSeq = seq;
  if (out.tactics && typeof out.tactics === 'object') {
    let total = 0;
    const w = {};
    for (const k of TACTIC_KEYS) {
      const v = Number(out.tactics[k]);
      w[k] = (isFinite(v) && v > 0) ? v : 0;
      total += w[k];
    }
    if (total > 0) F.tacticWeights = w; // else keep previous (or uniform floor)
  }
  if (typeof out.next_form === 'string' && formById(out.next_form)) {
    F.lastNextForm = out.next_form;
  }
  if (out.transform_now && F.lastNextForm && F.lastNextForm !== F.boss.form) {
    if (F.boss.hp <= 0) { F.pendingNextForm = F.lastNextForm; } // boss down: hold the body for the return window, never revive mid-clear
    else if (!F.transformedThisFight) {
      F.transformedThisFight = true;
      F.lastTransformT = performance.now() / 1000;
      doTransform(F.lastNextForm, true);
    } else {
      F.pendingNextForm = F.lastNextForm;
    }
  }
  if (out.taunt) { F.lastTaunt = out.taunt; say(out.taunt); }
  if (typeof out.read === 'string' && out.read) F.lastRead = out.read; // surfaced on descent cards + death screen
  if (typeof out.intensity === 'number') F.intensity = out.intensity;
  if (out.spawn_call && (F.minions || []).length < MINION_CAP && F.boss.hp > 0) {
    spawnMinion(pickKind());
    F.spawnT = 0; // LLM-driven rooms reset the offline fallback clock below
  }
}

function enterEnrage() {
  const e = ENRAGE || {};
  F.enraged = true;
  F.speedMul = e.speed_mult || 1.25;
  F.dmgMul = e.damage_mult || 1.25;
  arena.setEnrage(true);
  arena.shake(0.9);
  sfx('hurt');
  arena.spawnCrack(F.bx, F.bz, Math.random() * Math.PI * 2, 1.4);
  arena.dust(F.bx, F.bz, 14, 0xd8c49a, 4);
  setVignette(true);
  domFlash();
  const line = (e.taunts && e.taunts[0]) || 'Enough, hero - my real power!';
  showBanner('!! IT IS ENRAGED !!', 'BELOW 30% - NO MERCY', line, '#ff3b30');
  say(line);
}

/* ---------- boss attacks ---------- */
function bossCooldown(a) {
  const now = performance.now() / 1000;
  const last = F.atkTmap[a.id] || -99;
  const cd = a.cooldown_s / (F.enraged ? 1.2 : 1);
  return now - last >= cd;
}
function tacticPrefs(t) {
  if (t === 'pressure') return { want: ['melee', 'lunge'], near: true };
  if (t === 'bombs') return { want: ['aoe_circle', 'projectile', 'cone'], near: false };
  return { want: ['lunge', 'aoe_circle', 'melee'], near: true }; // bait holds ground, punishes the approach
}
/* Per decision: sample a tactic from the brain's weights (uniform floor
 * until the first reply), then a weighted attack from the form's kit
 * biased toward that tactic's patterns. Weighted random, both levels. */
function bossAct() {
  if (!F || F.over || F.paused || F.boss.hp <= 0) return; // boss down: no new attacks while adds are mopped up
  const nowB = performance.now() / 1000;
  if (nowB < (F.slumpUntil || 0)) return; // slumped: punish window runs, no chain
  if (nowB - (F.lastBossAtkT || -99) < BOSS_MIN_GAP_S + BOSS_SLUMP_GAP_S * (F.slumpN || 0)) return; // breathing room between strikes
  const t = sampleTactic(F.tacticWeights);
  F.tactic = t;
  const prefs = tacticPrefs(t);
  const d = dist2(F.px, F.pz, F.bx, F.bz);
  const wantRe = !prefs.near ? 8.5 : 2.3;
  if (F.needApproach) { // post-slump: re-approach before the next strike, no instant chain
    if (d > wantRe + 0.7) return;
    F.needApproach = false;
  }
  const cands = F.cfg.attacks.filter((a) =>
    bossCooldown(a) && (a.pattern === 'projectile' ||
      a.range_px >= 9999 || d <= a.range_px * PX + 2));
  if (!cands.length) return;
  const weights = cands.map((a) => {
    const fw = (F.cfg.weights && F.cfg.weights[a.id]) || 0.1;
    return fw * (prefs.want.indexOf(a.pattern) !== -1 ? 1.5 : 0.6);
  });
  let r = Math.random() * weights.reduce((s, w) => s + w, 0);
  let a = cands[0];
  for (let i = 0; i < cands.length; i++) {
    r -= weights[i];
    if (r <= 0) { a = cands[i]; break; }
  }
  F.atkTmap[a.id] = performance.now() / 1000;
  F.lastBossAtkT = nowB; // global strike gap starts at tell, not impact
  if (a.feint_chance && Math.random() < a.feint_chance) { telegraph(a, true); return; } // hollow lies
  telegraph(a, false);
}

function telegraph(a, fake) {
  const rawW = Number(a.windup_ms); // payload tell with readable floor, never below
  const windup = (isFinite(rawW) && rawW > 0 ? Math.max(rawW, BOSS_WINDUP_FLOOR_MS) : BOSS_WINDUP_FLOOR_MS) / 1000;
  const W = arena.ARENA_X;
  let spec;
  if (a.pattern === 'cone') {
    const ang = Math.atan2(F.px - F.bx, F.pz - F.bz);
    spec = { x: F.bx, z: F.bz, r: 150 * PX, pattern: 'cone', fake, angle: ang, arc: 1.1 };
  } else if (a.pattern === 'summon') {
    spec = { x: 0, z: clamp(F.pz, Math.max(-arena.ARENA_Z + 1.2, FLOOR_Z_MIN), arena.ARENA_Z - 1.2), r: 0, pattern: 'wall', fake, w: W * 2, d: 60 * PX };
  } else if (a.pattern === 'lunge') {
    spec = { x: F.bx, z: F.bz, r: a.range_px * PX * 0.55, pattern: 'circle', fake };
  } else if (a.pattern === 'melee') {
    spec = { x: F.px, z: F.pz, r: 70 * PX, pattern: 'melee', fake };
  } else {
    spec = { x: F.px, z: F.pz, r: a.range_px * PX * 0.55, pattern: 'circle', fake };
  }
  const h = arena.spawnTelegraph(spec);
  const anchor = { ...spec, dirX: Math.sin(spec.angle || 0), dirZ: Math.cos(spec.angle || 0) };
  if (fake) {
    arena.spawnDecoys([[F.bx - 2, F.bz + 1], [F.bx + 2, F.bz + 1]]); // afterimages sell the lie
  }
  later(windup * 1000, () => {
    /* Pause-aware via later(): this windup cannot resolve while a menu is open. */
    arena.popTelegraph(h);
    if (fake) {
      F.events.push('boss feinted');
      arena.clearDecoys();
      spawnPop(anchor.x, 1.6, anchor.z, 'FAKE!', 'miss');
      return;
    }
    resolveAttack(a, anchor);
  });
}

function resolveAttack(a, t) {
  if (!F || F.over || F.paused) return; // paused: no attack resolution
  const nowA = performance.now() / 1000;
  F.slumpUntil = nowA + (Number(a.slump_s) || 1.5); // punish window opens as the attack lands
  F.vulnMult = Number(a.vuln_mult) || 1.5;
  F.slumpN = (F.slumpN || 0) + 1; // each strike stretches the next gap by BOSS_SLUMP_GAP_S
  F.needApproach = true; // must walk back into range before the next tell
  const dmg = Math.max(1, Math.round(a.damage * F.dmgMul * (F.bossDmgMul || 1))); // enrage × descent escalation
  if (a.pattern === 'projectile') {
    const id = 'p' + (F.projSeq++);
    const dx = F.px - F.bx, dz = F.pz - F.bz;
    const m = Math.hypot(dx, dz) || 1;
    const sp = 260 * PX;
    F.projectiles.push({ id, x: F.bx, z: F.bz, vx: (dx / m) * sp, vz: (dz / m) * sp, dmg, life: 2.5 });
    arena.spawnProjectile(id, F.bx, F.bz);
  } else if (a.pattern === 'summon') {
    arena.dust(t.x, t.z, 8, 0xd8c49a, 5); // erupting thorns kick dirt
    arena.shake(0.4);
  } else if (a.pattern === 'lunge') {
    if (a.id === 'blink') {
      // wraith teleport-strike: it is simply THERE now (ignores floor hazards)
      const dx = F.px - F.bx, dz = F.pz - F.bz;
      const m = Math.hypot(dx, dz) || 1;
      const bp = clampArena({ x: F.px - (dx / m) * 1.2, z: F.pz - (dz / m) * 1.2 }, BOUND_BOSS_M, arena.ARENA_X, arena.ARENA_Z);
      F.bx = bp.x; F.bz = bp.z;
      arena.burst(F.bx, F.bz, 0x9fd8e8, 10, 3);
    } else {
      const lp = clampArena({ x: F.bx + (F.px - F.bx) * 0.35, z: F.bz + (F.pz - F.bz) * 0.35 }, BOUND_BOSS_M, arena.ARENA_X, arena.ARENA_Z);
      F.bx = lp.x; F.bz = lp.z; // lunge dashes in, then hits at 1.4x range
    }
    arena.dust(F.bx, F.bz, 6); // landing thud kicks grit even on a miss
    if (dist2(F.px, F.pz, F.bx, F.bz) < 80 * PX * 1.4) hurtPlayer(dmg, a.id);
    else { F.events.push('boss missed'); spawnPop(F.px, 1.8, F.pz, 'WHIFF!', 'miss'); }
  } else if (a.pattern === 'cone') {
    const R = t.r;
    const d = dist2(F.px, F.pz, F.bx, F.bz);
    const angTo = Math.atan2(F.px - F.bx, F.pz - F.bz);
    let diff = Math.abs(angTo - Math.atan2(t.dirX, t.dirZ));
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (d < R + 0.5 && diff < 1.1 / 2 + 0.25) {
      hurtPlayer(dmg, a.id);
      arena.burst(F.px, F.pz, 0xff5a4e, 8, 4);
    } else { F.events.push('boss missed'); spawnPop(F.px, 1.8, F.pz, 'WHIFF!', 'miss'); }
  } else {
    const R = a.pattern === 'melee' ? 70 * PX : a.range_px * PX * 0.55;
    if (dist2(F.px, F.pz, t.x, t.z) < R + 14 * PX) {
      hurtPlayer(dmg, a.id);
      arena.burst(t.x, t.z, 0xff5a4e, 8, 4);
      if (a.pattern === 'aoe_circle') { // slams crater the floor
        arena.spawnCrack(t.x, t.z, Math.random() * Math.PI * 2, a.id === 'slam' ? 1.8 : 1.2);
        arena.dust(t.x, t.z, a.id === 'slam' ? 16 : 10, 0xd8c49a, 4);
        if (a.id === 'slam') arena.shake(0.8);
      }
    } else { F.events.push('boss missed'); spawnPop(F.px, 1.8, F.pz, 'WHIFF!', 'miss'); }
  }
}

/* ---------- per-frame ---------- */
function update(dt) {
  if (!F || F.over || F.paused) return; // paused: simulation frozen, rendering continues
  const now = performance.now() / 1000;
  const W = arena.ARENA_X, H = arena.ARENA_Z;

  // player movement (dash burst overrides stick/keys)
  // INPUT RULE: stick and keyboard never sum raw. The stick is shaped first
  // (deadzone + expo via stickResponse, magnitude preserved at <= 1); the
  // keyboard is digital (diagonals normalised to 1); per axis the keyboard
  // wins when held and the stick fills in otherwise — so the two can
  // neither cancel (opposite inputs) nor double-count (same direction).
  // Final magnitude is clamped to 1: combined input never exceeds base speed.
  const sp = F.stats.speed;
  if (F.dashing > 0) {
    // ease-out burst: fast start, quick decay. p runs 0 (kick) -> 1 (tail);
    // the integral equals the old flat 3.2x (1 + (7.6-1)/3), so dash
    // distance is unchanged — only its delivery. Bounds clamp below covers
    // the burst (same clamp as normal movement).
    const p = clamp(1 - F.dashing / FEEL_DASH_TIME, 0, 1);
    const mult = 1 + (FEEL_DASH_PEAK - 1) * (1 - p) * (1 - p);
    const step = sp * mult * dt;
    F.px += F.dashDx * step;
    F.pz += F.dashDz * step;
    F.dashDist = (F.dashDist || 0) + step;
    F.dashing -= dt;
    if (F.dashDist >= Math.min(W, H) * 2 * FEEL_DASH_MAX_FRAC) F.dashing = 0; // safety cap: never cross the arena
    if (F.dashing <= 0) { F.vx = F.dashDx * sp; F.vz = F.dashDz * sp; } // land at cruise speed, no pop
    else { F.vx = F.dashDx * sp * mult; F.vz = F.dashDz * sp * mult; } // velocity tracks the burst so release is smooth
  } else {
    const sm = Math.hypot(F.joy.dx, F.joy.dz);
    let sx = 0, sz = 0;
    const resp = stickResponse(sm); // 0 below deadzone, <= 1 above — magnitude preserved
    if (resp > 0 && sm > 0) { sx = (F.joy.dx / sm) * resp; sz = (F.joy.dz / sm) * resp; }
    let kx = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    let kz = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
    const km = Math.hypot(kx, kz);
    if (km > 1) { kx /= km; kz /= km; } // digital diagonals run at full speed, not sqrt(2)
    const mx = kx !== 0 ? kx : sx;
    const mz = kz !== 0 ? kz : sz;
    let m = Math.hypot(mx, mz);
    let nx = mx, nz = mz;
    if (m > 1) { nx = mx / m; nz = mz / m; m = 1; } // hybrid key+stick corner: clamp, never boost
    const tvx = nx * sp, tvz = nz * sp; // target velocity: analog magnitude, never above base speed
    const cur = Math.hypot(F.vx || 0, F.vz || 0);
    const tgt = Math.hypot(tvx, tvz);
    // accel when speeding up, higher friction when slowing: starts weighty, stops crisp.
    // frame-rate independent exponential chase (1-exp(-rate*dt)), not a fixed lerp.
    const rate = tgt > cur ? FEEL_ACCEL_RATE : FEEL_FRICTION_RATE;
    const k = 1 - Math.exp(-rate * dt);
    F.vx = (F.vx || 0) + (tvx - (F.vx || 0)) * k;
    F.vz = (F.vz || 0) + (tvz - (F.vz || 0)) * k;
    const vmag = Math.hypot(F.vx, F.vz); // hard cap: cruise never exceeds base speed
    if (vmag > sp * HERO_MAX_SPEED_MUL && vmag > 0) { F.vx *= sp * HERO_MAX_SPEED_MUL / vmag; F.vz *= sp * HERO_MAX_SPEED_MUL / vmag; }
    if (tgt < 0.05 * sp && Math.hypot(F.vx, F.vz) < 0.02 * sp) { F.vx = 0; F.vz = 0; } // settle: no endless glide
    F.px += F.vx * dt;
    F.pz += F.vz * dt;
    F.moved10 += Math.hypot(F.vx, F.vz) * dt;
    if (m > 0.05) {
      // turn feel: chase the input heading at TURN_RATE — pivots read as
      // turns, not teleports. Attack auto-face (tryAttack) stays instant.
      const want = Math.atan2(nx, nz);
      const diff = ((want - F.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const maxTurn = FEEL_TURN_RATE * dt;
      F.facing += clamp(diff, -maxTurn, maxTurn);
    } else {
      F.stillSecs = (F.stillSecs || 0) + dt; // habit hook: time spent not moving feeds stationary_ratio
    }
  }
  F.movedDecay += dt;
  if (F.movedDecay > 10) { F.moved10 = 0; F.movedDecay = 0; }
  { const pt = { x: F.px, z: F.pz }; clampArena(pt, BOUND_HERO_M, W, H); collidePillars(pt, 0.5); F.px = pt.x; F.pz = pt.z; }
  arena.heroPos(F.px, F.pz, F.facing, now < F.ifrT, F.dashing > 0); // iframes drive hero.blink in the renderer

  // dash charges refill one per dashCd while below max
  // (unreachable while paused — update returns above, so the refill freezes)
  if (F.dashLeft < F.stats.dashCharges) {
    F.dashRefillT += dt;
    if (F.dashRefillT >= F.stats.dashCd) { F.dashLeft++; F.dashRefillT = 0; }
  }

  // boss movement: approach / strafe by sampled tactic (rooted during slump, down during mop-up)
  const prefs = tacticPrefs(F.tactic || 'pressure');
  const dx = F.px - F.bx, dz = F.pz - F.bz;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d, nz = dz / d;
  const want = !prefs.near ? 8.5 : 2.3;
  const slumped = now < (F.slumpUntil || 0);
  const bs = ((F.bossMovePxS || F.cfg.move_speed) * PX * F.speedMul) * (slumped || F.boss.hp <= 0 ? 0 : 1);
  const dir = d > want + 0.7 ? 1 : (d < want - 0.7 ? -1 : 0);
  const strafe = Math.sin(now * 1.3) * 0.7;
  { const pt = { x: F.bx + (nx * dir - nz * strafe * 0.5) * bs * dt, z: F.bz + (nz * dir + nx * strafe * 0.5) * bs * dt }; clampArena(pt, BOUND_BOSS_M, W, H); collidePillars(pt, 0.7); F.bx = pt.x; F.bz = pt.z; }
  arena.bossPos(F.bx, F.bz);
  arena.bossFace(Math.atan2(F.px - F.bx, F.pz - F.bz));

  // adds: chasers seek, lobbers hold range and lob (markers ride arena projectiles)
  for (let i = (F.minions || []).length - 1; i >= 0; i--) {
    const m = F.minions[i];
    m.age = (m.age || 0) + dt;
    const graced = m.age < MINION_GRACE_S; // spawn grace: moves but cannot harm
    const mdx = F.px - m.x, mdz = F.pz - m.z;
    const md = Math.hypot(mdx, mdz) || 1;
    if (m.kind === 'lobber') {
      const hold = md > 7 ? 1 : (md < 5.5 ? -1 : 0);
      m.x += (mdx / md) * hold * m.speed * dt;
      m.z += (mdz / md) * hold * m.speed * dt;
      m.lobT -= dt;
      if (m.lobT <= 0 && F.boss.hp > 0 && !graced) {
        const live = F.projectiles.filter((p) => p.owner === m.id).length; // max 1 live lob per lobber
        if (live < 1) {
          m.lobT = LOBBER_INTERVAL_S;
          const id = 'q' + (F.projSeq++);
          F.projectiles.push({ id, owner: m.id, x: m.x, z: m.z, vx: (mdx / md) * 260 * PX, vz: (mdz / md) * 260 * PX, dmg: m.dmg, life: 2.5, why: 'lob' });
          arena.spawnProjectile(id, m.x, m.z);
        } else m.lobT = 0.5; // retry soon once the live lob lands or dies
      } else if (m.lobT <= 0) m.lobT = LOBBER_INTERVAL_S;
    } else {
      m.x += (mdx / md) * m.speed * dt;
      m.z += (mdz / md) * m.speed * dt;
      m.cool -= dt;
      if (md < 0.9 && m.cool <= 0 && !graced) { m.cool = CHASER_COOL_S; hurtPlayer(m.dmg, m.kind); }
    }
    { const pt = { x: m.x, z: m.z }; clampArena(pt, BOUND_MINION_M, W, H); m.x = pt.x; m.z = pt.z; }
    collidePillars(m, 0.4);
    arena.moveProjectile('mx' + m.id, m.x, m.z);
  }

  // boss attacks on cooldowns
  F.actT += dt;
  if (F.actT > 1.2) { F.actT = 0; bossAct(); }

  // projectiles (unreachable while paused — update returns above, so impacts freeze)
  for (let i = F.projectiles.length - 1; i >= 0; i--) {
    const pr = F.projectiles[i];
    pr.x += pr.vx * dt; pr.z += pr.vz * dt; pr.life -= dt;
    arena.moveProjectile(pr.id, pr.x, pr.z);
    if (pr.hero) {
      let spent = false;
      if (F.boss.hp > 0 && dist2(F.bx, F.bz, pr.x, pr.z) < 0.75) {
        const vuln = performance.now() / 1000 < (F.slumpUntil || 0) ? (F.vulnMult || 1.5) : 1; // slump pays 1.5x, same as swings
        const eff = Math.max(1, Math.round(pr.dmg * vuln) - (F.cfg.armour || 0)); // colossus plating taxes bolts too
        F.boss.hp -= eff;
        F.damageDealt = (F.damageDealt || 0) + eff;
        F.events.push('boss hit by special');
        hitstop(0.09);
        arena.burst(F.bx, F.bz, 0xffd75e, 14, 4.5, 1.0 + F.flyY);
        sfx('hit');
        arena.spawnCrack(F.bx, F.bz, Math.random() * Math.PI * 2, 1.0);
        spawnPop(F.bx, 2.1 + F.flyY, F.bz, 'WHAM! -' + eff, 'special');
        if (!REDUCED) arena.shake(0.6);
        else domFlash();
        spent = true;
      } else {
        for (let j = (F.minions || []).length - 1; j >= 0; j--) {
          const m = F.minions[j];
          if (dist2(m.x, m.z, pr.x, pr.z) < 0.75) { hitMinion(m, pr.dmg, true); spent = true; break; }
        }
      }
      if (spent) pr.life = 0; // hero bolts die on the first boss/minion hit
    } else if (dist2(F.px, F.pz, pr.x, pr.z) < 0.75) { hurtPlayer(pr.dmg, pr.why || 'fireball'); pr.life = 0; }
    const pMinZ = Math.max(-H + BOUND_PROJ_M, FLOOR_Z_MIN);
    if (pr.life <= 0 || pr.x < -W + BOUND_PROJ_M || pr.x > W - BOUND_PROJ_M || pr.z < pMinZ || pr.z > H - BOUND_PROJ_M) {
      arena.killProjectile(pr.id);
      F.projectiles.splice(i, 1);
    }
  }
  updateHUD();

  // brain every ~8s (skipped while paused — update returns above; think() also guards)
  F.brainTimer += dt;
  if (F.brainTimer >= 8) { F.brainTimer = 0; think(); }
  // offline fallback: no model, no spawn_call — keep 1 add up if the room is thin
  F.spawnT = (F.spawnT || 0) + dt;
  if (F.spawnT >= 8) {
    F.spawnT = 0;
    if ((F.minions || []).length < 2 && (F.minions || []).length < MINION_CAP && F.boss.hp > 0) spawnMinion(pickKind());
  }

  // taunt balloon follows the boss
  const bal = $('taunt-balloon');
  if (bal && bal.classList.contains('show')) {
    const p = arena.project(F.bx, 2.6 + F.flyY, F.bz);
    const rect = canvas.getBoundingClientRect();
    bal.style.left = (p.x - rect.left) + 'px';
    bal.style.top = (p.y - rect.top) + 'px';
  }

  // endings: the boss is immortal (a kill is a descent transition),
  // the player has one life (death ends the run). Room-clear: the boss
  // staying down with adds alive is mop-up, not a kill — the draft waits
  // until the room is empty.
  if (F.boss.hp <= 0) {
    if ((F.minions || []).length) F.room = 'clear';
    else { F.room = 'exit'; killBoss(); }
  } else if (F.stats.hp <= 0) finish(false);
}

function updateHUD() {
  const S = F.stats;
  setBar('hp-player', S.hp, S.maxHp);
  setBar('hp-boss', F.boss.hp, F.boss.maxHp);
  $('potion-count').textContent = 'POT ×' + S.potionsLeft + (S.potionsLeft ? ' (+' + Math.round(potionHealFor(S.maxHp)) + ')' : ' (empty)');
  $('descent-badge').textContent = 'DESCENT ' + S.descent + ' · LV ' + S.level + ' · XP ' + Math.floor(S.xp) + '/' + xpThreshold(S.level);
  const s = Math.floor((performance.now() - F.startT) / 1000);
  $('clock').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const now = performance.now() / 1000;
  const cd = (t, c) => Math.max(0, c - (now - t));
  const dashReady = (F.dashLeft || 0) > 0;
  const dashTxt = dashReady ? 'READY×' + F.dashLeft
    : fmtCd(Math.max(0, S.dashCd - (F.dashRefillT || 0)));
  $('cooldowns').textContent =
    'ATK ' + fmtCd(cd(F.atkT, S.attackCd)) + '  SPEC ' + fmtCd(cd(F.specT, S.specialCd)) +
    '  DASH ' + dashTxt;
  $('btn-attack').classList.toggle('cool', cd(F.atkT, S.attackCd) > 0);
  $('btn-special').classList.toggle('cool', cd(F.specT, S.specialCd) > 0);
  $('btn-dash').classList.toggle('cool', !dashReady);
  $('btn-potion').classList.toggle('cool', S.potionsLeft <= 0);
  partybar();
}
/* Room HUD: the 4 existing #partybar slots carry hero HP, boss HP, add
 * pips, and depth/XP. No new DOM ids — children are fill-only. */
function partybar() {
  const slots = document.querySelectorAll('#partybar .party-slot');
  if (!slots || slots.length < 4 || !F) return;
  const S = F.stats;
  const fill = (i, frac, cls, txt) => { // bar slots: 0 hero HP, 1 boss HP
    const el = slots[i];
    if (!el.dataset.init) { el.dataset.init = '1'; el.innerHTML = '<div class="pfill"></div><span class="pips"></span>'; }
    el.querySelector('.pfill').style.width = (clamp(frac, 0, 1) * 100).toFixed(1) + '%';
    el.querySelector('.pfill').className = 'pfill ' + cls;
    el.querySelector('.pips').textContent = txt;
  };
  const note = (i, txt) => { // text slots: 2 add pips, 3 depth/XP
    const el = slots[i];
    if (!el.dataset.init) { el.dataset.init = '1'; el.innerHTML = '<span class="pips"></span>'; }
    el.querySelector('.pips').textContent = txt;
  };
  fill(0, S.hp / S.maxHp, 'you', String(Math.max(0, Math.round(S.hp))));
  fill(1, F.boss.hp / F.boss.maxHp, 'boss', String(Math.max(0, Math.round(F.boss.hp))));
  const alive = (F.minions || []).length;
  note(2, '●'.repeat(alive) + '○'.repeat(Math.max(0, MINION_CAP - alive)));
  note(3, 'D' + S.descent + ' ' + Math.floor(S.xp) + '/' + xpThreshold(S.level));
}
function fmtCd(v) { return v > 0 ? v.toFixed(1) + 's' : 'READY'; }
function setBar(id, v, max) {
  const f = Math.max(0, v / max);
  $(id + '-fill').style.width = (f * 100).toFixed(1) + '%';
  $(id + '-num').textContent = Math.max(0, Math.round(v)) + ' / ' + max;
}

/* A kill is a descent transition, not a victory. In order:
 * 1. Boss falls (death juice stays; the arena-impact set-piece is a later lane's job).
 * 2. A record hits F.runHistory (persisted, ≤60).
 * 3. d_next = descent + descent_gain(fight_secs, hp_pct_left, descent).
 * 4. XP threshold crossed → pause + draft, one level-up at a time (loops).
 * 5. Kill potion: potion_heal HP, capped at max — never a full heal (attrition).
 * 6. Descent card: the number, what changed (form + signature tell + windup),
 *    and the boss's read. Never a mystery why it got worse.
 * 7. Boss returns: form/hp/maxHp reset to the new form's scaled pool. */
function killBoss() {
  if (!F || F.over || F.transitioning) return;
  F.transitioning = true;
  // 1. Boss falls.
  // HOOK(arena-impact): the fall wants a crack ring + pooling blood here —
  // a later lane's job. arena.spawnCrack / the blood-decal path own it.
  arena.burst(F.bx, F.bz, 0xffe9a8, 16, 5, 1.0 + F.flyY);
  arena.shake(1.2);
  sfx('clear');
  // 2. Attempt log (full habit shape) + the immortal write: the profile is
  // re-derived and persisted here, so it survives the run that just ended.
  const fightSecs = (performance.now() - F.fightT0) / 1000;
  const hpPctLeft = clamp(F.stats.hp / F.stats.maxHp * 100, 0, 100);
  pushHistory(fightRecord('kill', Math.max(0, Math.round(F.stats.hp))));
  saveHabitProfile();
  grantKillXp(fightSecs);
  // 3. Governor: clean + fast climbs, scrappy wins still advance.
  const dNext = F.stats.descent + descentGain(fightSecs, hpPctLeft, F.stats.descent);
  // 4. Level-ups pause the world; the chain below runs after the last pick.
  setPaused(true);
  processLevelUps(dNext, () => {
    // 5. Kill potion — attrition: a portion, capped, never a full heal.
    const S = F.stats;
    const heal = Math.round(potionHealFor(S.maxHp));
    S.hp = Math.min(S.maxHp, S.hp + heal);
    spawnPop(F.px, 1.8, F.pz, '+' + heal + ' STOLEN BREATH', 'heal');
    refreshPotions();
    // 6+7. Deeper, and it wears whatever the brain last asked for.
    S.descent = dNext;
    saveBest(Math.max(loadBest(), dNext));
    F.fightHpStart = S.hp;
    F.fightT0 = performance.now();
    F.damageDealt = 0; F.lastDamageSource = '';
    F.transformedThisFight = false;
    resetFightTrackers(); // next fight's habit counters start clean (history keeps the old ones)
    const returnForm = F.pendingNextForm || F.lastNextForm || randFormId() || F.boss.form; // no brain word yet: random body, never the same limbo
    F.pendingNextForm = null;
    resetEnrage();
    if (returnForm !== F.boss.form) {
      doTransform(returnForm, false, F.lastRead); // banner carries the read
    } else {
      F.boss.maxHp = roomBossPool(F.cfg, dNext);
      F.boss.hp = F.boss.maxHp;
      F.bossDmgMul = bossDmgMul(dNext);
      F.bossMovePxS = bossMovePxS(F.cfg, dNext);
      arena.burst(F.bx, F.bz, 0xffe9a8, 10, 4, 1.0 + F.flyY);
      const sameRead = F.lastRead || fallbackRead(F.habitProfile); // never a mystery, never blank
      const sub = '\u201CIts read on you: ' + sameRead + '\u201D — ' + 'same body. hungrier.';
      showBanner('DESCENT ' + dNext, F.cfg.name.toUpperCase() + ' GETS UP', sub, css(F.cfg.colour));
    }
    F.transitioning = false;
    setPaused(false); // resume into the descent card
    seedRoom(dNext); // new depth, new pillars; adds start at 0 by construction (room was cleared)
    F.stats.potionsLeft = POTIONS_AT_ENTRY; // room entry resets to exactly 2
    think(); // load-bearing decisions move to the between-fight window
  });
}

function resetEnrage() {
  if (!F) return;
  F.enraged = false;
  F.speedMul = 1; F.dmgMul = 1;
  try { arena.setEnrage(false); } catch { /* visual only */ }
  setVignette(false);
}

/* ---------- XP + level-up draft ---------- */
/* XP is granted on the kill only: ~60–90% of threshold scaled by capped
 * time-survived, ×1.25 kill bonus, ×Bloodlust mult. Death grants nothing —
 * there is no one left to spend it — and idling past the cap gains nothing. */
function expMult() {
  const n = (F && F.build ? F.build.filter((c) => c === 'bloodlust').length : 0);
  return Math.pow(balNum(['cards', 'bloodlust', 'exp_mult'], 1.4), n);
}
function grantKillXp(fightSecs) {
  const S = F.stats;
  const t = xpThreshold(S.level);
  const cap = (BAL && BAL.descent_par && Number(BAL.descent_par.time_cap_s)) || XP_TIME_CAP_FALLBACK_S;
  const frac = 0.6 + 0.3 * (Math.min(Math.max(0, fightSecs), cap) / cap);
  S.xp += Math.round(t * frac * 1.25 * expMult());
}

/* The six cards (ids match GET /api/balance's card table; stone_skin with
 * the underscore). Effect numbers read live from BAL so tier-2/deep values
 * land without a client change. */
const CARD_ORDER = ['vigour', 'edge', 'swiftness', 'marrow', 'stone_skin', 'bloodlust'];
const CARD_ACCENT = {
  vigour: 'var(--moss)', edge: 'var(--gold)', swiftness: 'var(--hero)',
  marrow: 'var(--smoke)', stone_skin: 'var(--dust)', bloodlust: 'var(--danger)',
};
function cardName(id) {
  return { vigour: 'Vigour', edge: 'Edge', swiftness: 'Swiftness', marrow: 'Marrow', stone_skin: 'Stone Skin', bloodlust: 'Bloodlust' }[id] || id;
}
function cardFx(id, descent) {
  const deep = descent >= tier2Descent();
  const cards = (BAL && BAL.cards) || {};
  const num = (obj, k, fb) => { const n = Number(obj && obj[k]); return isFinite(n) ? n : fb; };
  if (id === 'vigour') { const v = num(cards.vigour, deep ? 'max_hp_tier2' : 'max_hp', deep ? 40 : 25); return '+' + v + ' max HP, healed at once'; }
  if (id === 'edge') { const v = num(cards.edge, deep ? 'melee_dmg_tier2' : 'melee_dmg', deep ? 5 : 3); return '+' + v + ' melee damage'; }
  if (id === 'swiftness') { const m = num(cards.swiftness, 'cooldown_mult', 0.9), f = num(cards.swiftness, 'cooldown_floor_s', 0.3); return 'attack cooldown ×' + m + ' (floor ' + f + 's)'; }
  if (id === 'marrow') { const c = num(cards.marrow, 'dash_charges', 1), r = num(cards.marrow, 'dash_cd_reduction_s', 0.5); return '+' + c + ' dash charge, −' + r + 's refill'; }
  if (id === 'stone_skin') { const v = num(cards.stone_skin, 'dmg_reduction', 1), f = num(cards.stone_skin, 'dmg_taken_floor', 1); return '−' + v + ' damage taken (floor ' + f + ')'; }
  if (id === 'bloodlust') { const m = num(cards.bloodlust, 'exp_mult', 1.4), p = num(cards.bloodlust, 'max_hp_penalty', 8); return '+' + Math.round((m - 1) * 100) + '% XP, but −' + p + ' max HP'; }
  return id;
}
/* Draw weighting: counter the body you are about to face (the brain's
 * pending/last next_form when it has spoken, else the body just killed).
 * colossus (armoured, slow, slam): Stone Skin eats the per-swing armour tax,
 * Marrow steps out of the slam ring, Vigour survives the heavy phase.
 * hollow (450ms tells, feints): Edge/Swiftness punish the short honest
 * windows, Marrow repositions through the lies.
 * wraith (fast, blink-strike): Marrow/Swiftness match its tempo, Edge trades.
 * crawler (baseline): even — nothing to counter yet.
 * Bloodlust always trails (0.7): a trade, never a counter. */
// # ponytail: fixed weight table, no re-roll; add a re-roll only if drafts feel dead.
function cardWeightsFor(formId) {
  const w = { vigour: 1, edge: 1, swiftness: 1, marrow: 1, stone_skin: 1, bloodlust: 0.7 };
  if (formId === 'colossus') { w.stone_skin = 3; w.marrow = 2.5; w.vigour = 1.5; w.edge = 1.5; }
  else if (formId === 'hollow') { w.edge = 2.5; w.swiftness = 2.5; w.marrow = 1.5; }
  else if (formId === 'wraith') { w.marrow = 2.5; w.swiftness = 2; w.edge = 1.5; }
  return w;
}
function counterNote(id, formId) {
  const N = {
    'colossus|stone_skin': 'Eats the stone armour tax',
    'colossus|marrow': 'Out-steps the slam ring',
    'colossus|vigour': 'Survives the heavy phase',
    'colossus|edge': 'Races the big pool',
    'hollow|edge': 'Punishes the short windows',
    'hollow|swiftness': 'Beats the feint',
    'hollow|marrow': 'Repositions through the lies',
    'wraith|marrow': 'Dodges the blink-strike',
    'wraith|swiftness': 'Matches its tempo',
    'wraith|edge': 'Trades up close',
  };
  return N[formId + '|' + id] || '';
}
function drawCards(formId) {
  const w = cardWeightsFor(formId);
  const bag = CARD_ORDER.slice();
  const picks = [];
  for (let n = 0; n < 3 && bag.length; n++) {
    let total = 0;
    for (const id of bag) total += w[id] || 0;
    let r = Math.random() * total;
    let pick = bag[0];
    for (const id of bag) { r -= w[id] || 0; if (r <= 0) { pick = id; break; } }
    picks.push(pick);
    bag.splice(bag.indexOf(pick), 1);
  }
  return picks;
}
function applyCard(id, descent) {
  const S = F.stats;
  const cards = (BAL && BAL.cards) || {};
  const num = (obj, k, fb) => { const n = Number(obj && obj[k]); return isFinite(n) ? n : fb; };
  const deep = descent >= tier2Descent();
  if (id === 'vigour') {
    const v = num(cards.vigour, deep ? 'max_hp_tier2' : 'max_hp', deep ? 40 : 25);
    S.maxHp += v; S.hp = Math.min(S.maxHp, S.hp + v); // heals the difference
  } else if (id === 'edge') {
    S.damage += num(cards.edge, deep ? 'melee_dmg_tier2' : 'melee_dmg', deep ? 5 : 3);
  } else if (id === 'swiftness') {
    const floor = num(cards.swiftness, 'cooldown_floor_s', 0.3);
    S.attackCd = Math.max(floor, S.attackCd * num(cards.swiftness, 'cooldown_mult', 0.9)); // multiplicative: never negative
  } else if (id === 'marrow') {
    S.dashCharges += num(cards.marrow, 'dash_charges', 1);
    S.dashCd = Math.max(0.4, S.dashCd - num(cards.marrow, 'dash_cd_reduction_s', 0.5)); // # ponytail: 0.4s local floor so marrow still cuts the 0.9s base, not balance truth
    F.dashLeft = Math.min(S.dashCharges, (F.dashLeft || 0) + 1);
  } else if (id === 'stone_skin') {
    S.dmgReduction = (S.dmgReduction || 0) + num(cards.stone_skin, 'dmg_reduction', 1);
  } else if (id === 'bloodlust') {
    S.maxHp = Math.max(1, S.maxHp - num(cards.bloodlust, 'max_hp_penalty', 8));
    S.hp = Math.min(S.hp, S.maxHp);
  }
  F.build.push(id);
}
/* One level-up at a time; loops while XP covers further thresholds. The
 * world stays paused across chained drafts — a single overlay owns the
 * pause throughout (see setPaused). */
function processLevelUps(dNext, done) {
  const S = F.stats;
  if (S.xp < xpThreshold(S.level)) { done(); return; }
  S.xp -= xpThreshold(S.level);
  S.level++;
  const upcoming = F.pendingNextForm || F.lastNextForm || F.boss.form;
  showDraft(drawCards(upcoming), upcoming, dNext, () => processLevelUps(dNext, done));
}
let draftOpen = false;
function showDraft(picks, formId, descent, cb) {
  draftOpen = true;
  const def = formById(formId);
  $('draft-title').textContent = 'TAKE A SCAR — LV ' + F.stats.level;
  $('draft-sub').textContent = def
    ? 'It comes back wearing ' + def.name + '. Take what counters it.'
    : 'It comes back hungry. Take what keeps you breathing.';
  const box = $('draft-cards');
  box.innerHTML = '';
  picks.forEach((id, i) => {
    const b = document.createElement('button');
    b.className = 'draft-card';
    b.setAttribute('role', 'option');
    b.style.setProperty('--accent', CARD_ACCENT[id] || 'var(--gold)');
    const deep = descent >= tier2Descent();
    b.innerHTML =
      '<span class="key">' + (i + 1) + '</span>' +
      '<span class="draft-meta"><span class="draft-name">' + cardName(id).toUpperCase() + '</span>' +
      '<span class="draft-fx">' + cardFx(id, descent) + '</span>' +
      (counterNote(id, formId) ? '<span class="draft-why">' + counterNote(id, formId) + '</span>' : '') +
      '</span>' +
      (deep ? '<span class="draft-tier">DEEP TIER</span>' : '');
    b.addEventListener('click', () => choose(i));
    box.appendChild(b);
  });
  $('screen-draft').classList.add('active');
  const btns = box.querySelectorAll('button');
  if (btns[0]) btns[0].focus();
  const onKey = (e) => {
    if (!draftOpen) return;
    const idx = ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3'].indexOf(e.code) % 3;
    if (idx >= 0 && picks[idx]) { e.preventDefault(); choose(idx); }
  };
  showDraft._onKey = onKey;
  window.addEventListener('keydown', onKey);
  function choose(i) {
    if (!draftOpen) return;
    applyCard(picks[i], descent);
    hideDraft();
    cb();
  }
}
function hideDraft() {
  if (!draftOpen) { const s = $('screen-draft'); if (s) s.classList.remove('active'); return; }
  draftOpen = false;
  if (showDraft._onKey) window.removeEventListener('keydown', showDraft._onKey);
  $('screen-draft').classList.remove('active');
}

/* Pause menu: same single-flag discipline as the draft (see setPaused) —
 * pauseOpen only tracks the overlay; F.paused stays the one freeze flag.
 * No timers here: opening/resuming is synchronous, so nothing can tick while paused. */
let pauseOpen = false;
function openPause() {
  if (pauseOpen || draftOpen || state !== 'fight' || !F || F.over) return;
  pauseOpen = true;
  setPaused(true);
  syncPauseMute();
  $('screen-pause').classList.add('active');
}
function hidePause() {
  pauseOpen = false;
  const s = $('screen-pause');
  if (s) s.classList.remove('active');
}
function resumePause() {
  if (!pauseOpen) return;
  hidePause();
  setPaused(false);
}
function syncPauseMute() {
  const b = $('btn-pause-mute');
  if (b) b.textContent = isMuted() ? 'SOUND: OFF' : 'SOUND: ON';
}

function finish(won) {
  if (F.over) return;
  F.over = true;
  F.won = won;
  if (!won) {
    sfx('death');
    // Death ends the run: log the final fight (full habit shape), bank the
    // deepest descent, and persist the profile — this write is what the next
    // run's first brain call reads.
    pushHistory(fightRecord('death', 0));
    saveHabitProfile();
    saveBest(Math.max(loadBest(), F.stats.descent));
  }
  setVignette(false);
  arena.clearDecoys();
  const secs = (performance.now() - F.startT) / 1000;
  const hpLeft = Math.max(0, Math.round(F.stats.hp));
  const score = scoreFor(secs, hpLeft);
  const r = { won, secs, hpLeft, score };
  showBanner('SO CLOSE, HERO', 'THAT THING GOT LUCKY', 'shake it off - you were learning its moves', '#ff5a4e');
  const mySeq = F.mySeq;
  /* Pause-aware: the end screen waits out any open overlay instead of stacking on it. */
  const show = () => {
    if (!F || F.mySeq !== mySeq) return;
    if (F.paused) { setTimeout(show, 200); return; }
    showEnd(r);
  };
  setTimeout(show, 600);
}

/* ---------- input: joystick + buttons + keyboard ---------- */
const keys = new Set();

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (state === 'fight' && GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'KeyM') { toggleMute(); syncMuteBtn(); syncPauseMute(); return; } // mute works from any screen
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (state !== 'fight' || !F || F.over || draftOpen) return; // draft/end overlays own the pause — not us
      e.preventDefault();
      if (pauseOpen) resumePause(); else openPause();
      return;
    }
    if (state !== 'fight' || !F || F.over || F.paused) return; // paused: inputs frozen
    if (e.code === 'KeyJ' || e.code === 'Space') tryAttack(false);
    else if (e.code === 'KeyK' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') tryDash();
    else if (e.code === 'KeyL' || e.code === 'KeyE') tryAttack(true);
    else if (e.code === 'KeyU' || e.code === 'KeyQ') tryPotion();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // joystick (left thumb, ground-plane: screen-right = +X, screen-up = -Z)
  // bound ONLY to #joy-zone (bottom-left); touches starting on the action
  // buttons (#fight-btns, separate element, right side) never reach here,
  // so the stick and the buttons cannot fight over a touch. Targets stay
  // >=64px (buttons 68-76px, stick zone 44vw x 46vh).
  const zone = $('joy-zone');
  const knob = $('joy-knob');
  const base = $('joy-base');
  const resetJoyVisual = () => {
    base.classList.remove('on');
    knob.classList.remove('on');
    setKnob(0, 0);
  };
  const releaseJoy = () => {
    if (!F) return;
    F.joy.active = false;
    F.joy.id = null;
    F.joy.dx = 0; F.joy.dz = 0;
    resetJoyVisual();
  };
  // blur clears keys AND the stick: a stuck stick after alt-tab is the
  // worst bug in this category, so both reset here (keys.clear was already
  // present; the stick reset is new).
  window.addEventListener('blur', () => { keys.clear(); releaseJoy(); });
  const setKnob = (dx, dy) => { knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; };
  zone.addEventListener('pointerdown', (e) => {
    if (!F || state !== 'fight' || F.paused || F.joy.active) return; // paused: stick stays dead
    F.joy.active = true;
    F.joy.id = e.pointerId;
    F.joy.cx = e.clientX; F.joy.cy = e.clientY;
    F.joy.dx = 0; F.joy.dy = 0; F.joy.dz = 0;
    base.style.left = e.clientX + 'px';
    base.style.top = e.clientY + 'px';
    base.classList.add('on');
    knob.style.left = e.clientX + 'px';
    knob.style.top = e.clientY + 'px';
    knob.classList.add('on');
    setKnob(0, 0);
    zone.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  zone.addEventListener('pointermove', (e) => {
    if (!F || !F.joy.active || e.pointerId !== F.joy.id) return;
    let dx = e.clientX - F.joy.cx, dy = e.clientY - F.joy.cy;
    const m = Math.hypot(dx, dy), max = 48;
    if (m > max) { dx *= max / m; dy *= max / m; }
    F.joy.dx = dx / max; F.joy.dz = dy / max;
    setKnob(dx, dy);
    e.preventDefault();
  });
  const end = (e) => {
    if (!F || !F.joy.active || (e.pointerId !== undefined && e.pointerId !== F.joy.id)) return;
    F.joy.active = false;
    F.joy.id = null;
    F.joy.dx = 0; F.joy.dz = 0;
    base.classList.remove('on');
    knob.classList.remove('on');
    setKnob(0, 0);
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
  // pointer capture is held on the zone, so a release outside it still
  // fires pointerup — but a lost capture without up/cancel (edge cases on
  // some mobile browsers) must also release, or the stick sticks.
  zone.addEventListener('lostpointercapture', end);

  const press = (id, fn) => {
    const b = $(id);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
  };
  press('btn-attack', () => tryAttack(false));
  press('btn-special', () => tryAttack(true));
  press('btn-dash', tryDash);
  press('btn-potion', tryPotion);
}

/* ---------- boot ---------- */
function resizeArena() {
  if (!arena || !canvas) return;
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  arena.resize(w, h);
}

function boot() {
  canvas = $('arena-canvas');
  arena = createArena(canvas, { reducedMotion: REDUCED });
  bindInput();
  // controls card on the menu
  $('controls-list').innerHTML = KEYMAP.map(([k, v]) =>
    '<li><b>' + k + '</b><span>' + v + '</span></li>').join('');
  buildMenu();
  showScreen('menu');
  const mb = $('btn-mute');
  if (mb) { syncMuteBtn(); mb.onclick = () => { toggleMute(); syncMuteBtn(); syncPauseMute(); sfx('ui'); }; }
  $('btn-resume').onclick = () => { resumePause(); sfx('ui'); };
  $('btn-restart').onclick = () => { hidePause(); startFight(); };
  const pm = $('btn-pause-mute');
  if (pm) { syncPauseMute(); pm.onclick = () => { toggleMute(); syncMuteBtn(); syncPauseMute(); sfx('ui'); }; }
  $('btn-quit').onclick = () => { hidePause(); if (F) setPaused(false); buildMenu(); showScreen('menu'); };
  const fit = () => resizeArena();
  window.addEventListener('resize', fit);
  fit();

  let last = performance.now();
  const loop = (t) => {
    const rawDt = (t - last) / 1000;
    const dt = Math.min(rawDt, 0.05);
    last = t;
    let frozen = false;
    /* paused: skip simulation, keep rendering (arena.frame still runs below) */
    if (state === 'fight' && F && !F.over && !F.paused) {
      if (F.stopT > 0) { // impact freeze: hold the frame, burn the timer
        F.stopT -= rawDt;
        frozen = true;
      } else {
        try { update(dt); } catch (err) { console.error(err); }
      }
    }
    try { arena.frame(frozen ? 0 : dt, t / 1000); } catch (err) { console.error(err); }
    requestAnimationFrame(loop);
  };

  api('/api/bosses').then((data) => {
    BOSS = data.boss || (data.bosses && data.bosses[0]);
    FORMS = data.forms || data.bosses || [];
    ENRAGE = (BOSS && BOSS.enrage) || {};
    return loadBalance().catch(() => null);
  }).then(() => {
    buildMenu();
    // idle diorama behind the menu
    const first = formById('crawler') || FORMS[0];
    if (first) {
      arena.setBoss((first.visual && first.visual.recipe) || 'courier', first.visual || {});
      arena.heroPos(3.2, 2.5, -0.6, false, false);
      arena.bossPos(-3.0, -2.5);
      arena.bossFace(0.6);
    }
    try {
      const tris = arena.countTris();
      console.log('[arena] tris', JSON.stringify(tris), 'draws~', arena.drawCalls());
    } catch (e) { /* diagnostics only */ }
    requestAnimationFrame(loop);
  }).catch(() => {
    $('menu-status').textContent = 'Could not reach the game server. Check your connection and reload.';
    requestAnimationFrame(loop);
  });
}

document.addEventListener('DOMContentLoaded', boot);
