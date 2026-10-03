/* Boss vs You — 3D arena-battler client. Plain JS module, no bundler.
 *
 * One immortal boss, four forms, no win condition. The menu goes straight
 * into descent 1; a kill is a descent transition (new form, fresh pool),
 * death ends the run.
 *
 * DESIGNER HOOKS (stable names for a later visual pass):
 * DOM screens: #screen-menu, #screen-end (sections, .active shows)
 * HUD: #hud, #hp-player-fill, #hp-player-num, #hp-boss-fill, #hp-boss-num,
 *   #boss-name, #clock, #cooldowns, #potion-count, #hint-bar
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
 * localStorage: none. The old 'bvy-ladder' key (three-boss ladder progress)
 *   existed only for the selection screen and is deleted with it; attempt
 *   log / best-descent persistence land with the learning lane.
 *
 * Combat contract (matches bosses.py numbers exactly):
 * player HP 100, melee dmg 8 @ 0.6s, special 25 @ 12s, dash i-frames 0.25s @ 4s,
 * potion heal 30 x2. Brain ticks every ~8s; tactics arrive as WEIGHTS and
 * are sampled per decision (see sampleTactic); uniform floor until the first
 * reply lands so the boss is never inert.
 *
 * Fight state (F) — single mutable per-run object:
 *   F.stats: live player numbers (maxHp, hp, damage, specialDmg, attackCd,
 *     specialCd, dashCd, dashCharges, speed, atkRange, specialRange,
 *     potionHeal, potionsLeft, level, xp, descent). Draft/level-up code
 *     mutates these live; nothing caches them elsewhere.
 *   F.boss: { form, hp, maxHp } — the current form's live pool. A transform
 *     resets form/maxHp/hp together. F.maxHp aliases F.boss.maxHp. Never use
 *     F.cfg.hp for live math (it is the design-time value).
 *   F.paused: true while any menu/draft/overlay is open. Simulation
 *     (update + all deferred damage) freezes; rendering continues.
 *   F.lastAppliedSeq: seq guard — brain replies with seq <= this are stale.
 *   F.transformedThisFight / F.pendingNextForm: client half of the
 *     one-mid-fight-transform-per-fight rule (see applyBrain).
 */
import { createArena } from './arena.js';

/* single immortal boss: forms arrive from /api/bosses, never hardcoded */
const PX = 1 / 30; // legacy px -> world units (arena ~22 x 16 units)
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
    attackCd: 0.6, specialCd: 12, dashCd: 4, dashCharges: 1,
    speed: 220 * PX, atkRange: 100 * PX, specialRange: 150 * PX,
    potionHeal: 30, potionsLeft: 2,
    level: 1, xp: 0, descent: 1,
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
  $('menu-status').textContent = 'It is waiting below. It remembers you.';
  $('btn-fight').onclick = () => startFight();
}

function showEnd(r) {
  $('end-kicker').textContent = 'THE RUN ENDS';
  $('end-title').textContent = 'IT GETS UP. YOU DO NOT.';
  $('end-flavour').textContent = '\u201C' + (F.lastTaunt || 'Down here, hero.') + '\u201D';
  const m = Math.floor(r.secs / 60), s = Math.floor(r.secs % 60);
  $('end-stats').innerHTML =
    statCard('TIME', m + ':' + String(s).padStart(2, '0')) +
    statCard('DESCENT', String(F.stats.descent)) +
    statCard('SCORE', String(r.score));
  $('end-ladder').textContent = 'One life. No win. Descend again.';
  $('btn-rematch').onclick = () => startFight();
  const nb = $('btn-next');
  if (nb) nb.style.display = 'none';
  const bb = $('btn-bosses');
  if (bb) bb.onclick = () => showScreen('menu');
  showScreen('end');

  function statCard(k, v) {
    return '<div class="stat-card"><span class="stat-k">' + k + '</span><span class="stat-v">' + v + '</span></div>';
  }
}

