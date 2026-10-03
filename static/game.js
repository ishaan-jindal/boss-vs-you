/* Boss vs You — 3D arena-battler client. Plain JS module, no bundler.
 *
 * DESIGNER HOOKS (stable names for a later visual pass):
 * DOM screens: #screen-menu, #screen-select, #screen-end (sections, .active shows)
 * HUD: #hud, #hp-player-fill, #hp-player-num, #hp-boss-fill, #hp-boss-num,
 *   #boss-name, #clock, #cooldowns, #potion-count, #hint-bar
 * Controls: #joy-zone (+ #joy-base, #joy-knob), #btn-attack, #btn-special,
 *   #btn-dash, #btn-potion
 * Juice: #arena-canvas, #pop-layer (.pop, .pop.static for reduced-motion),
 *   #taunt-balloon, #taunt-region (role=status), #bv-banner (+ kicker/title/sub),
 *   #bv-vignette, #bv-flash
 * 3D: static/arena.js exports createArena (fighters, telegraphs, particles)
 * localStorage: 'bvy-ladder' (array of beaten boss ids, in ladder order)
 * Ladder order: ['smoke-courier', 'cinderjaw', 'briar-knight']
 *
 * Combat contract (matches bosses.py numbers exactly):
 * player HP 100, melee dmg 8 @ 0.6s, special 25 @ 12s, dash i-frames 0.25s @ 4s,
 * potion heal 30 x2. Brain ticks every ~8s, tactic switch >= 6s.
 */
import { createArena } from './arena.js';

