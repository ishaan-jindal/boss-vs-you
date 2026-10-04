// # ponytail: procedural beeps, swap to sampled audio later
/* Tiny procedural SFX + ambient music: Web Audio oscillators/noise only, no assets.
 * AudioContext is created lazily on first sfx() call (a user gesture starts
 * every fight, so autoplay policy holds); nothing throws before then. Music
 * routes through the same master gain, so the mute flag silences both. */
const LS_MUTED = 'bvy.muted';
const MASTER = 0.35;
let ctx = null, master = null, noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem(LS_MUTED) === '1'; } catch { muted = false; }
function ac() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); return ctx; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : MASTER;
  master.connect(ctx.destination);
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
function tone(type, f0, f1, dur, vol, delay) {
  const c = ac(); if (!c) return;
  const t0 = c.currentTime + (delay || 0);
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(20, f0), t0);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol || 1, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise(dur, vol, delay, fEnd) {
  const c = ac(); if (!c) return;
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.3), c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = c.currentTime + (delay || 0);
  const s = c.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const f = c.createBiquadFilter(); f.type = 'lowpass';
  f.frequency.setValueAtTime(4000, t0);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, fEnd || 400), t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol || 1, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  s.connect(f); f.connect(g); g.connect(master);
  s.start(t0); s.stop(t0 + dur + 0.02);
}
export function sfx(name) {
  if (muted) return;
  try {
    switch (name) {
      case 'hit': tone('square', 520, 180, 0.12); break;
      case 'shoot': tone('sawtooth', 220, 880, 0.18); break;
      case 'hurt': tone('sawtooth', 160, 60, 0.25); break;
      case 'potion':
        tone('sine', 440, 440, 0.09); tone('sine', 554, 554, 0.09, 1, 0.08); tone('sine', 659, 659, 0.12, 1, 0.16);
        break;
      case 'clear':
        tone('sine', 523, 523, 0.12); tone('sine', 659, 659, 0.12, 1, 0.1); tone('sine', 784, 784, 0.2, 1, 0.2);
        break;
      case 'death': noise(0.28, 0.9); tone('sawtooth', 300, 50, 0.28, 0.8); break;
      case 'ui': tone('square', 800, 800, 0.05, 0.6); break;
    }
  } catch { /* audio never breaks the fight */ }
}
export function isMuted() { return muted; }
export function toggle() {
  muted = !muted;
  try { localStorage.setItem(LS_MUTED, muted ? '1' : '0'); } catch { /* run survives */ }
  try { if (master) master.gain.value = muted ? 0 : MASTER; } catch { /* visual only */ }
  return muted;
}

// # ponytail: procedural drone+arp, compose real tracks later
/* Ambient dungeon loop: low drone (55Hz root + detuned 82.5Hz fifth through a
 * lowpass) + slow minor arp (A2-C3-E3-G2 sine plucks, one ~1.2s) + faint
 * noise wash. `fight` adds a ~60bpm heartbeat kick; `menu` is sparser/quieter.
 * Lookahead scheduler (250ms tick, 500ms horizon) so timing never drifts.
 * Never starts before the first user gesture; never throws. */
const MUSIC_VOL = 0.12;
const ARP = [110, 130.81, 164.81, 98];
let gestured = false, pendingMode = null;
let musicOn = false, musicMode = 'menu', musicTimer = null;
let musicGain = null, drone = [], nextArpT = 0, nextKickT = 0, arpStep = 0, ducked = false;
function markGesture() {
  if (gestured) return;
  gestured = true;
  if (pendingMode && !musicOn) { const m = pendingMode; pendingMode = null; musicStart(m); }
}
try {
  window.addEventListener('pointerdown', markGesture);
  window.addEventListener('keydown', markGesture);
} catch { /* non-browser: music stays off */ }
function musicLevel() { return MUSIC_VOL * (musicMode === 'menu' ? 0.7 : 1) * (ducked ? 0.5 : 1); }
function pluck(f, t) {
  const c = ctx; if (!c || !musicGain) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = f;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(musicMode === 'menu' ? 0.3 : 0.5, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
  o.connect(g); g.connect(musicGain);
  o.start(t); o.stop(t + 1.2);
}
function kick(t) {
  const c = ctx; if (!c || !musicGain) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(60, t);
  o.frequency.exponentialRampToValueAtTime(35, t + 0.15);
  g.gain.setValueAtTime(0.7, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g); g.connect(musicGain);
  o.start(t); o.stop(t + 0.25);
}
function schedule() {
  try {
    const c = ctx;
    if (!c || !musicOn || !musicGain) return;
    if (c.state === 'suspended') { c.resume().catch(() => {}); return; }
    if (nextArpT < c.currentTime - 0.2) { // tab was hidden: skip, never stack a burst
      const n = Math.ceil((c.currentTime - nextArpT) / 1.2);
      arpStep += n; nextArpT += n * 1.2;
    }
    while (nextArpT < c.currentTime + 0.5) {
      if (musicMode === 'fight' || arpStep % 2 === 0) pluck(ARP[arpStep % ARP.length], Math.max(nextArpT, c.currentTime + 0.01));
      arpStep++; nextArpT += 1.2;
    }
    if (musicMode === 'fight') {
      if (nextKickT < c.currentTime - 0.2) nextKickT = c.currentTime + 0.05;
      while (nextKickT < c.currentTime + 0.5) { kick(Math.max(nextKickT, c.currentTime + 0.01)); nextKickT += 1.0; }
    } else nextKickT = c.currentTime + 0.1; // menu: no pulse; keep the clock fresh for the switch
  } catch { /* scheduler never breaks the fight */ }
}
export function musicStart(mode) {
  try {
    if (!gestured && !ctx) { pendingMode = mode === 'fight' ? 'fight' : 'menu'; return; }
    const c = ac(); if (!c) return;
    musicMode = mode === 'fight' ? 'fight' : 'menu';
    if (musicOn) { if (musicGain) musicGain.gain.value = musicLevel(); return; } // mode switch: drone keeps running
    musicGain = c.createGain();
    musicGain.gain.value = musicLevel();
    musicGain.connect(master);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    const dg = c.createGain(); dg.gain.value = 0.5;
    lp.connect(dg); dg.connect(musicGain);
    drone = [[55, 'sine', 0], [82.5, 'triangle', 6]].map(([f, ty, det]) => {
      const o = c.createOscillator();
      o.type = ty; o.frequency.value = f; o.detune.value = det;
      o.connect(lp); o.start(); return o;
    });
    const wb = c.createBuffer(1, Math.floor(c.sampleRate), c.sampleRate);
    const wd = wb.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const w = c.createBufferSource(); w.buffer = wb; w.loop = true;
    const wf = c.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 300;
    const wg = c.createGain(); wg.gain.value = 0.04;
    w.connect(wf); wf.connect(wg); wg.connect(musicGain); w.start();
    drone.push(w);
    arpStep = 0; nextArpT = c.currentTime + 0.1; nextKickT = c.currentTime + 0.1;
    musicOn = true;
    musicTimer = setInterval(schedule, 250);
  } catch { /* audio never breaks the fight */ }
}
export function musicStop() {
  try {
    musicOn = false; pendingMode = null;
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    for (const o of drone) { try { o.stop(); } catch {} try { o.disconnect(); } catch {} }
    drone = [];
    if (musicGain) { try { musicGain.disconnect(); } catch {} musicGain = null; }
  } catch { /* visual only */ }
}
export function musicDuck(on) {
  ducked = !!on;
  try { if (musicGain) musicGain.gain.value = musicLevel(); } catch { /* visual only */ }
}
