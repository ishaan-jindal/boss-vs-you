/* Boss vs You — Phaser 3 client. Plain JS, no bundler.
 *
 * DESIGNER HOOKS (stable names for a later visual pass):
 * DOM: #game-root (.bv-root), #taunt-region (.bv-taunt, role=status), #rotate-hint
 *   + #bv-vignette, #bv-flash, #bv-banner (+ #bv-banner-kicker/title/sub)
 * Scene keys: 'menu' | 'select' | 'fight' | 'end'
 * Fight object names: 'player', 'boss', 'boss-shadow', 'joystick-base',
 *   'joystick-knob', 'btn-attack', 'btn-special', 'btn-dash', 'btn-potion',
 *   'player-hpbar', 'boss-hpbar', 'taunt-bubble', 'telegraph', 'boss-taunt-text'
 * localStorage: 'bvy-ladder' (array of beaten boss ids, in ladder order)
 * Ladder order: ['smoke-courier', 'cinderjaw', 'briar-knight']
 *
 * Visual layer: bold arcade storybook. Logic contract (API shapes, scene flow,
 * cooldowns, scoring, ladder) is untouched — only presentation changed.
 * (Hook list extended with DOM juice layers; nothing renamed or removed.)
 */
(function () {
'use strict';

var LADDER = ['smoke-courier', 'cinderjaw', 'briar-knight'];
var ARENA = { x: 40, y: 90, w: 720, h: 460 };
var PLAYER = { hp: 100, speed: 220, atkDmg: 8, atkCd: 0.6, atkRange: 100,
  dashCd: 4, specialDmg: 25, specialCd: 12, specialRange: 150,
  potionHeal: 30, potions: 2 };
var SCORE_BASE = { 'smoke-courier': 1000, 'cinderjaw': 1500, 'briar-knight': 2000 };

/* Per-boss visual identity. Colours mirror bosses.py `colour` values. */
var THEMES = {
  'smoke-courier': { accent: 0x8A6BC9, css: '#8A6BC9', dark: 0x241d38,
    hp: 0x9a7bff, stars: 1, pace: 'FAST · slippery lunges + fake-outs',
    bannerSub: 'express shipping — she is faster now' },
  'cinderjaw': { accent: 0xE0572B, css: '#E0572B', dark: 0x3a1a0e,
    hp: 0xff6a3c, stars: 2, pace: 'HEAVY · fire cones + skyfire rain',
    bannerSub: 'the sky is hers now — watch the floor' },
  'briar-knight': { accent: 0x3FA34D, css: '#3FA34D', dark: 0x0f2a16,
    hp: 0x59d668, stars: 3, pace: 'CRUEL · counters your mashing',
    bannerSub: 'the garden closes in — swing wisely' }
};
function themeFor(id) {
  return THEMES[id] || { accent: 0xffd75e, css: '#ffd75e', dark: 0x2b2116,
    hp: 0xff5544, stars: 1, pace: 'UNKNOWN', bannerSub: 'it is angry now' };
}

var SERIF = 'Georgia, "Iowan Old Style", "Palatino Linotype", serif';
var SANS = '"Avenir Next", "Segoe UI", system-ui, -apple-system, sans-serif';

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
function scoreFor(bossId, secs, hpLeft) {
  var base = SCORE_BASE[bossId] || 1000;
  return Math.round(base + Math.max(0, 240 - secs) * 5 + clamp(hpLeft, 0, 100) * 10);
}
function loadLadder() {
  try { return JSON.parse(localStorage.getItem('bvy-ladder') || '[]'); } catch (e) { return []; }
}
function saveLadder(arr) { try { localStorage.setItem('bvy-ladder', JSON.stringify(arr)); } catch (e) {} }
function unlocked(bossId, beaten) {
  if (bossId === LADDER[0]) return true;
  return beaten.indexOf(LADDER[LADDER.indexOf(bossId) - 1]) !== -1;
}
var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var BOSSES = null;
function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    if (!r.ok) throw new Error('api ' + r.status);
    return r.json();
  });
}

/* ---------- DOM juice (all guarded; game survives without the divs) ---------- */
function el(id) { return document.getElementById(id); }
function showBanner(kicker, title, sub) {
  var b = el('bv-banner'); if (!b) return;
  el('bv-banner-kicker').textContent = kicker;
  el('bv-banner-title').textContent = title;
  el('bv-banner-sub').textContent = sub || '';
  b.setAttribute('aria-hidden', 'false');
  b.classList.remove('show');
  void b.offsetWidth; /* restart the animation */
  b.classList.add('show');
  setTimeout(function () { b.setAttribute('aria-hidden', 'true'); }, 2300);
}
function setVignette(on) { var v = el('bv-vignette'); if (v) v.classList.toggle('on', !!on); }
function pulseVignette() {
  var v = el('bv-vignette'); if (!v || REDUCED) return;
  v.classList.remove('brief'); void v.offsetWidth; v.classList.add('brief');
}
function domFlash() {
  var f = el('bv-flash'); if (!f || REDUCED) return;
  f.classList.remove('hit'); void f.offsetWidth; f.classList.add('hit');
}

/* ---------- shared Phaser dressing ---------- */
function backdrop(scene, accentDark) {
  var W = scene.scale.width, H = scene.scale.height;
  scene.cameras.main.setBackgroundColor('#14100c');
  /* lantern glow top-centre */
  var glow = scene.add.graphics().setDepth(-10);
  glow.fillGradientStyle(0x6b4d22, 0x6b4d22, 0x14100c, 0x14100c, 0.55, 0.55, 0, 0);
  glow.fillRect(0, 0, W, H * 0.55);
  /* drifting paper motes — static dots in reduced-motion, twinkling otherwise */
  for (var i = 0; i < 42; i++) {
    var x = Math.random() * W, y = Math.random() * H, r = 1 + Math.random() * 2;
    var m = scene.add.circle(x, y, r, 0xf5e6c8, 0.05 + Math.random() * 0.10).setDepth(-9);
    if (!REDUCED && Math.random() < 0.3) {
      scene.tweens.add({ targets: m, alpha: 0.02, duration: 1200 + Math.random() * 1800,
        yoyo: true, repeat: -1, delay: Math.random() * 1500 });
    }
  }
  /* corner storybook rule */
  var rule = scene.add.graphics().setDepth(-8);
  rule.lineStyle(2, 0x4a3a28, 1);
  rule.strokeRect(10, 10, W - 20, H - 20);
  rule.lineStyle(1, accentDark || 0x4a3a28, 0.8);
  rule.strokeRect(16, 16, W - 32, H - 32);
}

/* Arena floor with hazard-striped inner border. Returns nothing; pure decor. */
function arenaFloor(scene, accent) {
  var g = scene.add.graphics().setDepth(-5);
  g.fillStyle(0x1a1410, 1);
  g.fillRoundedRect(ARENA.x, ARENA.y, ARENA.w, ARENA.h, 14);
  g.fillStyle(0x241b12, 1);
  g.fillRoundedRect(ARENA.x + 8, ARENA.y + 8, ARENA.w - 16, ARENA.h - 16, 10);
  /* faint floorboards */
  g.lineStyle(1, 0x3a2d1e, 0.5);
  for (var y = ARENA.y + 40; y < ARENA.y + ARENA.h; y += 40) {
    g.lineBetween(ARENA.x + 12, y, ARENA.x + ARENA.w - 12, y);
  }
  /* hazard ticks along the inside edge: alternating ember/paper dashes */
  var x, y2;
  g.lineStyle(5, 0xe8322a, 0.85);
  for (x = ARENA.x + 16; x < ARENA.x + ARENA.w - 16; x += 28) {
    g.lineBetween(x, ARENA.y + 5, x + 14, ARENA.y + 5);
    g.lineBetween(x, ARENA.y + ARENA.h - 5, x + 14, ARENA.y + ARENA.h - 5);
  }
  for (y2 = ARENA.y + 16; y2 < ARENA.y + ARENA.h - 16; y2 += 28) {
    g.lineBetween(ARENA.x + 5, y2, ARENA.x + 5, y2 + 14);
    g.lineBetween(ARENA.x + ARENA.w - 5, y2, ARENA.x + ARENA.w - 5, y2 + 14);
  }
  scene.add.rectangle(ARENA.x + ARENA.w / 2, ARENA.y + ARENA.h / 2, ARENA.w, ARENA.h)
    .setStrokeStyle(2, accent, 0.9).setDepth(-4);
}