const LADDER = ['smoke-courier', 'cinderjaw', 'briar-knight'];
const PX = 1 / 30; // legacy px -> world units (arena ~22 x 16 units)
const PLAYER = {
  hp: 100, speed: 220 * PX, atkDmg: 8, atkCd: 0.6, atkRange: 100 * PX,
  dashCd: 4, specialDmg: 25, specialCd: 12, specialRange: 150 * PX,
  potionHeal: 30, potions: 2,
};
const SCORE_BASE = { 'smoke-courier': 1000, cinderjaw: 1500, 'briar-knight': 2000 };
const STARS = { 'smoke-courier': 1, cinderjaw: 2, 'briar-knight': 3 };
const PACE = {
  'smoke-courier': 'FAST - slippery lunges + fake-outs',
  cinderjaw: 'HEAVY - fire cones + skyfire rain',
  'briar-knight': 'CRUEL - counters your mashing',
};
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
function scoreFor(bossId, secs, hpLeft) {
  const base = SCORE_BASE[bossId] || 1000;
  return Math.round(base + Math.max(0, 240 - secs) * 5 + clamp(hpLeft, 0, 100) * 10);
}
function loadLadder() {
  try { return JSON.parse(localStorage.getItem('bvy-ladder') || '[]'); } catch (e) { return []; }
}
function saveLadder(a) { try { localStorage.setItem('bvy-ladder', JSON.stringify(a)); } catch (e) {} }
function unlocked(id, beaten) {
  if (id === LADDER[0]) return true;
  return beaten.indexOf(LADDER[LADDER.indexOf(id) - 1]) !== -1;
}
function api(path, opts) {
  return fetch(path, opts).then((r) => {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
}

/* ---------- DOM juice (all guarded) ---------- */
function showBanner(kicker, title, sub) {
  const b = $('bv-banner');
  if (!b) return;
  $('bv-banner-kicker').textContent = kicker;
  $('bv-banner-title').textContent = title;
  $('bv-banner-sub').textContent = sub || '';
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
let BOSSES = [];
let state = 'menu'; // menu | select | fight | end
let arena = null;
let F = null; // fight state
let fightSeq = 0;
let canvas = null;

function showScreen(name) {
  state = name;
  for (const s of ['menu', 'select', 'end']) {
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

/* ---------- menu / select / end ---------- */
function bossById(id) { return BOSSES.find((b) => b.id === id) || null; }

function buildMenu() {
  const beaten = loadLadder();
  $('menu-status').textContent = beaten.length
    ? 'Ladder: ' + beaten.length + ' / ' + LADDER.length + ' bosses fainted - keep going, hero.'
    : 'Three bosses are waiting. The first one is already talking trash.';
  $('btn-fight').onclick = () => { buildSelect(); showScreen('select'); };
}

function buildSelect() {
  const beaten = loadLadder();
  const wrap = $('boss-cards');
  wrap.innerHTML = '';
  BOSSES.forEach((b, i) => {
    const ok = unlocked(b.id, beaten);
    const done = beaten.indexOf(b.id) !== -1;
    const card = document.createElement('button');
    card.className = 'boss-card' + (ok ? '' : ' locked') + (done ? ' beaten' : '');
    card.style.setProperty('--accent', css(b.colour));
    const stars = [0, 1, 2].map((s) => (s < (STARS[b.id] || 1) ? '★' : '☆')).join('');
    card.innerHTML =
      '<span class="medal" aria-hidden="true">' + (ok ? b.glyph : '×') + '</span>' +
      '<span class="boss-meta"><span class="boss-name">' + (i + 1) + '. ' +
      b.name.toUpperCase() + '</span>' +
      '<span class="boss-pace">' + stars + ' ' + (PACE[b.id] || '') + '</span>' +
      '<span class="boss-title">' + (ok ? b.title : 'LOCKED - beat the previous boss.') + '</span>' +
      '<span class="boss-tease">' + (ok ? '\u201C' + (b.taunt_voice[0] || '') + '\u201D' : '\u201C\u2026\u201D') + '</span></span>' +
      '<span class="ribbon">' + (done ? '★ BEATEN' : ok ? (i === 0 && !beaten.length ? '▶ START HERE' : '▶ FIGHT') : '◆ LOCKED') + '</span>';
    if (ok) card.onclick = () => startFight(b.id);
    else card.disabled = true;
    wrap.appendChild(card);
  });
  $('btn-back-menu').onclick = () => showScreen('menu');
}

function showEnd(r) {
  const beaten = loadLadder();
  $('end-kicker').textContent = r.won ? '★ BOSS FAINTED ★' : 'SO CLOSE, HERO';
  $('end-title').textContent = r.won ? 'WELL FOUGHT, HERO!' : 'THAT BOSS GOT LUCKY';
  $('end-flavour').textContent = r.won
    ? '\u201C' + r.cfg.title + '\u201D - not today.'
    : '\u201C' + (r.cfg.taunt_voice[1] || 'That boss got lucky.') + '\u201D';
  const m = Math.floor(r.secs / 60), s = Math.floor(r.secs % 60);
  $('end-stats').innerHTML = r.won
    ? statCard('TIME', m + ':' + String(s).padStart(2, '0')) +
      statCard('HP LEFT', r.hpLeft + ' ♥') +
      statCard('SCORE', String(r.score))
    : '<p class="end-warm">You were learning its moves - every dodge counts.<br>One tap and you are back in. It is still scared of you.</p>';
  $('end-ladder').textContent = 'Ladder: ' + beaten.length + ' / ' + LADDER.length + ' bosses fainted';
  $('btn-rematch').onclick = () => startFight(r.bossId);
  const next = LADDER[LADDER.indexOf(r.bossId) + 1];
  const nb = $('btn-next');
  if (r.won && next && unlocked(next, beaten)) {
    nb.style.display = '';
    nb.onclick = () => startFight(next);
  } else nb.style.display = 'none';
  $('btn-bosses').onclick = () => { buildSelect(); showScreen('select'); };
  showScreen('end');

  function statCard(k, v) {
    return '<div class="stat-card"><span class="stat-k">' + k + '</span><span class="stat-v">' + v + '</span></div>';
  }
}

/* ---------- fight setup ---------- */
function startFight(bossId) {
  const cfg = bossById(bossId);
  if (!cfg) { buildSelect(); showScreen('select'); return; }
  const mySeq = ++fightSeq;
  const W = arena.ARENA_X, H = arena.ARENA_Z;
  F = {
    cfg, mySeq,
    px: 0, pz: H - 2.5, php: PLAYER.hp, potions: PLAYER.potions,
    atkT: -99, specT: -99, dashT: -99, ifrT: -99,
    dashDx: 0, dashDz: 0, dashing: 0, facing: Math.PI,
    bx: 0, bz: -H + 2.5, flyY: 0, bhp: cfg.hp,
    enraged: false, flying: false, stanceT: 0,
    atkTmap: {}, tactic: cfg.tactics[0].id, speedMul: 1, dmgMul: 1, intensity: 0.5,
    over: false, won: false, startT: performance.now(), tick: 0,
    lastSwitch: -99, events: [], hist: [], brainTimer: 0,
    projectiles: [], walls: [], projSeq: 0, wallSeq: 0,
    moved10: 0, movedDecay: 0, actT: 0, timeouts: [],
    joy: { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0, dz: 0 },
  };
  arena.setBoss((cfg.visual && cfg.visual.recipe) || bossIdToRecipe(bossId), cfg.visual || {});
  arena.clearTelegraphs();
  for (const pr of F.projectiles) arena.killProjectile(pr.id);
  for (const wl of F.walls) arena.killWall(wl.id);
  F.projectiles = []; F.walls = [];
  setVignette(false);
  $('boss-name').textContent = '◆ ' + cfg.name.toUpperCase();
  $('boss-name').style.color = css(cfg.colour);
  $('hint-bar').classList.toggle('show', loadLadder().length === 0);
  refreshPotions();
  showScreen('fight');
  resizeArena();
  /* boss intro splash */
  showBanner('ROUND ' + (LADDER.indexOf(bossId) + 1) + ' OF ' + LADDER.length,
    cfg.name.toUpperCase() + ' SMASHES IN!', cfg.title);
  say(cfg.taunt_voice[0] || ('I am ' + cfg.name + '!'));
  arena.shake(0.5);
  think(true);
}

function bossIdToRecipe(id) {
  return { 'smoke-courier': 'courier', cinderjaw: 'cinderjaw', 'briar-knight': 'knight' }[id] || 'courier';
}

function later(ms, fn) {
  if (!F) return;
  const mySeq = F.mySeq;
  const t = setTimeout(() => { if (F && F.mySeq === mySeq && !F.over) fn(); }, ms);
  F.timeouts.push(t);
}

function refreshPotions() {
  if (!F) return;
  $('potion-count').textContent = 'POT ×' + F.potions + (F.potions ? ' (+30)' : ' (empty)');
}

/* ---------- player actions ---------- */
function tryAttack(special) {
  if (!F || F.over || state !== 'fight') return;
  const now = performance.now() / 1000;
  if (special) {
    if (now - F.specT < PLAYER.specialCd) return;
    F.specT = now;
  } else {
    if (now - F.atkT < PLAYER.atkCd) return;
    F.atkT = now;
  }
  logHist('atk');
  $('hint-bar').classList.remove('show');
  const range = special ? PLAYER.specialRange : PLAYER.atkRange;
  const dmg = special ? PLAYER.specialDmg : PLAYER.atkDmg;
  F.facing = Math.atan2(F.bx - F.px, F.bz - F.pz); // auto-face boss
  if (F.stanceT > 0) { // riposte stance reflects damage (punish mashing)
    hurtPlayer(Math.round(10 * F.dmgMul), 'countered!');
    spawnPop(F.px, 1.8, F.pz, 'OUCH!', 'bad');
    arena.shake(0.45);
    return;
  }
  const reach = range + 1.1;
  if (dist2(F.px, F.pz, F.bx, F.bz) <= reach) {
    F.bhp -= dmg;
    F.events.push(special ? 'boss hit by special' : 'boss hit');
    arena.burst(F.bx, F.bz, special ? 0xffd75e : 0xffffff, special ? 14 : 9, 4.5, 1.0 + F.flyY);
    spawnPop(F.bx, 2.1 + F.flyY, F.bz, (special ? 'BAM! -' : 'POW! -') + dmg, special ? 'special' : 'hit');
    if (!REDUCED) arena.shake(special ? 0.4 : 0.22);
    else domFlash();
  } else {
    spawnPop(F.px, 1.8, F.pz, 'MISS!', 'miss');
  }
}

function tryDash() {
  if (!F || F.over || state !== 'fight') return;
  const now = performance.now() / 1000;
  if (now - F.dashT < PLAYER.dashCd) return;
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
  arena.puffSmoke();
}

function tryPotion() {
  if (!F || F.over || state !== 'fight') return;
  if (F.potions <= 0 || F.php >= PLAYER.hp) return;
  F.potions--;
  F.php = Math.min(PLAYER.hp, F.php + PLAYER.potionHeal);
  refreshPotions();
  F.events.push('player healed');
  arena.burst(F.px, F.pz, 0x7cff6b, 10, 3.5);
  spawnPop(F.px, 1.8, F.pz, '+30!', 'heal');
}

function hurtPlayer(dmg, why) {
  if (!F || F.over) return;
  const now = performance.now() / 1000;
  if (now < F.ifrT) { // i-frames save you
    if (dmg > 0) spawnPop(F.px, 1.8, F.pz, 'DODGED!', 'heal');
    return;
  }
  F.php -= dmg;
  F.events.push('player hit' + (why ? ' (' + why + ')' : ''));
  if (dmg > 0) {
    arena.burst(F.px, F.pz, 0xe8322a, 10, 4);
    spawnPop(F.px, 2.0, F.pz, '-' + dmg, 'bad');
    arena.shake(0.5);
    domFlash();
  }
}

function logHist(kind) {
  if (!F) return;
  F.hist.push({ t: performance.now() / 1000, kind });
}
function playerStyle() {
  if (!F) return 'mobile';
  const now = performance.now() / 1000;
  let atk = 0, dash = 0;
  F.hist = F.hist.filter((h) => now - h.t < 10);
  for (const h of F.hist) { if (h.kind === 'atk') atk++; if (h.kind === 'dash') dash++; }
  if (atk >= 8 || dash >= 4) return 'aggressive';
  if (F.moved10 < 20 && atk < 4) return 'turtly';
  return 'mobile';
}

/* ---------- brain ---------- */
function think(first) {
  if (!F || F.over) return;
  const self = F;
  const bossPct = Math.max(0, (self.bhp / self.cfg.hp) * 100);
  const phase = bossPct < 30 ? 'enrage' : 'normal';
  if (phase === 'enrage' && !self.enraged) enterEnrage();
  const body = {
    boss_id: self.cfg.id, tick: self.tick++,
    boss_hp_pct: Math.round(bossPct), player_hp_pct: Math.round(Math.max(0, self.php)),
    player_style: playerStyle(), current_tactic: self.tactic,
    phase, threats: self.events.slice(-6),
  };
  self.events = [];
  api('/api/brain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((out) => {
      if (!F || F.mySeq !== self.mySeq || F.over) return;
      const now = performance.now() / 1000;
      if (out.tactic_id && out.tactic_id !== F.tactic && (first || now - F.lastSwitch >= 6)) {
        F.tactic = out.tactic_id;
        F.lastSwitch = now;
      }
      if (out.taunt) say(out.taunt);
      if (typeof out.intensity === 'number') F.intensity = out.intensity;
    })
    .catch(() => { /* fight survives a dead model - local AI keeps going */ });
}

function enterEnrage() {
  const e = F.cfg.enrage || {};
  F.enraged = true;
  F.speedMul = e.speed_mult || 1.25;
  F.dmgMul = e.damage_mult || 1.25;
  arena.setEnrage(true);
  arena.shake(0.6);
  setVignette(true);
  domFlash();
  const line = (e.taunts && e.taunts[0]) || 'Enough, hero - my real power!';
  showBanner('!! ' + F.cfg.name.toUpperCase() + ' ENRAGED !!', 'BELOW 30% - NO MERCY', line);
  say(line);
}

/* ---------- boss attacks ---------- */
function bossCooldown(a) {
  const now = performance.now() / 1000;
  const last = F.atkTmap[a.id] || -99;
  const cd = a.cooldown_s / (F.enraged ? 1.2 : 1);
  return now - last >= cd;
}
function tacticPrefs() {
  const t = F.tactic || '';
  if (/pressure|combo|aggressive|relentless/.test(t)) return { want: ['melee', 'lunge'], near: true };
  if (/bomb|barrage|wall|herd|aerial|corner/.test(t)) return { want: ['aoe_circle', 'projectile', 'cone', 'summon'], near: false };
  return { want: ['melee', 'lunge', 'aoe_circle'], near: true };
}
function bossAct() {
  if (!F || F.over) return;
  const prefs = tacticPrefs();
  const d = dist2(F.px, F.pz, F.bx, F.bz);
  const cands = F.cfg.attacks.filter((a) =>
    bossCooldown(a) && (a.pattern === 'projectile' || a.pattern === 'summon' ||
      a.pattern === 'aoe_circle' || a.pattern === 'cone' || d <= a.range_px * PX + 2));
  if (!cands.length) return;
  cands.sort((a, b) => (prefs.want.indexOf(b.pattern) !== -1) - (prefs.want.indexOf(a.pattern) !== -1));
  const a = Math.random() < 0.7 ? cands[0] : cands[Math.floor(Math.random() * cands.length)];
  F.atkTmap[a.id] = performance.now() / 1000;
  if (a.id === 'decoy-feint' && Math.random() < 0.35) { telegraph(a, true); return; } // fake!
  if (a.id === 'riposte-stance') {
    F.stanceT = 1.5;
    arena.setRiposte(true);
    say('Come on, hero. Swing into the thorns.');
    F.events.push('boss countered');
    later(1500, () => { F.stanceT = 0; arena.setRiposte(false); });
    return;
  }
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
  if (fake && a.id === 'decoy-feint') {
    arena.spawnDecoys([[F.bx - 2, F.bz + 1], [F.bx + 2, F.bz + 1]]);
  }
  later(windup * 1000, () => {
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
  } else if (a.pattern === 'lunge') {
    F.bx = clamp(F.bx + (F.px - F.bx) * 0.2, -arena.ARENA_X + 1, arena.ARENA_X - 1);
    F.bz = clamp(F.bz + (F.pz - F.bz) * 0.2, -arena.ARENA_Z + 1, arena.ARENA_Z - 1);
    if (dist2(F.px, F.pz, F.bx, F.bz) < 80 * PX) hurtPlayer(dmg, a.id);
    else { F.events.push('boss missed'); spawnPop(F.px, 1.8, F.pz, 'MISS!', 'miss'); }
  } else if (a.pattern === 'cone') {
    const R = t.r;
    const d = dist2(F.px, F.pz, F.bx, F.bz);
    const angTo = Math.atan2(F.px - F.bx, F.pz - F.bz);
    let diff = Math.abs(angTo - Math.atan2(t.dirX, t.dirZ));
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (d < R + 0.5 && diff < 1.1 / 2 + 0.25) {
      hurtPlayer(dmg, a.id);
      arena.burst(F.px, F.pz, 0xe8322a, 8, 4);
    } else { F.events.push('boss missed'); spawnPop(F.px, 1.8, F.pz, 'MISS!', 'miss'); }
  } else {
    const R = a.pattern === 'melee' ? 70 * PX : a.range_px * PX * 0.55;
    if (a.damage === 0) { // decoy-feint follow-through: scary, harmless
      F.events.push('boss feinted');
      spawnPop(F.px, 1.8, F.pz, 'FEINT!', 'miss');
      return;
    }
    if (dist2(F.px, F.pz, t.x, t.z) < R + 14 * PX) {
      hurtPlayer(dmg, a.id);
      arena.burst(t.x, t.z, 0xe8322a, 8, 4);
    } else { F.events.push('boss missed'); spawnPop(F.px, 1.8, F.pz, 'MISS!', 'miss'); }
  }
}

/* ---------- per-frame ---------- */
function update(dt) {
  const now = performance.now() / 1000;
  const W = arena.ARENA_X, H = arena.ARENA_Z;

  // player movement (dash burst overrides stick/keys)
  const sp = PLAYER.speed;
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

  // flight phase: cinderjaw takes to the sky at 50%
  if (F.cfg.id === 'cinderjaw' && !F.flying && F.bhp < F.cfg.hp * 0.5) {
    F.flying = true;
    arena.setFlight(true);
    showBanner('CINDERJAW TAKES FLIGHT', 'WINGS UP - THE SKY IS HERS', 'she rains skyfire: keep moving, hero');
    setVignette(true);
    say('WINGS UP, hero - the sky is MINE!');
    F.events.push('boss took flight');
    think();
  }
  F.flyY += ((F.flying ? 4 : 0) - F.flyY) * Math.min(1, dt * 1.6);

  // boss movement: approach / strafe by tactic
  const prefs = tacticPrefs();
  const dx = F.px - F.bx, dz = F.pz - F.bz;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d, nz = dz / d;
  const want = (F.flying || !prefs.near) ? 8.5 : 2.3;
  const bs = F.cfg.move_speed * PX * F.speedMul * (F.flying ? 1.15 : 1);
  const dir = d > want + 0.7 ? 1 : (d < want - 0.7 ? -1 : 0);
  const strafe = Math.sin(now * 1.3) * 0.7;
  F.bx = clamp(F.bx + (nx * dir - nz * strafe * 0.5) * bs * dt, -W + 1, W - 1);
  F.bz = clamp(F.bz + (nz * dir + nx * strafe * 0.5) * bs * dt, -H + 1, H - 1);
  arena.bossPos(F.bx, F.bz);
  arena.bossFace(Math.atan2(F.px - F.bx, F.pz - F.bz));

  // boss attacks on cooldowns
  F.actT += dt;
  if (F.actT > 1.2) { F.actT = 0; bossAct(); }

  // projectiles + walls
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

  // brain every ~8s
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

  // endings: opponents FAINT, never die
  if (F.bhp <= 0) finish(true);
  else if (F.php <= 0) finish(false);
}

function updateHUD() {
  setBar('hp-player', F.php, PLAYER.hp);
  setBar('hp-boss', F.bhp, F.cfg.hp);
  $('potion-count').textContent = 'POT ×' + F.potions;
  const s = Math.floor((performance.now() - F.startT) / 1000);
  $('clock').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const now = performance.now() / 1000;
  const cd = (t, c) => Math.max(0, c - (now - t));
  $('cooldowns').textContent =
    'ATK ' + fmtCd(cd(F.atkT, PLAYER.atkCd)) + '  SPEC ' + fmtCd(cd(F.specT, PLAYER.specialCd)) +
    '  DASH ' + fmtCd(cd(F.dashT, PLAYER.dashCd));
  $('btn-attack').classList.toggle('cool', cd(F.atkT, PLAYER.atkCd) > 0);
  $('btn-special').classList.toggle('cool', cd(F.specT, PLAYER.specialCd) > 0);
  $('btn-dash').classList.toggle('cool', cd(F.dashT, PLAYER.dashCd) > 0);
  $('btn-potion').classList.toggle('cool', F.potions <= 0);
}
function fmtCd(v) { return v > 0 ? v.toFixed(1) + 's' : 'READY'; }
function setBar(id, v, max) {
  const f = Math.max(0, v / max);
  $(id + '-fill').style.width = (f * 100).toFixed(1) + '%';
  $(id + '-num').textContent = Math.max(0, Math.round(v)) + ' / ' + max;
}

function finish(won) {
  if (F.over) return;
  F.over = true;
  F.won = won;
  setVignette(false);
  arena.setRiposte(false);
  arena.clearDecoys();
  const secs = (performance.now() - F.startT) / 1000;
  const hpLeft = Math.max(0, Math.round(F.php));
  const score = won ? scoreFor(F.cfg.id, secs, hpLeft) : 0;
  const r = { bossId: F.cfg.id, cfg: F.cfg, won, secs, hpLeft, score };
  if (won) {
    const beaten = loadLadder();
    if (beaten.indexOf(F.cfg.id) === -1) { beaten.push(F.cfg.id); saveLadder(beaten); }
    say('*faints dramatically* ...well fought, hero!');
    showBanner('★ ' + F.cfg.name.toUpperCase() + ' FAINTED ★', 'WELL FOUGHT, HERO!', 'worth sending to your brother');
    arena.burst(F.bx, F.bz, 0xffd75e, 16, 5, 1.0 + F.flyY);
  } else {
    showBanner('SO CLOSE, HERO', 'THAT BOSS GOT LUCKY', 'shake it off - you were learning its moves');
  }
  const mySeq = F.mySeq;
  setTimeout(() => { if (F && F.mySeq === mySeq) showEnd(r); }, won ? 1200 : 600);
}

/* ---------- input: joystick + buttons + keyboard ---------- */
const keys = new Set();

function bindInput() {
  window.addEventListener('keydown', (e) => {
    if (state === 'fight' && GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (state !== 'fight' || !F || F.over) return;
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
    const dt = Math.min((t - last) / 1000, 0.05);
    last = t;
    if (state === 'fight' && F && !F.over) {
      try { update(dt); } catch (err) { console.error(err); }
    }
    try { arena.frame(dt, t / 1000); } catch (err) { console.error(err); }
    requestAnimationFrame(loop);
  };

  api('/api/bosses').then((data) => {
    BOSSES = data.bosses;
    buildMenu();
    buildSelect();
    // idle diorama behind the menu
    const first = bossById('smoke-courier') || BOSSES[0];
    if (first) {
      arena.setBoss((first.visual && first.visual.recipe) || bossIdToRecipe(first.id), first.visual || {});
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
