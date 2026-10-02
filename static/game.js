/* Boss vs You — Phaser 3 client. Plain JS, no bundler.
 *
 * DESIGNER HOOKS (stable names for a later visual pass):
 * DOM: #game-root (.bv-root), #taunt-region (.bv-taunt, role=status), #rotate-hint
 * Scene keys: 'menu' | 'select' | 'fight' | 'end'
 * Fight object names: 'player', 'boss', 'boss-shadow', 'joystick-base',
 *   'joystick-knob', 'btn-attack', 'btn-special', 'btn-dash', 'btn-potion',
 *   'player-hpbar', 'boss-hpbar', 'taunt-bubble', 'telegraph', 'boss-taunt-text'
 * localStorage: 'bvy-ladder' (array of beaten boss ids, in ladder order)
 * Ladder order: ['smoke-courier', 'cinderjaw', 'briar-knight']
 */
(function () {
'use strict';

var LADDER = ['smoke-courier', 'cinderjaw', 'briar-knight'];
var ARENA = { x: 40, y: 90, w: 720, h: 460 };
var PLAYER = { hp: 100, speed: 220, atkDmg: 8, atkCd: 0.6, atkRange: 100,
  dashCd: 4, specialDmg: 25, specialCd: 12, specialRange: 150,
  potionHeal: 30, potions: 2 };
var SCORE_BASE = { 'smoke-courier': 1000, 'cinderjaw': 1500, 'briar-knight': 2000 };

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

// ---------- shared touch button ----------
function touchButton(scene, x, y, label, size, cb) {
  var c = scene.add.container(x, y);
  var bg = scene.add.circle(0, 0, size / 2, 0x222a33, 0.85).setStrokeStyle(2, 0xffffff, 0.6);
  var t = scene.add.text(0, 0, label, { fontSize: '15px', color: '#fff' }).setOrigin(0.5);
  c.add([bg, t]);
  c.setSize(size, size).setInteractive({ useHandCursor: false });
  c.on('pointerdown', function () { bg.setFillStyle(0x3a5a8a, 1); cb(); });
  c.on('pointerup', function () { bg.setFillStyle(0x222a33, 0.85); });
  c.on('pointerout', function () { bg.setFillStyle(0x222a33, 0.85); });
  return c;
}

// ================= MENU =================
var MenuScene = new Phaser.Class({
  Extends: Phaser.Scene,
  initialize: function () { Phaser.Scene.call(this, { key: 'menu' }); },
  create: function () {
    var W = this.scale.width, H = this.scale.height;
    this.add.text(W / 2, H / 2 - 60, 'BOSS vs YOU', { fontSize: '56px', color: '#fff' }).setOrigin(0.5);
    this.add.text(W / 2, H / 2, 'Dodge the red. Bonk the boss.\n3 bosses. No mercy (playful mercy).',
      { fontSize: '20px', color: '#ccc', align: 'center' }).setOrigin(0.5);
    var b = this.add.text(W / 2, H / 2 + 110, '▶  TAP TO PLAY  ◀',
      { fontSize: '30px', color: '#ffd75e', backgroundColor: '#333', padding: { x: 24, y: 16 } }).setOrigin(0.5);
    b.setInteractive({ useHandCursor: false });
    b.on('pointerdown', function () { this.scene.start('select'); }.bind(this));
  }
});

// ================= SELECT =================
var SelectScene = new Phaser.Class({
  Extends: Phaser.Scene,
  initialize: function () { Phaser.Scene.call(this, { key: 'select' }); },
  create: function () {
    var W = this.scale.width;
    this.add.text(W / 2, 60, 'Pick your boss', { fontSize: '34px', color: '#fff' }).setOrigin(0.5);
    var beaten = loadLadder();
    var y = 150;
    BOSSES.forEach(function (b, i) {
      var ok = unlocked(b.id, beaten);
      var done = beaten.indexOf(b.id) !== -1;
      var row = this.add.container(W / 2, y);
      var bg = this.add.rectangle(0, 0, Math.min(560, W - 40), 96,
        ok ? 0x1d2530 : 0x141414, 1).setStrokeStyle(2, done ? 0xffd75e : 0x666666, 1);
      var glyph = this.add.text(-250, 0, b.glyph, { fontSize: '44px', color: '#fff' }).setOrigin(0.5);
      glyph.setColor('#' + b.colour.toString(16).padStart(6, '0'));
      var name = this.add.text(-210, -22, (ok ? '' : '🔒 ') + (i + 1) + '. ' + b.name + (done ? '  ★' : ''),
        { fontSize: '22px', color: ok ? '#fff' : '#777' });
      var sub = this.add.text(-210, 8, ok ? b.title : 'Beat the previous boss to unlock',
        { fontSize: '15px', color: '#aaa' });
      row.add([bg, glyph, name, sub]);
      if (ok) {
        bg.setInteractive({ useHandCursor: false });
        bg.on('pointerdown', function () { this.scene.start('fight', { bossId: b.id }); }.bind(this));
      }
      y += 116;
    }, this);
    var back = this.add.text(W / 2, y + 10, '← menu', { fontSize: '22px', color: '#8cf' }).setOrigin(0.5);
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
    var W = this.scale.width, H = this.scale.height;
    ARENA = { x: 20, y: 110, w: W - 40, h: H - 260 };

    // state
    this.p = { x: W / 2, y: ARENA.y + ARENA.h - 80, hp: PLAYER.hp, potions: PLAYER.potions,
      atkT: 0, specT: 0, dashT: 0, ifrT: 0, dashDx: 0, dashDy: 0, dashing: 0 };
    this.b = { x: W / 2, y: ARENA.y + 90, hp: this.cfg.hp, enraged: false, flying: false,
      stanceT: 0, atkT: {}, tactic: this.cfg.tactics[0].id, speedMul: 1, dmgMul: 1 };
    this.over = false; this.startT = this.time.now; this.tick = 0;
    this.lastSwitch = -9999; this.events = []; this.hist = []; // hist: {t, moved, atk, dash}
    this.brainTimer = 0; this.pendingTelegraphs = []; this.projectiles = []; this.walls = [];
    this.phase = 'normal';

    // arena + actors
    this.add.rectangle(W / 2, ARENA.y + ARENA.h / 2, ARENA.w, ARENA.h, 0x161c26, 1)
      .setStrokeStyle(2, 0x445566, 1);
    this.shadow = this.add.ellipse(this.b.x, this.b.y + 26, 56, 16, 0x000000, 0.35).setName('boss-shadow');
    this.bossG = this.add.circle(this.b.x, this.b.y, 26, this.cfg.colour).setName('boss');
    this.bossGlyph = this.add.text(this.b.x, this.b.y, this.cfg.glyph, { fontSize: '28px', color: '#fff' }).setOrigin(0.5);
    this.me = this.add.circle(this.p.x, this.p.y, 16, 0x4da3ff).setName('player');
    this.gfx = this.add.graphics();

    // HP bars
    this.add.text(24, 18, 'YOU', { fontSize: '16px', color: '#fff' });
    this.phpBar = this.add.rectangle(70, 28, 220, 16, 0x4da3ff, 1).setOrigin(0, 0.5).setName('player-hpbar');
    this.add.text(24, 42, 'POT ×' + this.p.potions, { fontSize: '14px', color: '#8f8' }).setName('potion-count');
    this.add.text(W - 294, 18, this.cfg.name.toUpperCase(), { fontSize: '16px', color: '#fff' });
    this.bhpBar = this.add.rectangle(W - 294, 38, 270, 16, 0xff5544, 1).setOrigin(0, 0.5).setName('boss-hpbar');
    this.tauntText = this.add.text(this.b.x, this.b.y - 56, '', { fontSize: '16px', color: '#ffe9a8',
      backgroundColor: '#000000aa', padding: { x: 8, y: 4 } }).setOrigin(0.5).setName('taunt-bubble')
      .setDepth(5).setVisible(false);
    this.clockText = this.add.text(W / 2, 26, '0:00', { fontSize: '18px', color: '#fff' }).setOrigin(0.5);

    // ---- joystick (left thumb, base ≥60px: 120px diameter) ----
    this.joy = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0 };
    this.joyBase = this.add.circle(0, 0, 60, 0xffffff, 0.12).setVisible(false).setName('joystick-base');
    this.joyKnob = this.add.circle(0, 0, 26, 0xffffff, 0.35).setVisible(false).setName('joystick-knob');
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
    var by = H - 92, bx = W - 70;
    touchButton(this, bx - 168, by, 'ATK', 76, function () { self.tryAttack(false); }).setName('btn-attack');
    touchButton(this, bx - 84, by - 66, 'SPEC', 76, function () { self.tryAttack(true); }).setName('btn-special');
    touchButton(this, bx, by, 'DASH', 76, function () { self.tryDash(); }).setName('btn-dash');
    touchButton(this, bx - 84, by + 8, 'POT', 64, function () { self.tryPotion(); }).setName('btn-potion');
    this.cdText = this.add.text(bx - 200, by + 52, '', { fontSize: '13px', color: '#ccc' });

    this.say(this.cfg.taunt_voice[0] || ('I am ' + this.cfg.name + '!'));
    this.think(true); // opening brain call; silent tactic set
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
      if (!REDUCED) this.cameras.main.shake(60, 0.003);
      // melee arc swipe
      var a = this.add.circle(this.b.x, this.b.y, range, 0xffffff, 0.18);
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
  },
  tryPotion: function () {
    if (this.over || this.p.potions <= 0 || this.p.hp >= PLAYER.hp) return;
    this.p.potions--; this.p.hp = Math.min(PLAYER.hp, this.p.hp + PLAYER.potionHeal);
    this.children.getByName('potion-count').setText('POT ×' + this.p.potions);
    this.events.push('player healed');
  },
  hurtPlayer: function (dmg, why) {
    var now = this.time.now / 1000;
    if (now < this.p.ifrT || this.over) return; // i-frames save you
    this.p.hp -= dmg;
    this.events.push('player hit' + (why ? ' (' + why + ')' : ''));
    this.flash(this.me, 0xff0000);
    if (!REDUCED) this.cameras.main.shake(90, 0.006);
  },
  flash: function (obj, color) {
    var orig = obj.fillColor;
    obj.setFillStyle(color, 1);
    this.time.delayedCall(90, function () { obj.setFillStyle(orig, 1); });
  },
  say: function (line) {
    this.tauntText.setText(line).setVisible(true);
    document.getElementById('taunt-region').textContent = this.cfg.name + ': ' + line;
    this.time.delayedCall(2600, function () { this.tauntText.setVisible(false); }, [], this);
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
    this.b.enraged = true;
    this.b.speedMul = e.speed_mult || 1.25; this.b.dmgMul = e.damage_mult || 1.25;
    this.bossG.setStrokeStyle(4, 0xff0000, 1);
    var line = (e.taunts && e.taunts[0]) || 'Enough, hero — my real power!';
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
      var self = this;
      this.time.delayedCall(1500, function () { self.b.stanceT = 0; self.bossG.setStrokeStyle(0); });
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
    if (a.pattern === 'summon') { // thorn wall across the arena
      g.fillStyle(0xff0000, 0.35);
      this._wallRect = { x: ARENA.x, y: clamp(ty - 30, ARENA.y, ARENA.y + ARENA.h - 60), w: ARENA.w, h: 60 };
      g.fillRect(this._wallRect.x, this._wallRect.y, this._wallRect.w, this._wallRect.h);
    } else if (a.pattern === 'cone') {
      g.fillStyle(0xff0000, 0.35);
      g.slice(tx, ty, R, 0, 1.1, true); g.fillPath();
      g.fillCircle(tx, ty, 12);
    } else {
      g.fillStyle(0xff0000, 0.35);
      g.fillCircle(tx, ty, a.pattern === 'melee' ? 70 : R);
    }
    this.time.delayedCall(a.telegraph_ms || 800, function () {
      g.destroy();
      if (self.over || fake) { if (fake) self.events.push('boss feinted'); return; }
      self.resolveAttack(a, tx, ty);
    });
  },
  resolveAttack: function (a, tx, ty) {
    var dmg = Math.round(a.damage * this.b.dmgMul);
    if (a.pattern === 'projectile') {
      var o = this.add.circle(this.b.x, this.b.y, 10, 0xffaa22);
      var dx = this.p.x - this.b.x, dy = this.p.y - this.b.y;
      var m = Math.hypot(dx, dy) || 1;
      this.projectiles.push({ o: o, vx: dx / m * 260, vy: dy / m * 260, dmg: dmg, life: 2.5 });
    } else if (a.pattern === 'summon') {
      var r = this._wallRect, self = this;
      var w = this.add.rectangle(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, 0x3FA34D, 0.7);
      this.walls.push({ o: w, dmg: dmg, life: 4 });
    } else if (a.pattern === 'lunge') {
      this.b.x = clamp(tx + (this.p.x - tx) * 0.2, ARENA.x, ARENA.x + ARENA.w);
      this.b.y = clamp(ty + (this.p.y - ty) * 0.2, ARENA.y, ARENA.y + ARENA.h);
      if (dist(this.p.x, this.p.y, this.b.x, this.b.y) < 80) this.hurtPlayer(dmg, a.id);
      else this.events.push('boss missed');
    } else {
      var R = a.pattern === 'melee' ? 70 : a.range_px * 0.55;
      if (dist(this.p.x, this.p.y, tx, ty) < R + 14) this.hurtPlayer(dmg, a.id);
      else this.events.push('boss missed');
    }
  },

  // ---------- per-frame ----------
  update: function (time, delta) {
    if (this.over || !this.cfg) return;
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
    this.me.setAlpha(now < this.p.ifrT ? 0.4 : 1);

    // flight phase: cinderjaw takes to the sky at 50%
    if (this.bossId === 'cinderjaw' && !this.b.flying && this.b.hp < this.cfg.hp * 0.5) {
      this.b.flying = true;
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
    this.bossG.setPosition(this.b.x, this.b.y + lift);
    this.bossGlyph.setPosition(this.b.x, this.b.y + lift);
    this.shadow.setPosition(this.b.x, this.b.y + 26);
    this.tauntText.setPosition(this.b.x, this.b.y + lift - 56);

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

    // HUD
    this.phpBar.displayWidth = 220 * clamp(this.p.hp / PLAYER.hp, 0, 1);
    this.bhpBar.displayWidth = 270 * clamp(this.b.hp / this.cfg.hp, 0, 1);
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

  finish: function (won) {
    if (this.over) return;
    this.over = true;
    var secs = (this.time.now - this.startT) / 1000;
    var hpLeft = Math.max(0, Math.round(this.p.hp));
    var score = won ? scoreFor(this.bossId, secs, hpLeft) : 0;
    if (won) {
      var beaten = loadLadder();
      if (beaten.indexOf(this.bossId) === -1) { beaten.push(this.bossId); saveLadder(beaten); }
      this.say('*faints dramatically* ...well fought, hero!');
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
    var W = this.scale.width, H = this.scale.height;
    var beaten = loadLadder();
    var title, sub;
    if (this.r.won) {
      title = '★ ' + 'BOSS FAINTED! ★';
      var m = Math.floor(this.r.secs / 60), s = Math.floor(this.r.secs % 60);
      sub = 'Time ' + m + ':' + String(s).padStart(2, '0') +
        '   HP left ' + this.r.hpLeft +
        '\nScore ' + this.r.score +
        '\nLadder: ' + beaten.length + ' / ' + LADDER.length;
    } else {
      title = 'So close, hero!';
      sub = 'That boss got lucky. Shake it off —\nyou were learning its moves. Rematch?';
    }
    this.add.text(W / 2, H / 2 - 130, title, { fontSize: '40px', color: '#ffd75e' }).setOrigin(0.5);
    this.add.text(W / 2, H / 2 - 40, sub, { fontSize: '22px', color: '#fff', align: 'center' }).setOrigin(0.5);
    var y = H / 2 + 80;
    var mk = function (label, cb) {
      var t = this.add.text(W / 2, y, label, { fontSize: '26px', color: '#8cf',
        backgroundColor: '#222', padding: { x: 28, y: 14 } }).setOrigin(0.5);
      t.setInteractive();
      t.on('pointerdown', cb);
      y += 70;
    }.bind(this);
    var r = this.r;
    mk('↻  REMATCH', function () { this.scene.start('fight', { bossId: r.bossId }); }.bind(this));
    if (r.won) {
      var next = LADDER[LADDER.indexOf(r.bossId) + 1];
      if (next && unlocked(next, beaten)) {
        mk('→  NEXT BOSS', function () { this.scene.start('fight', { bossId: next }); }.bind(this));
      }
    }
    mk('←  BOSSES', function () { this.scene.start('select'); }.bind(this));
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