/* Framed HP bar: track + fill (named hook) + numeric readout.
 * Returns { fill, num } — caller keeps `fill` for displayWidth scaling. */
function hpBar(scene, x, y, w, labelText, labelColor, fillColor, name, alignRight) {
  var g = scene.add.graphics().setDepth(20);
  g.fillStyle(0x000000, 0.72); g.fillRect(x - 3, y - 13, w + 6, 30);
  g.lineStyle(2, 0xf5e6c8, 0.9); g.strokeRect(x - 3, y - 13, w + 6, 30);
  scene.add.text(alignRight ? x + w : x, y - 30, labelText,
    { fontFamily: SANS, fontSize: '15px', color: labelColor, fontStyle: 'bold' })
    .setOrigin(alignRight ? 1 : 0, 0).setDepth(21);
  scene.add.rectangle(x, y + 2, w, 14, 0x3a2d1e, 1).setOrigin(0, 0.5).setDepth(20);
  var fill = scene.add.rectangle(x, y + 2, w, 14, fillColor, 1)
    .setOrigin(0, 0.5).setDepth(21).setName(name);
  /* glossy tick marks every 25% — shape + number, never colour alone */
  var ticks = scene.add.graphics().setDepth(22);
  ticks.lineStyle(1, 0x000000, 0.55);
  [0.25, 0.5, 0.75].forEach(function (f) { ticks.lineBetween(x + w * f, y - 5, x + w * f, y + 9); });
  var num = scene.add.text(x + w / 2, y + 2, '',
    { fontFamily: SANS, fontSize: '13px', color: '#ffffff', fontStyle: 'bold' })
    .setOrigin(0.5).setDepth(23);
  num.setStroke('#000000', 3);
  return { fill: fill, num: num };
}

/* Thumbable fight button: coloured puck + bold label + sub-glyph.
 * Size/positions/names unchanged (76px, POT 64px) for the 64px+ touch rule. */
