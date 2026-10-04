// # ponytail: procedural beeps, swap to sampled audio later
/* Tiny procedural SFX: Web Audio oscillators/noise only, no assets, no music.
 * AudioContext is created lazily on first sfx() call (a user gesture starts
 * every fight, so autoplay policy holds); nothing throws before then. */
const LS_MUTED = 'bvy.muted';
const MASTER = 0.2;
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
