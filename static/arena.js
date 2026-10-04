/* Boss vs You — pixel dungeon renderer (Canvas 2D, cramped gothic room).
 * Same exports/signatures as the old Three.js arena so game.js is untouched.
 * Internal res 480x270, CSS scales up with image-rendering: pixelated.
 * World maps: x in [-ARENA_X, ARENA_X] -> screen, z in [-ARENA_Z, ARENA_Z].
 */
import { getSprite } from './sprites.js';

export const ARENA_X = 11;
export const ARENA_Z = 8;
const W = 480, H = 270;

const RECIPE_SPRITE = {
  courier: 'boss_crawler', crawler: 'boss_crawler',
  cinderjaw: 'boss_wraith', wraith: 'boss_wraith',
  knight: 'boss_colossus', colossus: 'boss_colossus',
  hollow: 'boss_hollow',
};

export function createArena(canvas, opts = {}) {
  const reducedMotion = !!opts.reducedMotion;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;

  const hero = { x: 3.2, z: 2.5, facing: -0.6, blink: 0 };
  const boss = { x: -3, z: -2.5, angle: 0.6, sprite: 'boss_crawler' };
  const telegraphs = [];
  const projectiles = new Map();
  const decoys = [];
  const parts = []; // {x,y,vx,vy,life,max,color,size}
  const cracks = []; // {x,z,rot}
  let shakeT = 0, shakeAmp = 0, enraged = false, flyY = 0, riposte = false;
  let shX = 0, shY = 0;

  function w2s(x, z, y = 0) {
    return { x: 240 + x * 17.5 + shX, y: 168 + z * 10.5 - y * 15 + shY };
  }
  function spr(name, sx, sy, scale = 2, flip = false) {
    const img = getSprite(name);
    const w = 16 * scale, h = 16 * scale;
    if (flip) { g.save(); g.translate(sx, 0); g.scale(-1, 1); g.drawImage(img, -w / 2, sy - h, w, h); g.restore(); }
    else g.drawImage(img, sx - w / 2, sy - h, w, h);
  }

  function setBoss(recipe, visual = {}) { boss.sprite = RECIPE_SPRITE[recipe] || 'boss_crawler'; enraged = false; }
  function heroPos(x, z, facing, iframes, dashing) {
    hero.x = x; hero.z = z; hero.facing = facing;
    hero.blink = iframes ? hero.blink + 1 : 0;
  }
  function bossPos(x, z) { boss.x = x; boss.z = z; }
  function bossFace(angle) { boss.angle = angle; }

  function spawnTelegraph(s) {
    const h = { x: s.x, z: s.z, r: s.r || 2, pattern: s.pattern || 'circle', fake: !!s.fake, w: s.w || 6, d: s.d || 2.4, t: 0 };
    telegraphs.push(h); return h;
  }
  function popTelegraph(h, burstAt = null) {
    const i = telegraphs.indexOf(h);
    if (i !== -1) telegraphs.splice(i, 1);
    if (burstAt) burst(burstAt[0], burstAt[1], burstAt[2], burstAt[3], burstAt[4]);
  }
  function clearTelegraphs() { telegraphs.length = 0; }

  function burst(x, z, color = 0xffd75e, n = 10, up = 4) {
    if (parts.length > 120) return;
    const p = w2s(x, z);
    const css = '#' + (color >>> 0).toString(16).padStart(6, '0');
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 20 + Math.random() * 50;
      parts.push({ x: p.x, y: p.y - 14, vx: Math.cos(a) * sp, vy: -up * 12 - Math.random() * 30, life: 0.4 + Math.random() * 0.25, max: 0.6, color: css, size: 2 + (Math.random() * 2 | 0) });
    }
  }
  function dust(x, z, n = 8) {
    if (reducedMotion || parts.length > 120) return;
    const p = w2s(x, z);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      parts.push({ x: p.x + (Math.random() - 0.5) * 10, y: p.y - 2, vx: Math.cos(a) * 14, vy: -8 - Math.random() * 10, life: 0.5, max: 0.5, color: '#8a7f8e', size: 2 });
    }
  }
  function spawnCrack(x, z) { cracks.push({ x, z }); if (cracks.length > 8) cracks.shift(); }
  function clearCracks() { cracks.length = 0; }

  function spawnProjectile(id, x, z) { projectiles.set(id, { x, z }); }
  function moveProjectile(id, x, z) { const m = projectiles.get(id); if (m) { m.x = x; m.z = z; } }
  function killProjectile(id) { projectiles.delete(id); }

  function spawnWall(id, x, z, w, d) {}
  function killWall(id) {}

  function spawnDecoys(list) { clearDecoys(); for (const [x, z] of list) decoys.push({ x, z }); }
  function popDecoy(d) { const i = decoys.indexOf(d); if (i !== -1) decoys.splice(i, 1); }
  function clearDecoys() { decoys.length = 0; }

  function shake(amt) { if (reducedMotion) return; shakeAmp = Math.max(shakeAmp, amt * 6); shakeT = 0.3; }
  function setFlight(on) { flyY = on ? 2.5 : 0; }
  function setEnrage(on) { enraged = on; }
  function setRiposte(on) { riposte = on; }
  function puffSmoke() { dust(boss.x, boss.z, 4); }

  function project(x, y, z) {
    const p = w2s(x, z, y);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + (p.x / W) * r.width, y: r.top + (p.y / H) * r.height };
  }
  function countTris() { return { hero: 0, boss: 0, total: 0 }; }
  function drawCalls() { return 1; }
  function resize() { canvas.width = W; canvas.height = H; g.imageSmoothingEnabled = false; }

  function drawTelegraph(h, t) {
    const p = w2s(h.x, h.z);
    const pulse = h.t < 0.25 ? 0.55 + (h.t / 0.25) * 0.45 : 1 + Math.sin(h.t * 14) * 0.03;
    const col = h.fake ? 'rgba(138,107,201,' : 'rgba(232,50,42,';
    if (h.pattern === 'wall') {
      const w = h.w * 17.5 * pulse, d = Math.max(6, h.d * 10.5 * 4);
      g.fillStyle = '#14100c'; g.fillRect(p.x - w / 2 - 2, p.y - d / 2 - 2, w + 4, d + 4);
      g.fillStyle = col + '0.8)'; g.fillRect(p.x - w / 2, p.y - d / 2, w, d);
    } else {
      const r = h.r * 15 * pulse;
      g.fillStyle = col + '0.7)';
      g.beginPath(); g.ellipse(p.x, p.y, r, r * 0.45, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,246,232,0.85)';
      g.beginPath(); g.ellipse(p.x, p.y, r * 0.45, r * 0.2, 0, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = h.fake ? '#8a6bc9' : '#e8322a';
    g.fillRect(p.x - 6, p.y - 44, 12, 12);
    g.fillStyle = '#fff'; g.font = 'bold 10px monospace'; g.textAlign = 'center';
    g.fillText(h.fake ? '?' : '!', p.x, p.y - 34);
  }

  function frame(dt, t) {
    if (!reducedMotion && shakeT > 0) {
      shakeT -= dt;
      shX = (Math.random() - 0.5) * shakeAmp * Math.max(0, shakeT / 0.3);
      shY = (Math.random() - 0.5) * shakeAmp * 0.6 * Math.max(0, shakeT / 0.3);
      if (shakeT <= 0) { shX = shY = shakeAmp = 0; }
    } else { shX = shY = 0; }
    // back wall with arch suggestion
    g.fillStyle = '#2a2438'; g.fillRect(0, 0, W, 112);
    g.fillStyle = '#1a1626'; g.fillRect(150, 30, 180, 82);
    g.fillStyle = '#2a2438'; g.fillRect(165, 45, 150, 67);
    g.fillStyle = '#4a3f55'; g.fillRect(150, 26, 180, 6); g.fillRect(150, 108, 180, 4);
    g.fillStyle = '#14101e'; g.fillRect(0, 110, W, 4);
    // floor tiles
    for (let ty = 0; ty < 5; ty++) for (let tx = 0; tx < 15; tx++) {
      g.fillStyle = (tx + ty) % 2 ? '#4a3f55' : '#443a4e';
      g.fillRect(tx * 32 + shX, 114 + ty * 32 + shY, 32, 32);
    }
    g.drawImage(getSprite('rug'), 0, 0, 16, 16, 170 + shX, 150 + shY, 140, 90);
    // cracks
    g.fillStyle = '#1a1626';
    for (const c of cracks) { const p = w2s(c.x, c.z); g.fillRect(p.x - 8, p.y - 2, 16, 3); g.fillRect(p.x - 2, p.y - 7, 3, 14); }
    for (const h of telegraphs) { h.t += dt; drawTelegraph(h, t); }
    for (const d of decoys) { const p = w2s(d.x, d.z); g.globalAlpha = 0.6; spr('boss_crawler', p.x, p.y, 2); g.globalAlpha = 1; }
    // boss + aura + shadow
    {
      const p = w2s(boss.x, boss.z, flyY * 0.4);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(p.x, w2s(boss.x, boss.z).y, 20, 7, 0, 0, Math.PI * 2); g.fill();
      const ar = 26 + (reducedMotion ? 0 : Math.sin(t * (enraged ? 9 : 3)) * 3);
      g.strokeStyle = enraged ? '#ff3b30' : '#e8322a'; g.lineWidth = 3;
      g.beginPath(); g.ellipse(p.x, p.y - 4, ar, ar * 0.45, 0, 0, Math.PI * 2); g.stroke();
      const fr = reducedMotion ? 0 : (t * 4 | 0) % 2;
      spr(boss.sprite, p.x, p.y - (fr ? 2 : 0), 3, Math.sin(boss.angle) < 0);
      if (riposte) { g.fillStyle = '#fff'; g.fillRect(p.x - 20, p.y - 52, 5, 18); }
    }
    // hero + shadow (i-frame blink)
    {
      const p = w2s(hero.x, hero.z);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(p.x, p.y, 12, 4.5, 0, 0, Math.PI * 2); g.fill();
      if (!(hero.blink && (hero.blink % 6 < 3))) {
        const fr = reducedMotion ? 0 : (t * 3 | 0) % 2;
        spr('hero_idle_' + fr, p.x, p.y, 2, hero.facing < 0);
      }
    }
    // projectiles
    for (const [, pr] of projectiles) {
      const p = w2s(pr.x, pr.z, 0.6);
      g.fillStyle = '#fff6e8'; g.fillRect(p.x - 5, p.y - 5, 10, 10);
      g.fillStyle = '#ffb02e'; g.fillRect(p.x - 3, p.y - 3, 6, 6);
    }
    // pillars (solid blocks, front corners)
    spr('pillar', 52 + shX, 236 + shY, 3); spr('pillar', 428 + shX, 236 + shY, 3);
    // braziers with flicker
    const bf = reducedMotion ? 0 : (t * 6 | 0) % 2;
    spr(bf ? 'brazier_1' : 'brazier_0', 120 + shX, 140 + shY, 2);
    spr(bf ? 'brazier_0' : 'brazier_1', 360 + shX, 140 + shY, 2);
    // particles
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i]; q.life -= dt;
      if (q.life <= 0) { parts.splice(i, 1); continue; }
      q.vy += 160 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
      g.globalAlpha = Math.max(0, q.life / q.max); g.fillStyle = q.color;
      g.fillRect(q.x, q.y, q.size, q.size); g.globalAlpha = 1;
    }
    // vignette
    const vg = g.createLinearGradient(0, 0, 0, H);
    vg.addColorStop(0, 'rgba(10,6,18,0.45)'); vg.addColorStop(0.4, 'rgba(10,6,18,0)');
    vg.addColorStop(1, 'rgba(10,6,18,0.4)');
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
  }

  return {
    ARENA_X, ARENA_Z,
    setBoss, heroPos, bossPos, bossFace,
    spawnTelegraph, popTelegraph, clearTelegraphs,
    burst, dust, spawnCrack, clearCracks,
    spawnProjectile, moveProjectile, killProjectile,
    spawnWall, killWall, spawnDecoys, popDecoy, clearDecoys, decoys,
    shake, setFlight, setEnrage, setRiposte, puffSmoke,
    project, countTris, drawCalls, resize, frame,
  };
}