var BTN_SKINS = {
  ATK:  { bg: 0xc9962e, ring: 0xffd75e, sub: 'slash' },
  SPEC: { bg: 0x6a4fb3, ring: 0xcbb7ff, sub: 'burst' },
  DASH: { bg: 0x2e6fc9, ring: 0x9cc8ff, sub: 'dash' },
  POT:  { bg: 0x2e8b3d, ring: 0x9decab, sub: 'heal' }
};
function touchButton(scene, x, y, label, size, cb) {
  var skin = BTN_SKINS[label] || { bg: 0x222a33, ring: 0xffffff, sub: '' };
  var c = scene.add.container(x, y).setDepth(30);
  var halo = scene.add.circle(0, 0, size / 2 + 5, skin.ring, 0.22);
  var bg = scene.add.circle(0, 0, size / 2, skin.bg, 0.95).setStrokeStyle(3, skin.ring, 1);
  var t = scene.add.text(0, -7, label,
    { fontFamily: SANS, fontSize: label.length > 3 ? '15px' : '17px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5);
  var s = scene.add.text(0, 13, skin.sub,
    { fontFamily: SANS, fontSize: '11px', color: '#ffffff' }).setOrigin(0.5).setAlpha(0.85);
  c.add([halo, bg, t, s]);
  c.setSize(size, size).setInteractive({ useHandCursor: false });
  c.on('pointerdown', function () {
    bg.setFillStyle(0xffffff, 1); t.setColor('#17110b'); s.setColor('#17110b');
    if (!REDUCED) scene.tweens.add({ targets: c, scale: 0.9, duration: 60, yoyo: true });
    cb();
  });
  var reset = function () { bg.setFillStyle(skin.bg, 0.95); t.setColor('#fff'); s.setColor('#fff'); };
  c.on('pointerup', reset);
  c.on('pointerout', reset);
  return c;
}

// ================= MENU =================
var MenuScene = new Phaser.Class({
  Extends: Phaser.Scene,
  initialize: function () { Phaser.Scene.call(this, { key: 'menu' }); },
  create: function () {
    setVignette(false);
    var W = this.scale.width, H = this.scale.height;
    backdrop(this, 0xc9962e);
    var cx = W / 2, cy = H / 2;

    /* boss glyph parade above the title: three looming sigils */
    var parade = [
      { g: '☁', c: '#8A6BC9', x: -150 }, { g: '▲', c: '#E0572B', x: 0 }, { g: '✦', c: '#3FA34D', x: 150 }
    ];
    parade.forEach(function (p, i) {
      var ring = this.add.circle(cx + p.x, cy - 178, 44, 0x000000, 0.5)
        .setStrokeStyle(3, Phaser.Display.Color.HexStringToColor(p.c).color, 1);
      var t = this.add.text(cx + p.x, cy - 178, p.g,
        { fontSize: '40px', color: p.c }).setOrigin(0.5);
      if (!REDUCED) {
        this.tweens.add({ targets: [ring, t], y: '-=10', duration: 1100 + i * 250,
          yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: i * 200 });
      }
    }, this);

    this.add.text(cx, cy - 78, 'BOSS vs YOU',
      { fontFamily: SERIF, fontSize: Math.min(64, W / 8) + 'px', color: '#ffd75e', fontStyle: 'bold' })
      .setOrigin(0.5).setStroke('#5c1a08', 6).setShadow(0, 4, 'rgba(0,0,0,.7)', 0);
    this.add.text(cx, cy - 30, '— a tiny boss-battler in three rounds —',
      { fontFamily: SERIF, fontSize: '17px', color: '#d9c49a', fontStyle: 'italic' }).setOrigin(0.5);
    this.add.text(cx, cy + 8, 'Dodge the red. Bonk the boss.',
      { fontFamily: SANS, fontSize: '19px', color: '#f5e6c8' }).setOrigin(0.5);

    var bw = Math.min(420, W - 80);
    var frame = this.add.graphics();
    frame.fillStyle(0xc9962e, 1); frame.fillRoundedRect(cx - bw / 2, cy + 44, bw, 72, 12);
    frame.lineStyle(3, 0xffd75e, 1); frame.strokeRoundedRect(cx - bw / 2, cy + 44, bw, 72, 12);
    var b = this.add.text(cx, cy + 80, '▶  FIGHT THE FIRST BOSS',
      { fontFamily: SANS, fontSize: '24px', color: '#17110b', fontStyle: 'bold' }).setOrigin(0.5);
    b.setInteractive({ useHandCursor: false });
    if (!REDUCED) {
      this.tweens.add({ targets: b, scale: 1.05, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
    b.on('pointerdown', function () { this.scene.start('select'); }.bind(this));
    frame.setInteractive(new Phaser.Geom.Rectangle(cx - bw / 2, cy + 44, bw, 72), Phaser.Geom.Rectangle.Contains);
    frame.on('pointerdown', function () { this.scene.start('select'); }.bind(this));

    var beaten = loadLadder();
    var status = beaten.length
      ? ('Ladder: ' + beaten.length + ' / ' + LADDER.length + ' bosses fainted — keep going, hero.')
      : 'Three bosses are waiting. The first one is already talking trash.';
    this.add.text(cx, cy + 148, status,
      { fontFamily: SANS, fontSize: '15px', color: '#d9c49a', align: 'center' }).setOrigin(0.5);
    this.add.text(cx, H - 44, 'Best on iPad landscape · sound off, drama on',
      { fontFamily: SANS, fontSize: '13px', color: '#8a7757' }).setOrigin(0.5);
  }
});

// ================= SELECT =================
var SelectScene = new Phaser.Class({
  Extends: Phaser.Scene,
  initialize: function () { Phaser.Scene.call(this, { key: 'select' }); },
  create: function () {
    setVignette(false);
    var W = this.scale.width;
    backdrop(this, 0xc9962e);
    var cx = W / 2;
    this.add.text(cx, 52, 'PICK YOUR FIGHT',
      { fontFamily: SERIF, fontSize: '36px', color: '#ffd75e', fontStyle: 'bold' })
      .setOrigin(0.5).setStroke('#000', 4);
    this.add.text(cx, 84, 'Beat one to unlock the next. Losing teaches you the moves.',
      { fontFamily: SANS, fontSize: '15px', color: '#d9c49a' }).setOrigin(0.5);

    var beaten = loadLadder();
    var cardW = Math.min(600, W - 40), cardH = 128, y = 176;
    BOSSES.forEach(function (b, i) {
      var th = themeFor(b.id);
      var ok = unlocked(b.id, beaten);
      var done = beaten.indexOf(b.id) !== -1;
      var row = this.add.container(cx, y).setDepth(2);
      var g = this.add.graphics();
      var base = ok ? 0x211812 : 0x151110;
      g.fillStyle(0x000000, 0.55); g.fillRoundedRect(-cardW / 2 + 4, -cardH / 2 + 6, cardW, cardH, 14);
      g.fillStyle(base, 1); g.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 14);
      /* danger-spine: boss colour bar down the left edge */
      g.fillStyle(ok ? th.accent : 0x4a3a28, 1);
      g.fillRoundedRect(-cardW / 2, -cardH / 2, 14, cardH, { tl: 14, bl: 14, tr: 0, br: 0 });
      g.lineStyle(2, done ? 0xffd75e : (ok ? 0xf5e6c8 : 0x4a3a28), done ? 1 : 0.7);
      g.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 14);
      row.add(g);

      var med = this.add.circle(-cardW / 2 + 58, 0, 34, th.dark, 1)
        .setStrokeStyle(3, ok ? th.accent : 0x555555, 1);
      med.setAlpha(ok ? 1 : 0.45);
      var glyph = this.add.text(-cardW / 2 + 58, -1, ok ? b.glyph : '×',
        { fontSize: '36px', color: ok ? th.css : '#555' }).setOrigin(0.5);
      row.add([med, glyph]);

      var stars = '';
      for (var s = 0; s < 3; s++) stars += s < th.stars ? '★' : '☆';
      var left = -cardW / 2 + 106;
      var diffCol = th.stars === 1 ? '#9decab' : th.stars === 2 ? '#ffd75e' : '#ff8a7a';
      var name = this.add.text(left, -46, (i + 1) + '. ' + b.name.toUpperCase(),
        { fontFamily: SERIF, fontSize: '22px', color: ok ? '#f5e6c8' : '#777', fontStyle: 'bold' });
      var pace = this.add.text(left, -20, stars + '  ' + th.pace,
        { fontFamily: SANS, fontSize: '13px', color: ok ? diffCol : '#555', fontStyle: 'bold' });
      var sub = this.add.text(left, 0, ok ? b.title : 'LOCKED — beat the previous boss to face this one.',
        { fontFamily: SERIF, fontSize: '15px', color: ok ? '#d9c49a' : '#666', fontStyle: 'italic',
          wordWrap: { width: cardW - 150 } });
      /* taunt teaser sells the fantasy; locked cards hide it */
      var teaser = this.add.text(left, 44,
        ok ? '“' + (b.taunt_voice[0] || '') + '”' : '“…”',
        { fontFamily: SANS, fontSize: '13px', color: ok ? th.css : '#444',
          wordWrap: { width: cardW - 150 } });
      row.add([name, pace, sub, teaser]);

      var ribbon;
      if (done) {
        ribbon = this.add.text(cardW / 2 - 14, -cardH / 2 + 16, '★ BEATEN',
          { fontFamily: SANS, fontSize: '14px', color: '#17110b', fontStyle: 'bold',
            backgroundColor: '#ffd75e', padding: { x: 10, y: 5 } }).setOrigin(1, 0);
      } else if (!ok) {
        ribbon = this.add.text(cardW / 2 - 14, -cardH / 2 + 16, '◆ LOCKED',
          { fontFamily: SANS, fontSize: '14px', color: '#aaa', fontStyle: 'bold',
            backgroundColor: '#00000088', padding: { x: 10, y: 5 } }).setOrigin(1, 0);
      } else if (i === 0 && !beaten.length) {
        ribbon = this.add.text(cardW / 2 - 14, -cardH / 2 + 16, '▶ START HERE',
          { fontFamily: SANS, fontSize: '14px', color: '#17110b', fontStyle: 'bold',
            backgroundColor: '#7cff6b', padding: { x: 10, y: 5 } }).setOrigin(1, 0);
        if (!REDUCED) this.tweens.add({ targets: row, x: '+=5', duration: 900, yoyo: true, repeat: -1 });
      } else {
        ribbon = this.add.text(cardW / 2 - 14, -cardH / 2 + 16, '▶ FIGHT',
          { fontFamily: SANS, fontSize: '14px', color: '#ffd75e', fontStyle: 'bold',
            backgroundColor: '#00000088', padding: { x: 10, y: 5 } }).setOrigin(1, 0);
      }
      row.add(ribbon);

      if (ok) {
        var hit = this.add.zone(0, 0, cardW, cardH).setInteractive({ useHandCursor: false });
        row.add(hit);
        hit.on('pointerdown', function () { this.scene.start('fight', { bossId: b.id }); }.bind(this));
      } else {
        row.setAlpha(0.85);
      }
      y += cardH + 22;
    }, this);
    var back = this.add.text(cx, y + 12, '← menu',
      { fontFamily: SANS, fontSize: '22px', color: '#9cc8ff',
        backgroundColor: '#00000066', padding: { x: 22, y: 12 } }).setOrigin(0.5);
    back.setInteractive();
    back.on('pointerdown', function () { this.scene.start('menu'); }.bind(this));
  }
});

// ================= FIGHT =================
var FightScene = new Phaser.Class({
  Extends: Phaser.Scene,
  initialize: function () { Phaser.Scene.call(this, { key: 'fight' }); },
  init: function (data) { this.bossId = data.bossId; },
  create: function () {
    var self = this;
    this.cfg = null;
    BOSSES.forEach(function (b) { if (b.id === self.bossId) self.cfg = b; });
    if (!this.cfg) { this.scene.start('select'); return; }
    var th = themeFor(this.bossId);
    var W = this.scale.width, H = this.scale.height;
    ARENA = { x: 20, y: 118, w: W - 40, h: H - 276 };
    setVignette(false);

    // state
    this.p = { x: W / 2, y: ARENA.y + ARENA.h - 80, hp: PLAYER.hp, potions: PLAYER.potions,
      atkT: 0, specT: 0, dashT: 0, ifrT: 0, dashDx: 0, dashDy: 0, dashing: 0 };
    this.b = { x: W / 2, y: ARENA.y + 90, hp: this.cfg.hp, enraged: false, flying: false,
      stanceT: 0, atkT: {}, tactic: this.cfg.tactics[0].id, speedMul: 1, dmgMul: 1 };
    this.over = false; this.startT = this.time.now; this.tick = 0;
    this.lastSwitch = -9999; this.events = []; this.hist = []; // hist: {t, moved, atk, dash}
    this.brainTimer = 0; this.pendingTelegraphs = []; this.projectiles = []; this.walls = [];
    this.phase = 'normal';

    // backdrop + arena + actors
    backdrop(this, th.accent);
    arenaFloor(this, th.accent);
    this.shadow = this.add.ellipse(this.b.x, this.b.y + 26, 60, 17, 0x000000, 0.4).setName('boss-shadow');
    /* boss aura ring (presence) + body + hot core + glyph sigil */
    this.bossAura = this.add.circle(this.b.x, this.b.y, 38, th.accent, 0.22).setDepth(-1);
    this.bossRing = this.add.circle(this.b.x, this.b.y, 31, 0x000000, 0).setStrokeStyle(3, th.accent, 1);
    this.bossG = this.add.circle(this.b.x, this.b.y, 26, this.cfg.colour).setName('boss');
    this.bossCore = this.add.circle(this.b.x, this.b.y, 11, 0xffffff, 0.85);
    this.bossGlyph = this.add.text(this.b.x, this.b.y, this.cfg.glyph,
      { fontSize: '30px', color: '#fff', fontStyle: 'bold' }).setOrigin(0.5).setStroke('#000', 4);
    /* hero: halo + body + facing tick */
    this.meHalo = this.add.circle(this.p.x, this.p.y, 24, 0x4da3ff, 0.25);
    this.me = this.add.circle(this.p.x, this.p.y, 16, 0x4da3ff).setName('player')
      .setStrokeStyle(3, 0xffffff, 1);
    this.meTick = this.add.triangle(this.p.x, this.p.y - 22, 0, 10, 10, 0, 5, 12, 0xffffff, 1);
    this.gfx = this.add.graphics();

    // HP bars — big, framed, numbers attached (never colour alone)
    this.add.text(24, 18, 'YOU  ♥ hero',
      { fontFamily: SANS, fontSize: '16px', color: '#fff', fontStyle: 'bold' });
    var pb = hpBar(this, 24, 52, Math.min(220, W * 0.32), '', '#fff', 0x4da3ff, 'player-hpbar', false);
    this.phpBar = pb.fill; this.phpNum = pb.num;
    this.potText = this.add.text(24, 68, '',
      { fontFamily: SANS, fontSize: '15px', color: '#9decab', fontStyle: 'bold' }).setName('potion-count');
    this.refreshPotions();
    var bbw = Math.min(270, W * 0.38);
    var bx = W - 24 - bbw;
    this.add.text(W - 24, 18, '◆ ' + this.cfg.name.toUpperCase(),
      { fontFamily: SANS, fontSize: '16px', color: th.css, fontStyle: 'bold' }).setOrigin(1, 0);
    var bb = hpBar(this, bx, 52, bbw, '', '#fff', th.hp, 'boss-hpbar', false);
    this.bhpBar = bb.fill; this.bhpNum = bb.num;
    /* enrage tripwire: striped marker at 30% of the boss bar + "ENRAGE <30%" tag */
    var ticks = this.add.graphics().setDepth(23);
    ticks.fillStyle(0xe8322a, 1);
    var exx = bx + bbw * 0.3;
    for (var ei = 0; ei < 5; ei++) ticks.fillTriangle(exx, 40, exx, 64, exx + 5, 52);
    this.add.text(exx + 8, 40, 'ENRAGE <30%',
      { fontFamily: SANS, fontSize: '11px', color: '#ff8a7a', fontStyle: 'bold' }).setDepth(23);

    /* taunt bubble: dark plaque w/ gold border (frame) + text (hook) */
    this.tauntFrame = this.add.graphics().setDepth(4).setName('boss-taunt-text').setVisible(false);
    this.tauntText = this.add.text(this.b.x, this.b.y - 62, '',
      { fontFamily: SERIF, fontSize: '17px', color: '#ffe9a8', fontStyle: 'italic',
        align: 'center', wordWrap: { width: Math.min(360, W - 80) } })
      .setOrigin(0.5).setDepth(5).setVisible(false).setName('taunt-bubble');
    this.clockText = this.add.text(W / 2, 24, '0:00',
      { fontFamily: SANS, fontSize: '20px', color: '#ffd75e', fontStyle: 'bold' }).setOrigin(0.5).setDepth(21);
    this.add.text(W / 2, 44, 'dodge the red — it always means DANGER',
      { fontFamily: SANS, fontSize: '12px', color: '#d9c49a' }).setOrigin(0.5).setDepth(21);

    // ---- joystick (left thumb, base ≥60px: 120px diameter) ----
    this.joy = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
    this.joyBase = this.add.circle(0, 0, 60, 0xffffff, 0.10).setVisible(false)
      .setStrokeStyle(2, 0xf5e6c8, 0.5).setName('joystick-base').setDepth(29);
    this.joyKnob = this.add.circle(0, 0, 26, 0xf5e6c8, 0.4).setVisible(false)
      .setName('joystick-knob').setDepth(29);
    this.input.on('pointerdown', function (pt) {
      if (pt.x < W * 0.5 && !self.joy.active && !self.over) {
        self.joy.active = true; self.joy.id = pt.id; self.joy.cx = pt.x; self.joy.cy = pt.y;
        self.joyBase.setPosition(pt.x, pt.y).setVisible(true);
        self.joyKnob.setPosition(pt.x, pt.y).setVisible(true);
      }
    });
    this.input.on('pointermove', function (pt) {
      if (self.joy.active && pt.id === self.joy.id) {
        var dx = pt.x - self.joy.cx, dy = pt.y - self.joy.cy;
        var m = Math.hypot(dx, dy), max = 48;
        if (m > max) { dx *= max / m; dy *= max / m; }
        self.joy.dx = dx / max; self.joy.dy = dy / max;
        self.joyKnob.setPosition(self.joy.cx + dx, self.joy.cy + dy);
      }
    });
    var joyEnd = function (pt) {
      if (self.joy.active && pt.id === self.joy.id) {
        self.joy.active = false; self.joy.dx = 0; self.joy.dy = 0;
        self.joyBase.setVisible(false); self.joyKnob.setVisible(false);
      }
    };
    this.input.on('pointerup', joyEnd); this.input.on('pointerupoutside', joyEnd);

    // ---- buttons (right thumb, ≥64px: 76px) ----
    var by = H - 96, bx2 = W - 74;
    touchButton(this, bx2 - 172, by, 'ATK', 76, function () { self.tryAttack(false); }).setName('btn-attack');
    touchButton(this, bx2 - 86, by - 70, 'SPEC', 76, function () { self.tryAttack(true); }).setName('btn-special');
    touchButton(this, bx2, by, 'DASH', 76, function () { self.tryDash(); }).setName('btn-dash');
    touchButton(this, bx2 - 86, by + 12, 'POT', 64, function () { self.tryPotion(); }).setName('btn-potion');
    this.cdText = this.add.text(bx2 - 210, by + 56, '',
      { fontFamily: SANS, fontSize: '13px', color: '#d9c49a' });

    /* boss intro card: fantasy + threat, then the fight starts talking */
    showBanner(this.cfg.name.toUpperCase(), 'ROUND ' + (LADDER.indexOf(this.bossId) + 1) + ' — FIGHT!',
      this.cfg.title);
    this.say(this.cfg.taunt_voice[0] || ('I am ' + this.cfg.name + '!'));
    this.think(true); // opening brain call; silent tactic set
  },

  refreshPotions: function () {
    var s = 'POT ×' + this.p.potions + (this.p.potions ? ' (heal +30)' : ' (empty)');
    this.potText.setText(s);
  },

  // ---------- player actions ----------
  tryAttack: function (special) {
    if (this.over) return;
    var now = this.time.now / 1000;
    if (special) {
      if (now - this.p.specT < PLAYER.specialCd) return;
      this.p.specT = now;
    } else {
      if (now - this.p.atkT < PLAYER.atkCd) return;
      this.p.atkT = now;
    }
    this.logHist('atk');
    var range = special ? PLAYER.specialRange : PLAYER.atkRange;
    var dmg = special ? PLAYER.specialDmg : PLAYER.atkDmg;
    // riposte stance: attacking into it reflects damage (punish mashing)
    if (this.b.stanceT > 0) {
      this.hurtPlayer(Math.round(10 * this.b.dmgMul), 'countered!');
      this.flash(this.me, 0xff0000);
      return;
    }
    if (dist(this.p.x, this.p.y, this.b.x, this.b.y) <= range + 26) {
      this.b.hp -= dmg;
      this.events.push(special ? 'boss hit by special' : 'boss hit');
      this.flash(this.bossG, 0xffffff);
      domFlash();
      if (!REDUCED) {
        this.cameras.main.shake(60, 0.003);
        /* hit spark: gold starburst on the boss */
        var th = themeFor(this.bossId);
        var spark = this.add.graphics().setDepth(6);
        spark.lineStyle(special ? 5 : 3, special ? 0xffd75e : 0xffffff, 1);
        for (var k = 0; k < 8; k++) {
          var a2 = k / 8 * Math.PI * 2 + Math.random() * 0.4;
          var r0 = 30, r1 = r0 + (special ? 30 : 16) + Math.random() * 8;
          spark.lineBetween(this.b.x + Math.cos(a2) * r0, this.b.y + Math.sin(a2) * r0,
            this.b.x + Math.cos(a2) * r1, this.b.y + Math.sin(a2) * r1);
        }
        var dmgT = this.add.text(this.b.x, this.b.y - 44, '-' + dmg,
          { fontFamily: SANS, fontSize: special ? '26px' : '19px', color: special ? '#ffd75e' : '#fff',
            fontStyle: 'bold' }).setOrigin(0.5).setDepth(6).setStroke('#000', 4);
        this.tweens.add({ targets: dmgT, y: '-=26', alpha: 0, duration: 550,
          onComplete: function () { dmgT.destroy(); } });
        this.time.delayedCall(140, function () { spark.destroy(); });
        /* boss flinch toward the hit */
        this.bossG.x += (this.b.x < this.p.x ? 3 : -3);
      }
      // melee arc swipe
      var a = this.add.circle(this.b.x, this.b.y, range, special ? 0xffd75e : 0xffffff, 0.20).setDepth(3);
      this.time.delayedCall(120, function () { a.destroy(); });
    }
  },
  tryDash: function () {
    if (this.over) return;
    var now = this.time.now / 1000;
    if (now - this.p.dashT < PLAYER.dashCd) return;
    this.p.dashT = now; this.p.ifrT = now + 0.25; this.p.dashing = 0.18;
    var dx = this.joy.dx, dy = this.joy.dy;
    if (Math.hypot(dx, dy) < 0.2) { // dash away from boss by default
      dx = this.p.x - this.b.x; dy = this.p.y - this.b.y;
      var m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
    } else { var m2 = Math.hypot(dx, dy); dx /= m2; dy /= m2; }
    this.p.dashDx = dx; this.p.dashDy = dy;
    this.logHist('dash');
    this.events.push('player dashed');
    if (!REDUCED) {
      var ghost = this.add.circle(this.p.x, this.p.y, 16, 0x9cc8ff, 0.4).setDepth(1);
      this.tweens.add({ targets: ghost, alpha: 0, scale: 1.6, duration: 280,
        onComplete: function () { ghost.destroy(); } });
    }
  },
  tryPotion: function () {
    if (this.over || this.p.potions <= 0 || this.p.hp >= PLAYER.hp) return;
    this.p.potions--; this.p.hp = Math.min(PLAYER.hp, this.p.hp + PLAYER.potionHeal);
    this.refreshPotions();
    this.events.push('player healed');
    if (!REDUCED) {
      var ring = this.add.circle(this.p.x, this.p.y, 18, 0x7cff6b, 0.8).setDepth(6)
        .setStrokeStyle(3, 0x7cff6b, 1);
      this.tweens.add({ targets: ring, scale: 2.2, alpha: 0, duration: 500,
        onComplete: function () { ring.destroy(); } });
      this.say('Down the hatch. Back in the fight!');
    }
  },
  hurtPlayer: function (dmg, why) {
    var now = this.time.now / 1000;
    if (now < this.p.ifrT || this.over) return; // i-frames save you
    this.p.hp -= dmg;
    this.events.push('player hit' + (why ? ' (' + why + ')' : ''));
    this.flash(this.me, 0xff0000);
    domFlash();
    if (!REDUCED) this.cameras.main.shake(90, 0.006);
    else pulseVignette();
  },
  flash: function (obj, color) {
    if (REDUCED) return; /* reduced motion: numbers + vignette carry the feedback */
    var orig = obj.fillColor;
    obj.setFillStyle(color, 1);
    this.time.delayedCall(90, function () { obj.setFillStyle(orig, 1); });
  },
  say: function (line) {
    this.tauntText.setText(line).setVisible(true);
    /* size the plaque behind the text */
    var b = this.tauntText.getBounds();
    this.tauntFrame.clear();
    this.tauntFrame.fillStyle(0x000000, 0.82);
    this.tauntFrame.fillRoundedRect(b.centerX - b.width / 2 - 12, b.centerY - b.height / 2 - 8,
      b.width + 24, b.height + 16, 8);
    this.tauntFrame.lineStyle(2, 0xffd75e, 1);
    this.tauntFrame.strokeRoundedRect(b.centerX - b.width / 2 - 12, b.centerY - b.height / 2 - 8,
      b.width + 24, b.height + 16, 8);
    /* little tail pointing at the boss */
    this.tauntFrame.fillStyle(0x000000, 0.82);
    this.tauntFrame.fillTriangle(b.centerX - 7, b.bottom + 6, b.centerX + 7, b.bottom + 6, b.centerX, b.bottom + 18);
    this.tauntFrame.setVisible(true);
    document.getElementById('taunt-region').textContent = this.cfg.name + ': ' + line;
    var self = this;
    this.time.delayedCall(2600, function () {
      self.tauntText.setVisible(false); self.tauntFrame.setVisible(false);
    }, [], this);
  },

  // ---------- style tracking (client-side, last 10s) ----------
  logHist: function (kind) {
    this.hist.push({ t: this.time.now / 1000, kind: kind });
  },
  playerStyle: function () {
    var now = this.time.now / 1000, atk = 0, dash = 0, moved = this._moved10 || 0;
    this.hist = this.hist.filter(function (h) { return now - h.t < 10; });
    this.hist.forEach(function (h) { if (h.kind === 'atk') atk++; if (h.kind === 'dash') dash++; });
    if (atk >= 8 || dash >= 4) return 'aggressive';
    if (moved < 600 && atk < 4) return 'turtly';
    return 'mobile';
  },

  // ---------- brain ----------
  think: function (first) {
    var self = this;
    if (this.over) return;
    var bossPct = Math.max(0, this.b.hp / this.cfg.hp * 100);
    var phase = bossPct < 30 ? 'enrage' : 'normal';
    if (phase !== this.phase) {
      this.phase = phase;
      if (phase === 'enrage') this.enterEnrage();
    }
    var body = { boss_id: this.bossId, tick: this.tick++,
      boss_hp_pct: Math.round(bossPct), player_hp_pct: Math.round(Math.max(0, this.p.hp)),
      player_style: this.playerStyle(), current_tactic: this.b.tactic,
      phase: phase, threats: this.events.slice(-6) };
    this.events = [];
    api('/api/brain', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) })
      .then(function (out) {
        if (self.over) return;
        var now = self.time.now / 1000;
        if (out.tactic_id && out.tactic_id !== self.b.tactic && (first || now - self.lastSwitch >= 6)) {
          self.b.tactic = out.tactic_id; self.lastSwitch = now;
        }
        if (out.taunt) self.say(out.taunt);
        if (typeof out.intensity === 'number') self.b.intensity = out.intensity;
      })
      .catch(function () { /* fight survives a dead model — local AI keeps going */ });
  },

  enterEnrage: function () {
    var e = this.cfg.enrage || {};
    var th = themeFor(this.bossId);
    this.b.enraged = true;
    this.b.speedMul = e.speed_mult || 1.25; this.b.dmgMul = e.damage_mult || 1.25;
    this.bossG.setStrokeStyle(4, 0xff0000, 1);
    this.bossRing.setStrokeStyle(4, 0xff0000, 1);
    this.bossAura.setFillStyle(0xe8322a, 0.35);
    if (!REDUCED && this.bossAura) {
      this.tweens.add({ targets: this.bossAura, scale: 1.25, duration: 500, yoyo: true, repeat: 3 });
    }
    setVignette(true);
    pulseVignette();
    domFlash();
    var line = (e.taunts && e.taunts[0]) || 'Enough, hero — my real power!';
    showBanner('!! ' + this.cfg.name.toUpperCase() + ' ENRAGED !!', 'BELOW 30% — NO MERCY', line);
    this.say(line);
  },

  // ---------- boss attacks ----------
  bossCooldown: function (a) {
    var now = this.time.now / 1000, last = this.b.atkT[a.id] || -99;
    var cd = a.cooldown_s / (this.b.enraged ? 1.2 : 1);
    return (now - last) >= cd;
  },
  markUsed: function (a) { this.b.atkT[a.id] = this.time.now / 1000; },
  tacticPrefs: function () {
    var t = this.b.tactic || '';
    if (/pressure|combo|aggressive|relentless/.test(t)) return { want: ['melee', 'lunge'], near: true };
    if (/bomb|barrage|wall|herd|aerial|corner/.test(t)) return { want: ['aoe_circle', 'projectile', 'cone', 'summon'], near: false };
    return { want: ['melee', 'lunge', 'aoe_circle'], near: true }; // bait/counter/patient
  },
  bossAct: function () {
    if (this.over) return;
    var prefs = this.tacticPrefs();
    var d = dist(this.p.x, this.p.y, this.b.x, this.b.y);
    var cands = this.cfg.attacks.filter(function (a) {
      return this.bossCooldown(a) && (a.pattern === 'projectile' || a.pattern === 'summon' ||
        a.pattern === 'aoe_circle' || d <= a.range_px + 60);
    }, this);
    if (!cands.length) return;
    cands.sort(function (a, b2) {
      return (prefs.want.indexOf(b2.pattern) !== -1) - (prefs.want.indexOf(a.pattern) !== -1);
    });
    var a = Math.random() < 0.7 ? cands[0] : cands[Math.floor(Math.random() * cands.length)];
    this.markUsed(a);
    if (a.id === 'decoy-feint' && Math.random() < 0.35) { this.telegraph(a, true); return; } // fake!
    if (a.id === 'riposte-stance') {
      this.b.stanceT = 1.5;
      this.bossG.setStrokeStyle(5, 0x7CFF6B, 1);
      this.say('Come on, hero. Swing into the thorns.');
      var self = this;
      this.time.delayedCall(1500, function () {
        self.b.stanceT = 0;
        self.bossG.setStrokeStyle(self.b.enraged ? 4 : 0, 0xff0000, 1);
      });
      this.events.push('boss countered');
      return;
    }
    this.telegraph(a, false);
  },
  telegraph: function (a, fake) {
    var self = this;
    var g = this.add.graphics().setName('telegraph').setDepth(2);
    var tx = this.p.x, ty = this.p.y; // snapshot hero pos; she dances out
    var R = a.pattern === 'cone' ? 150 : a.range_px * 0.55;
    if (a.pattern === 'lunge') { tx = this.b.x; ty = this.b.y; }
    /* DANGER language: hot red fill + white dashed rim + bold "!" marker.
     * Shape + glyph + (screen-reader neutral) text — never colour alone. */
    var warn;
    function dangerRing(cx, cy, r) {
      g.fillStyle(fake ? 0x8a6bc9 : 0xe8322a, fake ? 0.28 : 0.38);
      g.fillCircle(cx, cy, r);
      g.lineStyle(4, 0xffffff, 0.95);
      g.strokeCircle(cx, cy, r);
      g.lineStyle(2, 0xe8322a, 1);
      g.strokeCircle(cx, cy, r - 7);
    }
    if (a.pattern === 'summon') { // thorn wall across the arena
      this._wallRect = { x: ARENA.x, y: clamp(ty - 30, ARENA.y, ARENA.y + ARENA.h - 60), w: ARENA.w, h: 60 };
      var wr = this._wallRect;
      g.fillStyle(fake ? 0x8a6bc9 : 0xe8322a, fake ? 0.28 : 0.38);
      g.fillRect(wr.x, wr.y, wr.w, wr.h);
      g.lineStyle(4, 0xffffff, 0.95);
      g.strokeRect(wr.x, wr.y, wr.w, wr.h);
      /* barber-pole ticks along the wall so it reads as DANGER instantly */
      g.lineStyle(3, 0xe8322a, 1);
      for (var wx = wr.x + 10; wx < wr.x + wr.w - 10; wx += 26) {
        g.lineBetween(wx, wr.y + 6, wx + 12, wr.y + wr.h - 6);
      }
      warn = this.add.text(wr.x + wr.w / 2, wr.y + wr.h / 2, fake ? '? FAKE ?' : '! THORNS !',
        { fontFamily: SANS, fontSize: '20px', color: '#fff', fontStyle: 'bold' })
        .setOrigin(0.5).setDepth(3).setStroke('#000', 5);
    } else if (a.pattern === 'cone') {
      g.fillStyle(fake ? 0x8a6bc9 : 0xe8322a, fake ? 0.28 : 0.38);
      g.slice(tx, ty, R, 0, 1.1, true); g.fillPath();
      g.lineStyle(4, 0xffffff, 0.95);
      g.slice(tx, ty, R, 0, 1.1, true); g.strokePath();
      g.fillCircle(tx, ty, 12);
      warn = this.add.text(tx, ty - R - 18, fake ? '? FAKE ?' : '! FIRE !',
        { fontFamily: SANS, fontSize: '20px', color: '#fff', fontStyle: 'bold' })
        .setOrigin(0.5).setDepth(3).setStroke('#000', 5);
    } else {
      var rr = a.pattern === 'melee' ? 70 : R;
      dangerRing(tx, ty, rr);
      warn = this.add.text(tx, ty - rr - 18, fake ? '? FAKE ?' : '!',
        { fontFamily: SANS, fontSize: '26px', color: '#fff', fontStyle: 'bold',
          backgroundColor: '#e8322a', padding: { x: 10, y: 2 } })
        .setOrigin(0.5).setDepth(3);
    }
    if (!REDUCED) {
      self.tweens.add({ targets: warn, scale: 1.15, duration: 220, yoyo: true, repeat: 2 });
    }
    this.time.delayedCall(a.telegraph_ms || 800, function () {
      g.destroy(); warn.destroy();
      if (self.over || fake) { if (fake) self.events.push('boss feinted'); return; }
      self.resolveAttack(a, tx, ty);
    });
  },
  resolveAttack: function (a, tx, ty) {
    var dmg = Math.round(a.damage * this.b.dmgMul);
    if (a.pattern === 'projectile') {
      var o = this.add.circle(this.b.x, this.b.y, 10, 0xffaa22)
        .setStrokeStyle(3, 0xffffff, 1).setDepth(3);
      var dx = this.p.x - this.b.x, dy = this.p.y - this.b.y;
      var m = Math.hypot(dx, dy) || 1;
      this.projectiles.push({ o: o, vx: dx / m * 260, vy: dy / m * 260, dmg: dmg, life: 2.5 });
    } else if (a.pattern === 'summon') {
      var r = this._wallRect, self = this;
      var w = this.add.rectangle(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, 0x3FA34D, 0.7)
        .setStrokeStyle(3, 0xffffff, 0.9).setDepth(3);
      this.walls.push({ o: w, dmg: dmg, life: 4 });
    } else if (a.pattern === 'lunge') {
      this.b.x = clamp(tx + (this.p.x - tx) * 0.2, ARENA.x, ARENA.x + ARENA.w);
      this.b.y = clamp(ty + (this.p.y - ty) * 0.2, ARENA.y, ARENA.y + ARENA.h);
      if (dist(this.p.x, this.p.y, this.b.x, this.b.y) < 80) this.hurtPlayer(dmg, a.id);
      else this.events.push('boss missed');
    } else {
      var R = a.pattern === 'melee' ? 70 : a.range_px * 0.55;
      if (dist(this.p.x, this.p.y, tx, ty) < R + 14) {
        this.hurtPlayer(dmg, a.id);
        if (!REDUCED) { /* impact ring at the blast point */
          var ring = this.add.circle(tx, ty, 12, 0xe8322a, 0.7).setDepth(6);
          this.tweens.add({ targets: ring, scale: 3.2, alpha: 0, duration: 320,
            onComplete: function () { ring.destroy(); } });
        }
      }
      else this.events.push('boss missed');
    }
  },

  // ---------- per-frame ----------
  update: function (time, delta) {
    if (this.over || !this.cfg) return;
    var th = themeFor(this.bossId);
    var dt = Math.min(delta / 1000, 0.05);
    var now = time / 1000;

    // player movement (dash burst overrides joystick)
    var sp = PLAYER.speed;
    if (this.p.dashing > 0) {
      this.p.dashing -= dt;
      this.p.x += this.p.dashDx * sp * 3.2 * dt;
      this.p.y += this.p.dashDy * sp * 3.2 * dt;
    } else if (this.joy.active) {
      this.p.x += this.joy.dx * sp * dt;
      this.p.y += this.joy.dy * sp * dt;
      this._moved10 = (this._moved10 || 0) + Math.hypot(this.joy.dx, this.joy.dy) * sp * dt;
    }
    this._movedDecay = (this._movedDecay || 0) + dt;
    if (this._movedDecay > 10) { this._moved10 = 0; this._movedDecay = 0; }
    this.p.x = clamp(this.p.x, ARENA.x + 14, ARENA.x + ARENA.w - 14);
    this.p.y = clamp(this.p.y, ARENA.y + 14, ARENA.y + ARENA.h - 14);
    this.me.setPosition(this.p.x, this.p.y);
    this.meHalo.setPosition(this.p.x, this.p.y);
    /* facing tick points at the boss; i-frames blink the halo, not just alpha */
    var fa = Math.atan2(this.b.y - this.p.y, this.b.x - this.p.x);
    this.meTick.setPosition(this.p.x + Math.cos(fa) * 24, this.p.y + Math.sin(fa) * 24);
    this.meTick.setRotation(fa + Math.PI / 2);
    this.me.setAlpha(now < this.p.ifrT ? 0.4 : 1);

    // flight phase: cinderjaw takes to the sky at 50%
    if (this.bossId === 'cinderjaw' && !this.b.flying && this.b.hp < this.cfg.hp * 0.5) {
      this.b.flying = true;
      showBanner('CINDERJAW TAKES FLIGHT', 'WINGS UP — THE SKY IS HERS', 'she rains skyfire: keep moving, hero');
      setVignette(true);
      this.say('WINGS UP, hero — the sky is MINE!');
      this.events.push('boss took flight');
      this.think();
    }

    // boss movement: approach / strafe by tactic
    var prefs = this.tacticPrefs();
    var dx = this.p.x - this.b.x, dy = this.p.y - this.b.y;
    var d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    var want = (this.b.flying || !prefs.near) ? 260 : 70;
    var bs = this.cfg.move_speed * this.b.speedMul * (this.b.flying ? 1.15 : 1);
    var dir = d > want + 20 ? 1 : (d < want - 20 ? -1 : 0);
    var strafe = Math.sin(now * 1.3) * 0.7;
    this.b.x = clamp(this.b.x + (dx * dir - dy * strafe * 0.5) * bs * dt, ARENA.x + 20, ARENA.x + ARENA.w - 20);
    this.b.y = clamp(this.b.y + (dy * dir + dx * strafe * 0.5) * bs * dt, ARENA.y + 20, ARENA.y + ARENA.h - 20);
    var lift = this.b.flying ? -34 : 0;
    /* smoke boss smears: violet after-image while enraged */
    if (this.bossId === 'smoke-courier' && this.b.enraged && !REDUCED && Math.random() < dt * 14) {
      var smear = this.add.circle(this.b.x, this.b.y + lift, 22, th.accent, 0.3).setDepth(-1);
      this.tweens.add({ targets: smear, alpha: 0, scale: 1.8, duration: 420,
        onComplete: function () { smear.destroy(); } });
    }
    this.bossG.setPosition(this.b.x, this.b.y + lift);
    this.bossAura.setPosition(this.b.x, this.b.y + lift);
    this.bossRing.setPosition(this.b.x, this.b.y + lift);
    this.bossCore.setPosition(this.b.x, this.b.y + lift);
    if (!REDUCED) {
      var pulse = 1 + Math.sin(now * (this.b.enraged ? 7 : 3)) * (this.b.enraged ? 0.10 : 0.05);
      this.bossAura.setScale(pulse);
    }
    this.bossGlyph.setPosition(this.b.x, this.b.y + lift);
    this.shadow.setPosition(this.b.x, this.b.y + 26);
    this.shadow.setAlpha(this.b.flying ? 0.18 : 0.4);
    this.tauntText.setPosition(this.b.x, clamp(this.b.y + lift - 66, 84, 2000));
    if (this.tauntText.visible) this.say_layout();

    // boss attacks on cooldowns
    this._actT = (this._actT || 0) + dt;
    if (this._actT > 1.2) { this._actT = 0; this.bossAct(); }

    // projectiles + walls
    for (var i = this.projectiles.length - 1; i >= 0; i--) {
      var pr = this.projectiles[i];
      pr.o.x += pr.vx * dt; pr.o.y += pr.vy * dt; pr.life -= dt;
      if (dist(this.p.x, this.p.y, pr.o.x, pr.o.y) < 22) { this.hurtPlayer(pr.dmg, 'fireball'); pr.life = 0; }
      if (pr.life <= 0) { pr.o.destroy(); this.projectiles.splice(i, 1); }
    }
    for (var j = this.walls.length - 1; j >= 0; j--) {
      var wl = this.walls[j]; wl.life -= dt;
      var b = wl.o.getBounds();
      if (this.p.x > b.left && this.p.x < b.right && this.p.y > b.top && this.p.y < b.bottom) {
        this.hurtPlayer(wl.dmg, 'thorn-wall'); wl.life = 0;
      }
      if (wl.life <= 0) { wl.o.destroy(); this.walls.splice(j, 1); }
    }

    // HUD — bars scale by fraction; numbers carry the truth (colour never alone)
    this.phpBar.displayWidth = Math.max(2, this.phpBar.width * clamp(this.p.hp / PLAYER.hp, 0, 1));
    this.phpNum.setText(Math.max(0, Math.round(this.p.hp)) + ' / ' + PLAYER.hp);
    this.bhpBar.displayWidth = Math.max(2, this.bhpBar.width * clamp(this.b.hp / this.cfg.hp, 0, 1));
    this.bhpNum.setText(Math.max(0, Math.round(this.b.hp)) + ' / ' + this.cfg.hp);
    var s = Math.floor((this.time.now - this.startT) / 1000);
    this.clockText.setText(Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
    var cd = 'ATK ' + Math.max(0, PLAYER.atkCd - (now - this.p.atkT)).toFixed(1) + 's  ' +
      'SPEC ' + Math.max(0, PLAYER.specialCd - (now - this.p.specT)).toFixed(1) + 's  ' +
      'DASH ' + Math.max(0, PLAYER.dashCd - (now - this.p.dashT)).toFixed(1) + 's';
    this.cdText.setText(cd);

    // brain every ~8s + phase handled in think()
    this.brainTimer += dt;
    if (this.brainTimer >= 8) { this.brainTimer = 0; this.think(); }

    // endings: opponents FAINT, never die
    if (this.b.hp <= 0) this.finish(true);
    else if (this.p.hp <= 0) this.finish(false);
  },

  /* re-seat the taunt plaque under the moving text (cheap, runs while visible) */
  say_layout: function () {
    var b = this.tauntText.getBounds();
    this.tauntFrame.clear();
    this.tauntFrame.fillStyle(0x000000, 0.82);
    this.tauntFrame.fillRoundedRect(b.centerX - b.width / 2 - 12, b.centerY - b.height / 2 - 8,
      b.width + 24, b.height + 16, 8);
    this.tauntFrame.lineStyle(2, 0xffd75e, 1);
    this.tauntFrame.strokeRoundedRect(b.centerX - b.width / 2 - 12, b.centerY - b.height / 2 - 8,
      b.width + 24, b.height + 16, 8);
  },

  finish: function (won) {
    if (this.over) return;
    this.over = true;
    setVignette(false);
    var secs = (this.time.now - this.startT) / 1000;
    var hpLeft = Math.max(0, Math.round(this.p.hp));
    var score = won ? scoreFor(this.bossId, secs, hpLeft) : 0;
    if (won) {
      var beaten = loadLadder();
      if (beaten.indexOf(this.bossId) === -1) { beaten.push(this.bossId); saveLadder(beaten); }
      this.say('*faints dramatically* ...well fought, hero!');
      showBanner('★ ' + this.cfg.name.toUpperCase() + ' FAINTED ★', 'WELL FOUGHT, HERO!',
        'worth sending to your brother');
    } else {
      showBanner('SO CLOSE, HERO', 'THAT BOSS GOT LUCKY', 'shake it off — you were learning its moves');
    }
    var self = this;
    this.time.delayedCall(won ? 1200 : 600, function () {
      self.scene.start('end', { bossId: self.bossId, won: won, secs: secs, hpLeft: hpLeft, score: score });
    });
  }
});

// ================= END =================
var EndScene = new Phaser.Class({
  Extends: Phaser.Scene,
  initialize: function () { Phaser.Scene.call(this, { key: 'end' }); },
  init: function (data) { this.r = data; },
  create: function () {
    setVignette(false);
    var W = this.scale.width, H = this.scale.height;
    var beaten = loadLadder();
    var cfg = null;
    BOSSES.forEach(function (b) { if (b.id === this.r.bossId) cfg = b; }, this);
    var th = themeFor(this.r.won ? (cfg && cfg.id) : (cfg && cfg.id));
    backdrop(this, this.r.won ? 0xc9962e : th.accent);
    var cx = W / 2, cy = H / 2;

    /* storybook panel */
    var pw = Math.min(560, W - 48), ph = this.r.won ? 380 : 330;
    var g = this.add.graphics();
    g.fillStyle(0x000000, 0.55); g.fillRoundedRect(cx - pw / 2 + 5, cy - ph / 2 + 7, pw, ph, 18);
    g.fillStyle(this.r.won ? 0x2b1f14 : 0x1c1410, 1);
    g.fillRoundedRect(cx - pw / 2, cy - ph / 2, pw, ph, 18);
    g.lineStyle(3, this.r.won ? 0xffd75e : 0xf5e6c8, 1);
    g.strokeRoundedRect(cx - pw / 2, cy - ph / 2, pw, ph, 18);

    var title, sub;
    if (this.r.won) {
      title = '★ BOSS FAINTED! ★';
      this.add.text(cx, cy - ph / 2 + 52, title,
        { fontFamily: SERIF, fontSize: '40px', color: '#ffd75e', fontStyle: 'bold' })
        .setOrigin(0.5).setStroke('#5c1a08', 5);
      this.add.text(cx, cy - ph / 2 + 92, '“' + (cfg ? cfg.title : '') + '” — not today.',
        { fontFamily: SERIF, fontSize: '15px', color: '#d9c49a', fontStyle: 'italic', align: 'center',
          wordWrap: { width: pw - 80 } }).setOrigin(0.5);
      /* stat cards: TIME / HP LEFT / SCORE — big numbers, screenshot bait */
      var m = Math.floor(this.r.secs / 60), s = Math.floor(this.r.secs % 60);
      var stats = [
        { k: 'TIME', v: m + ':' + String(s).padStart(2, '0') },
        { k: 'HP LEFT', v: String(this.r.hpLeft) + ' ♥' },
        { k: 'SCORE', v: String(this.r.score) }
      ];
      var cw = (pw - 80) / 3;
      stats.forEach(function (st, i) {
        var sx = cx - (pw - 80) / 2 + cw * i + cw / 2;
        var card = this.add.graphics();
        card.fillStyle(0x17110b, 1);
        card.fillRoundedRect(sx - cw / 2 + 4, cy - 52, cw - 8, 92, 10);
        card.lineStyle(2, 0xc9962e, 1);
        card.strokeRoundedRect(sx - cw / 2 + 4, cy - 52, cw - 8, 92, 10);
        this.add.text(sx, cy - 32, st.k,
          { fontFamily: SANS, fontSize: '13px', color: '#d9c49a', fontStyle: 'bold' }).setOrigin(0.5);
        this.add.text(sx, cy + 4, st.v,
          { fontFamily: SERIF, fontSize: '30px', color: '#ffd75e', fontStyle: 'bold' }).setOrigin(0.5);
      }, this);
      this.add.text(cx, cy + 72, 'Ladder: ' + beaten.length + ' / ' + LADDER.length + ' bosses fainted',
        { fontFamily: SANS, fontSize: '16px', color: '#f5e6c8' }).setOrigin(0.5);
      if (!REDUCED) {
        for (var ci = 0; ci < 24; ci++) {
          var star = this.add.text(cx + (Math.random() - 0.5) * pw, cy - ph / 2 + 40 + Math.random() * 60, '★',
            { fontSize: (10 + Math.random() * 14) + 'px', color: '#ffd75e' }).setOrigin(0.5);
          this.tweens.add({ targets: star, y: cy + ph / 2 - 30, alpha: 0,
            duration: 1200 + Math.random() * 900, delay: Math.random() * 700,
            onComplete: (function (st2) { return function () { st2.destroy(); }; })(star) });
        }
      }
    } else {
      title = 'So close, hero!';
      this.add.text(cx, cy - ph / 2 + 56, title,
        { fontFamily: SERIF, fontSize: '40px', color: '#f5e6c8', fontStyle: 'bold' })
        .setOrigin(0.5).setStroke('#000', 5);
      this.add.text(cx, cy - ph / 2 + 104, '“' + (cfg && cfg.taunt_voice[1] ? cfg.taunt_voice[1] : 'That boss got lucky.') + '”',
        { fontFamily: SERIF, fontSize: '16px', color: th.css, fontStyle: 'italic', align: 'center',
          wordWrap: { width: pw - 80 } }).setOrigin(0.5);
      sub = 'You were learning its moves — every dodge counts.\nOne tap and you are back in. It is still scared of you.';
      this.add.text(cx, cy - 10, sub,
        { fontFamily: SANS, fontSize: '18px', color: '#f5e6c8', align: 'center' }).setOrigin(0.5);
    }
    var y = cy + ph / 2 - (this.r.won ? 108 : 96);
    var mk = function (label, primary, cb) {
      var tw = Math.min(360, pw - 120);
      var bg = this.add.graphics();
      bg.fillStyle(primary ? 0xc9962e : 0x000000, primary ? 1 : 0.6);
      bg.fillRoundedRect(cx - tw / 2, y - 26, tw, 52, 10);
      bg.lineStyle(2, primary ? 0xffd75e : 0x9cc8ff, 1);
      bg.strokeRoundedRect(cx - tw / 2, y - 26, tw, 52, 10);
      var t = this.add.text(cx, y, label,
        { fontFamily: SANS, fontSize: '22px', color: primary ? '#17110b' : '#9cc8ff', fontStyle: 'bold' })
        .setOrigin(0.5);
      t.setInteractive();
      t.on('pointerdown', cb);
      y += 64;
    }.bind(this);
    var r = this.r;
    mk('↻  REMATCH', !r.won, function () { this.scene.start('fight', { bossId: r.bossId }); }.bind(this));
    if (r.won) {
      var next = LADDER[LADDER.indexOf(r.bossId) + 1];
      if (next && unlocked(next, beaten)) {
        mk('→  NEXT BOSS', true, function () { this.scene.start('fight', { bossId: next }); }.bind(this));
      }
    }
    mk('←  BOSSES', false, function () { this.scene.start('select'); }.bind(this));
  }
});

// ================= BOOT =================
window.addEventListener('load', function () {
  api('/api/bosses').then(function (data) {
    BOSSES = data.bosses;
    new Phaser.Game({
      type: Phaser.AUTO,
      parent: 'game-root',
      transparent: true,
      scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
      scene: [MenuScene, SelectScene, FightScene, EndScene]
    });
  }).catch(function () {
    document.getElementById('game-root').innerHTML =
      '<p style="padding:40px">Could not reach the game server. Check your connection and reload.</p>';
  });
});
})();