/* ---------- fight setup ---------- */
function startFight() {
  const cfg = formById('crawler') || FORMS[0];
  if (!cfg) return; // forms not loaded yet — menu stays until /api/bosses lands
  const mySeq = ++fightSeq;
  const W = arena.ARENA_X, H = arena.ARENA_Z;
  F = {
    cfg, mySeq,
    bossId: (BOSS && BOSS.id) || 'the-thing-below',
    paused: false, pauseT0: 0,
    lastAppliedSeq: -1,
    stats: defaultStats(),
    boss: { form: cfg.id, hp: cfg.hp, maxHp: cfg.hp },
    tacticWeights: null, lastNextForm: null, lastTaunt: '',
    transformedThisFight: false, pendingNextForm: null, lastTransformT: -99,
    px: 0, pz: H - 2.5,
    atkT: -99, specT: -99, dashT: -99, ifrT: -99,
    dashDx: 0, dashDz: 0, dashing: 0, facing: Math.PI,
    bx: 0, bz: -H + 2.5, flyY: 0,
    enraged: false, flying: false,
    atkTmap: {}, tactic: 'pressure', speedMul: 1, dmgMul: 1, intensity: 0.5,
    over: false, won: false, startT: performance.now(), tick: 0,
    lastSwitch: -99, events: [], hist: [], brainTimer: 0, stopT: 0,
    projectiles: [], walls: [], projSeq: 0, wallSeq: 0,
    moved10: 0, movedDecay: 0, actT: 0, timeouts: [],
    joy: { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0, dz: 0 },
  };
  /* F.maxHp aliases F.boss.maxHp so a form transform has one live pool to reset. */
  const selfF = F;
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
function doTransform(newForm, isMidFight) {
  const def = formById(newForm);
  if (!def || !F || newForm === F.boss.form) return false;
  F.cfg = def;
  F.boss.form = newForm;
  F.boss.maxHp = def.hp;
  F.boss.hp = def.hp;
  F.enraged = false;
  arena.setBoss((def.visual && def.visual.recipe) || 'courier', def.visual || {});
  arena.clearTelegraphs(); // old windups die with the old body — never resolve stale
  arena.spawnCrack(F.bx, F.bz, Math.random() * Math.PI * 2, 1.6);
  arena.dust(F.bx, F.bz, 14, 0xd8c49a, 4);
  arena.shake(1.0);
  domFlash();
  setVignette(false);
  setBossChrome(def);
  const sig = def.attacks.find((a) => a.id === def.signature) || def.attacks[0];
  showBanner((isMidFight ? 'IT BECOMES — ' : 'DESCENT ' + F.stats.descent + ' — ') + def.name.toUpperCase(),
    'NEW MOVE: ' + sig.id.toUpperCase() + ' — ' + (sig.telegraph_ms / 1000).toFixed(2) + 's WINDUP',
    def.title, css(def.colour));
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

function refreshPotions() {
  if (!F) return;
  const S = F.stats;
  $('potion-count').textContent = 'POT ×' + S.potionsLeft + (S.potionsLeft ? ' (+' + S.potionHeal + ')' : ' (empty)');
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
  $('hint-bar').classList.remove('show');
  const range = special ? S.specialRange : S.atkRange;
  const dmg = special ? S.specialDmg : S.damage;
  F.facing = Math.atan2(F.bx - F.px, F.bz - F.pz); // auto-face boss
  const reach = range + 1.1;
  if (dist2(F.px, F.pz, F.bx, F.bz) <= reach) {
    const eff = Math.max(1, dmg - (F.cfg.armour || 0)); // colossus plating taxes every swing, never immune
    F.boss.hp -= eff;
    F.events.push(special ? 'boss hit by special' : 'boss hit');
    hitstop(special ? 0.09 : 0.05);
    arena.burst(F.bx, F.bz, special ? 0xffd75e : 0xffffff, special ? 14 : 9, 4.5, 1.0 + F.flyY);
    arena.dust(F.bx, F.bz, special ? 12 : 7);
    if (special) arena.spawnCrack(F.bx, F.bz, Math.random() * Math.PI * 2, 1.0);
    spawnPop(F.bx, 2.1 + F.flyY, F.bz, (special ? 'WHAM! -' : 'THWACK! -') + eff, special ? 'special' : 'hit');
    if (!REDUCED) arena.shake(special ? 0.6 : 0.35);
    else domFlash();
  } else {
    spawnPop(F.px, 1.8, F.pz, 'WHIFF!', 'miss');
  }
}

function tryDash() {
  if (!F || F.over || F.paused || state !== 'fight') return; // paused: no movement
  const now = performance.now() / 1000;
  if (now - F.dashT < F.stats.dashCd) return;
  F.dashT = now;
  F.ifrT = now + 0.25;
  F.dashing = 0.18;
  let dx = F.joy.dx, dz = F.joy.dz;
  if (Math.hypot(dx, dz) < 0.2) { // dash away from boss by default
    dx = F.px - F.bx; dz = F.pz - F.bz;
    const m = Math.hypot(dx, dz) || 1; dx /= m; dz /= m;
  } else { const m = Math.hypot(dx, dz); dx /= m; dz /= m; }
  F.dashDx = dx; F.dashDz = dz;
  logHist('dash');
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
  S.hp = Math.min(S.maxHp, S.hp + S.potionHeal);
  refreshPotions();
  F.events.push('player healed');
  arena.burst(F.px, F.pz, 0x7cff6b, 10, 3.5);
  spawnPop(F.px, 1.8, F.pz, '+' + S.potionHeal + ' PATCHED!', 'heal');
}

function hurtPlayer(dmg, why) {
  if (!F || F.over || F.paused) return; // paused: no HP mutation
  const now = performance.now() / 1000;
  if (now < F.ifrT) { // i-frames save you
    if (dmg > 0) spawnPop(F.px, 1.8, F.pz, 'TOO SLOW!', 'heal');
    return;
  }
  F.stats.hp -= dmg;
  F.events.push('player hit' + (why ? ' (' + why + ')' : ''));
  if (dmg > 0) {
    hitstop(0.07);
    arena.burst(F.px, F.pz, 0xff5a4e, 10, 4);
    arena.dust(F.px, F.pz, 8);
    spawnPop(F.px, 2.0, F.pz, '-' + dmg, 'bad');
    arena.shake(0.7);
    domFlash();
  }
}

function logHist(kind) {
  if (!F) return;
  F.hist.push({ t: performance.now() / 1000, kind });
}

/* ---------- brain ---------- */
/* Habit counters, derived client-side (no model tokens spent on arithmetic):
 * stillness vs motion, swing rate, dash rate. The model reads these. */
function habits() {
  if (!F) return {};
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
  if (phase === 'enrage' && !self.enraged) enterEnrage();
  const seq = self.tick++;
  const body = {
    boss_id: self.bossId, tick: seq, seq,
    descent: self.stats.descent, form: self.boss.form,
    boss_hp_pct: Math.round(bossPct), player_hp_pct: Math.round(Math.max(0, self.stats.hp)),
    habits: habits(), build: [],
    fight_secs: (performance.now() - self.startT) / 1000,
    last_damage_source: self.events.length ? self.events[self.events.length - 1] : '',
    history: self.events.slice(-4),
    transforms_this_fight: self.transformedThisFight ? 1 : 0,
    secs_since_transform: now - (self.lastTransformT || -99),
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
    if (!F.transformedThisFight) {
      F.transformedThisFight = true;
      F.lastTransformT = performance.now() / 1000;
      doTransform(F.lastNextForm, true);
    } else {
      F.pendingNextForm = F.lastNextForm;
    }
  }
  if (out.taunt) { F.lastTaunt = out.taunt; say(out.taunt); }
  if (typeof out.intensity === 'number') F.intensity = out.intensity;
}

function enterEnrage() {
  const e = ENRAGE || {};
  F.enraged = true;
  F.speedMul = e.speed_mult || 1.25;
  F.dmgMul = e.damage_mult || 1.25;
  arena.setEnrage(true);
  arena.shake(0.9);
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
  if (!F || F.over || F.paused) return; // paused: no new attacks scheduled
  const t = sampleTactic(F.tacticWeights);
  F.tactic = t;
  const prefs = tacticPrefs(t);
  const d = dist2(F.px, F.pz, F.bx, F.bz);
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
  if (a.feint_chance && Math.random() < a.feint_chance) { telegraph(a, true); return; } // hollow lies
  telegraph(a, false);
}

function telegraph(a, fake) {
  const windup = (a.telegraph_ms || 800) / 1000;
  const W = arena.ARENA_X;
  let spec;
  if (a.pattern === 'cone') {
    const ang = Math.atan2(F.px - F.bx, F.pz - F.bz);
    spec = { x: F.bx, z: F.bz, r: 150 * PX, pattern: 'cone', fake, angle: ang, arc: 1.1 };
  } else if (a.pattern === 'summon') {
    spec = { x: 0, z: clamp(F.pz, -arena.ARENA_Z + 1.2, arena.ARENA_Z - 1.2), r: 0, pattern: 'wall', fake, w: W * 2, d: 60 * PX };
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
  const dmg = Math.round(a.damage * F.dmgMul);
  if (a.pattern === 'projectile') {
    const id = 'p' + (F.projSeq++);
    const dx = F.px - F.bx, dz = F.pz - F.bz;
    const m = Math.hypot(dx, dz) || 1;
    const sp = 260 * PX;
    F.projectiles.push({ id, x: F.bx, z: F.bz, vx: (dx / m) * sp, vz: (dz / m) * sp, dmg, life: 2.5 });
    arena.spawnProjectile(id, F.bx, F.bz);
  } else if (a.pattern === 'summon') {
    const id = 'w' + (F.wallSeq++);
    F.walls.push({ id, x: t.x, z: t.z, w: t.w, d: t.d, dmg, life: 4 });
    arena.spawnWall(id, t.x, t.z, t.w, t.d);
    arena.dust(t.x, t.z, 8, 0xd8c49a, 5); // erupting thorns kick dirt
    arena.shake(0.4);
  } else if (a.pattern === 'lunge') {
    if (a.id === 'blink') {
      // wraith teleport-strike: it is simply THERE now (ignores floor hazards)
      const dx = F.px - F.bx, dz = F.pz - F.bz;
      const m = Math.hypot(dx, dz) || 1;
      F.bx = clamp(F.px - (dx / m) * 1.2, -arena.ARENA_X + 1, arena.ARENA_X - 1);
      F.bz = clamp(F.pz - (dz / m) * 1.2, -arena.ARENA_Z + 1, arena.ARENA_Z - 1);
      arena.burst(F.bx, F.bz, 0x9fd8e8, 10, 3);
    } else {
      F.bx = clamp(F.bx + (F.px - F.bx) * 0.2, -arena.ARENA_X + 1, arena.ARENA_X - 1);
      F.bz = clamp(F.bz + (F.pz - F.bz) * 0.2, -arena.ARENA_Z + 1, arena.ARENA_Z - 1);
    }
    arena.dust(F.bx, F.bz, 6); // landing thud kicks grit even on a miss
    if (dist2(F.px, F.pz, F.bx, F.bz) < 80 * PX) hurtPlayer(dmg, a.id);
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
  const sp = F.stats.speed;
  if (F.dashing > 0) {
    F.dashing -= dt;
    F.px += F.dashDx * sp * 3.2 * dt;
    F.pz += F.dashDz * sp * 3.2 * dt;
  } else {
    let mx = F.joy.dx, mz = F.joy.dz;
    mx += (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    mz += (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
    const m = Math.hypot(mx, mz);
    if (m > 0.01) {
      const c = Math.min(1, m) / (m || 1);
      F.px += mx * c * sp * dt;
      F.pz += mz * c * sp * dt;
      F.moved10 += Math.hypot(mx * c, mz * c) * sp * dt;
      F.facing = Math.atan2(mx * c, mz * c);
    }
  }
  F.movedDecay += dt;
  if (F.movedDecay > 10) { F.moved10 = 0; F.movedDecay = 0; }
  F.px = clamp(F.px, -W + 0.7, W - 0.7);
  F.pz = clamp(F.pz, -H + 0.7, H - 0.7);
  arena.heroPos(F.px, F.pz, F.facing, now < F.ifrT, F.dashing > 0);

  // boss movement: approach / strafe by sampled tactic
  const prefs = tacticPrefs(F.tactic || 'pressure');
  const dx = F.px - F.bx, dz = F.pz - F.bz;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d, nz = dz / d;
  const want = !prefs.near ? 8.5 : 2.3;
  const bs = F.cfg.move_speed * PX * F.speedMul;
  const dir = d > want + 0.7 ? 1 : (d < want - 0.7 ? -1 : 0);
  const strafe = Math.sin(now * 1.3) * 0.7;
  F.bx = clamp(F.bx + (nx * dir - nz * strafe * 0.5) * bs * dt, -W + 1, W - 1);
  F.bz = clamp(F.bz + (nz * dir + nx * strafe * 0.5) * bs * dt, -H + 1, H - 1);
  arena.bossPos(F.bx, F.bz);
  arena.bossFace(Math.atan2(F.px - F.bx, F.pz - F.bz));

  // boss attacks on cooldowns
  F.actT += dt;
  if (F.actT > 1.2) { F.actT = 0; bossAct(); }

  // projectiles + walls (unreachable while paused — update returns above, so impacts freeze)
  for (let i = F.projectiles.length - 1; i >= 0; i--) {
    const pr = F.projectiles[i];
    pr.x += pr.vx * dt; pr.z += pr.vz * dt; pr.life -= dt;
    arena.moveProjectile(pr.id, pr.x, pr.z);
    if (dist2(F.px, F.pz, pr.x, pr.z) < 0.75) { hurtPlayer(pr.dmg, 'fireball'); pr.life = 0; }
    if (pr.life <= 0 || Math.abs(pr.x) > W + 2 || Math.abs(pr.z) > H + 2) {
      arena.killProjectile(pr.id);
      F.projectiles.splice(i, 1);
    }
  }
  for (let i = F.walls.length - 1; i >= 0; i--) {
    const wl = F.walls[i];
    wl.life -= dt;
    if (Math.abs(F.px - wl.x) < wl.w / 2 && Math.abs(F.pz - wl.z) < wl.d / 2 + 0.4) {
      hurtPlayer(wl.dmg, 'thorn-wall');
      wl.life = 0;
    }
    if (wl.life <= 0) { arena.killWall(wl.id); F.walls.splice(i, 1); }
  }

  updateHUD();

  // brain every ~8s (skipped while paused — update returns above; think() also guards)
  F.brainTimer += dt;
  if (F.brainTimer >= 8) { F.brainTimer = 0; think(); }

  // taunt balloon follows the boss
  const bal = $('taunt-balloon');
  if (bal && bal.classList.contains('show')) {
    const p = arena.project(F.bx, 2.6 + F.flyY, F.bz);
    const rect = canvas.getBoundingClientRect();
    bal.style.left = (p.x - rect.left) + 'px';
    bal.style.top = (p.y - rect.top) + 'px';
  }

  // endings: the boss is immortal (a kill is a descent transition),
  // the player has one life (death ends the run)
  if (F.boss.hp <= 0) killBoss();
  else if (F.stats.hp <= 0) finish(false);
}

function updateHUD() {
  const S = F.stats;
  setBar('hp-player', S.hp, S.maxHp);
  setBar('hp-boss', F.boss.hp, F.boss.maxHp);
  $('potion-count').textContent = 'POT ×' + S.potionsLeft;
  const s = Math.floor((performance.now() - F.startT) / 1000);
  $('clock').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const now = performance.now() / 1000;
  const cd = (t, c) => Math.max(0, c - (now - t));
  $('cooldowns').textContent =
    'ATK ' + fmtCd(cd(F.atkT, S.attackCd)) + '  SPEC ' + fmtCd(cd(F.specT, S.specialCd)) +
    '  DASH ' + fmtCd(cd(F.dashT, S.dashCd));
  $('btn-attack').classList.toggle('cool', cd(F.atkT, S.attackCd) > 0);
  $('btn-special').classList.toggle('cool', cd(F.specT, S.specialCd) > 0);
  $('btn-dash').classList.toggle('cool', cd(F.dashT, S.dashCd) > 0);
  $('btn-potion').classList.toggle('cool', S.potionsLeft <= 0);
}
function fmtCd(v) { return v > 0 ? v.toFixed(1) + 's' : 'READY'; }
function setBar(id, v, max) {
  const f = Math.max(0, v / max);
  $(id + '-fill').style.width = (f * 100).toFixed(1) + '%';
  $(id + '-num').textContent = Math.max(0, Math.round(v)) + ' / ' + max;
}

/* A kill is a descent transition, not a victory: the boss always gets
 * up. Honour any transform the client held back (pendingNextForm), else
 * the brain's last next_form, else keep wearing this body with a fresh
 * pool. The mid-fight budget resets — every descent gets one set-piece. */
function killBoss() {
  if (F.over) return;
  const d = ++F.stats.descent;
  F.transformedThisFight = false;
  const returnForm = F.pendingNextForm || F.lastNextForm || F.boss.form;
  F.pendingNextForm = null;
  arena.burst(F.bx, F.bz, 0xffe9a8, 16, 5, 1.0 + F.flyY);
  if (returnForm !== F.boss.form) {
    doTransform(returnForm, false);
  } else {
    F.boss.maxHp = F.cfg.hp;
    F.boss.hp = F.cfg.hp;
    showBanner('DESCENT ' + d, F.cfg.name.toUpperCase() + ' GETS UP', 'same body. hungrier.', css(F.cfg.colour));
  }
  think(); // load-bearing decisions move to the between-fight window
}

function finish(won) {
  if (F.over) return;
  F.over = true;
  F.won = won;
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
    if (state !== 'fight' || !F || F.over || F.paused) return; // paused: inputs frozen
    if (e.code === 'KeyJ' || e.code === 'Space') tryAttack(false);
    else if (e.code === 'KeyK' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') tryDash();
    else if (e.code === 'KeyL' || e.code === 'KeyE') tryAttack(true);
    else if (e.code === 'KeyU' || e.code === 'KeyQ') tryPotion();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  // joystick (left thumb, ground-plane: screen-right = +X, screen-up = -Z)
  const zone = $('joy-zone');
  const knob = $('joy-knob');
  const base = $('joy-base');
  const setKnob = (dx, dy) => { knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'; };
  zone.addEventListener('pointerdown', (e) => {
    if (!F || state !== 'fight' || F.joy.active) return;
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
    F.joy.dx = 0; F.joy.dz = 0;
    base.classList.remove('on');
    knob.classList.remove('on');
    setKnob(0, 0);
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);

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
