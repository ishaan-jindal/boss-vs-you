/* Boss vs You — 3D arena scene (Three.js, fixed camera, no addons).
 *
 * Owns: renderer, fixed 3/4 diorama camera, lights, ground + painted ring,
 * procedural low-poly fighters with inverted-hull outlines + blob shadows,
 * ground-decal telegraphs with `!` badges, projectiles, walls, decoys,
 * hit debris + billboard dust, persistent crack decals, camera shake,
 * flight-phase lift, enrage aura flare.
 *
 * Grit without gore: impact comes from debris, dust, cracks, shake and
 * chunky silhouettes — never blood. All fighters stay toy-like.
 *
 * Does NOT own: game rules, input, HUD, brain client (see game.js).
 * Hitstop lives in game.js (it freezes update, not rendering).
 * The camera never moves by design (fixed diorama; shake offsets only).
 */
import * as THREE from 'three';

const ARENA_X = 11;   // playable half-extent on X
const ARENA_Z = 8;    // playable half-extent on Z
const WINDUP_SCALE_T = 0.25;

/* Harsh 3-step toon ramp: deep shade band for punchy comic contrast. */
function makeGradientMap() {
  const data = new Uint8Array([110, 190, 255]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

function toon(color, extra = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: makeGradientMap(), ...extra });
}

/* Inverted-hull outlines: black back-side shells, chunky for harsh contrast. Cheap. */
const OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: 0x14100c, side: THREE.BackSide });
function addOutline(root, scale = 1.07) {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && !o.userData.isShell) meshes.push(o); });
  for (const m of meshes) {
    const shell = new THREE.Mesh(m.geometry, OUTLINE_MAT);
    shell.scale.setScalar(scale);
    shell.raycast = () => {};
    shell.userData.isShell = true;
    m.add(shell);
  }
}

function blobShadow(r, opacity = 0.35) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(r, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.02;
  m.userData.isShell = true;
  return m;
}

/* Flat dashed ring texture for telegraph rims (1 draw call).
 * Black-backed so the rim reads on dark ground: thick black underlay,
 * white dashes on top, thin black+white inner circle. */
let dashTex = null;
function dashedRingTexture() {
  if (dashTex) return dashTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.strokeStyle = '#0d0b1a';
  g.lineWidth = 24;
  g.beginPath();
  g.arc(128, 128, 108, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 11;
  g.setLineDash([26, 16]);
  g.beginPath();
  g.arc(128, 128, 108, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = '#0d0b1a';
  g.lineWidth = 11;
  g.beginPath();
  g.arc(128, 128, 88, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(128, 128, 88, 0, Math.PI * 2);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 1;
  dashTex = t;
  return t;
}

/* `!` badge texture (also used for `?` fake-outs via tint).
 * Black-backed chunky badge so it pops against sky and ground. */
function badgeTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#0d0b1a';
  g.beginPath();
  if (g.roundRect) g.roundRect(6, 6, 116, 116, 24);
  else g.rect(6, 6, 116, 116);
  g.fill();
  g.fillStyle = '#e8322a';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 8;
  g.beginPath();
  if (g.roundRect) g.roundRect(14, 14, 100, 100, 18);
  else g.rect(14, 14, 100, 100);
  g.fill();
  g.stroke();
  g.fillStyle = '#ffffff';
  g.font = '900 76px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('!', 64, 68);
  return new THREE.CanvasTexture(c);
}
let badgeTex = null;

/* Soft smoke puff texture. */
function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* Cracked-ground decal: jagged dry-mud cracks radiating from center.
 * Stamped under heavy hits, persists for the fight. Grit, not gore. */
let crackTex = null;
function crackTexture() {
  if (crackTex) return crackTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.lineCap = 'round';
  const jag = (x0, y0, ang, len, w) => {
    g.strokeStyle = '#2a1c10';
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, y0);
    let x = x0, y = y0, a = ang;
    const steps = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < steps; i++) {
      a += (Math.random() - 0.5) * 1.1;
      const l = len / steps;
      x += Math.cos(a) * l; y += Math.sin(a) * l;
      g.lineTo(x, y);
    }
    g.stroke();
  };
  for (let i = 0; i < 7; i++) jag(64, 64, (i / 7) * Math.PI * 2 + Math.random() * 0.4, 34 + Math.random() * 22, 5);
  for (let i = 0; i < 5; i++) jag(64, 64, Math.random() * Math.PI * 2, 20 + Math.random() * 18, 2.5);
  crackTex = new THREE.CanvasTexture(c);
  crackTex.anisotropy = 1;
  return crackTex;
}

/* ---------- fighter builders (each < 200 tris, verified by countTris) ---------- */

function buildHero() {
  const g = new THREE.Group();
  const blue = toon(0x4da3ff);
  const skin = toon(0xffd9b3);
  const red = toon(0xe8322a, { side: THREE.DoubleSide });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.48, 0.95, 7), blue);
  body.position.y = 0.85;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 7, 5), skin);
  head.position.y = 1.62;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.35, 6, 3, 0, Math.PI * 2, 0, 1.5), toon(0x3a2a1a));
  hair.position.y = 1.68;
  const scarfGeo = new THREE.PlaneGeometry(0.75, 0.3, 3, 1);
  const scarf = new THREE.Mesh(scarfGeo, red);
  scarf.position.set(0, 1.32, -0.42);
  scarf.rotation.x = 0.25;
  const tick = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.34, 6), toon(0xffd75e));
  tick.rotation.x = Math.PI / 2;
  tick.position.set(0, 0.9, 0.62);
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.52, 0.68, 12),
    new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.05;
  halo.userData.isShell = true;
  /* scuffed veteran: a bandage on the cheek. Grit, never gore. */
  const bandage = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.09, 0.03), toon(0xfff2d8));
  bandage.position.set(0.13, 1.56, 0.3);
  bandage.rotation.z = 0.25;

  g.add(body, head, hair, scarf, tick, halo, bandage);
  addOutline(g);
  g.userData = { scarf, scarfBase: scarfGeo.attributes.position.array.slice(), halo, tick, blink: 0 };
  return g;
}

function buildCourier(pal) {
  const g = new THREE.Group();
  const bodyMat = toon(pal.body ?? 0x2b2440);
  const hatMat = toon(pal.hat ?? 0x1a1626);
  const spikeM = toon(0x14101f);
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.5, 7), bodyMat);
  body.position.y = 0.95;
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.09, 10), hatMat);
  hat.position.y = 1.78;
  const hatTop = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.5, 6), hatMat);
  hatTop.position.y = 2.05;
  /* jagged brim spikes: monstrous silhouette, same tri trick as horns */
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const s = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.38, 5), spikeM);
    s.position.set(Math.cos(a) * 0.72, 1.98, Math.sin(a) * 0.72);
    s.rotation.z = -Math.cos(a) * 0.35;
    s.rotation.x = Math.sin(a) * 0.35;
    g.add(s);
  }
  /* scuff slashes across the cloak: this courier has been bonked before */
  const scuffM = toon(0x14101f);
  const s1 = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.03), scuffM);
  s1.position.set(0.05, 1.0, 0.3);
  s1.rotation.z = 0.5;
  const s2 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.03), scuffM);
  s2.position.set(-0.08, 0.72, 0.4);
  s2.rotation.z = -0.4;
  g.add(s1, s2);
  const eyeMat = new THREE.MeshBasicMaterial({ color: pal.eye ?? 0xcbb7ff });
  const eL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.06), eyeMat);
  eL.position.set(-0.16, 1.25, 0.5);
  const eR = eL.clone();
  eR.position.x = 0.16;
  eL.userData.isShell = eR.userData.isShell = true;
  g.add(body, hat, hatTop, eL, eR, s1, s2);
  addOutline(g);
  // smoke puffs (sprite planes, idle-hidden, puff on dash)
  const puffT = puffTexture();
  const puffs = [];
  for (let i = 0; i < 3; i++) {
    const p = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({ map: puffT, color: 0x8a6bc9, transparent: true, opacity: 0, depthWrite: false })
    );
    p.userData.isShell = true;
    p.userData.seed = i * 2.1;
    g.add(p);
    puffs.push(p);
  }
  g.userData = { puffs, puffT: 0, eyeMat };
  return g;
}

function buildCinderjaw(pal) {
  const g = new THREE.Group();
  const bodyM = toon(pal.body ?? 0xe0572b);
  const jawM = toon(pal.jaw ?? 0x7a2a12);
  const wingM = toon(pal.wing ?? 0x5c1a08, { side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.1, 1.15), bodyM);
  body.position.y = 1.15;
  const jawTop = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.32, 0.9), jawM);
  jawTop.position.set(0, 1.55, 0.55);
  const jawBot = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.28, 0.85), jawM);
  jawBot.position.set(0, 1.05, 0.55);
  const wingGeo = new THREE.PlaneGeometry(1.5, 0.8);
  const wL = new THREE.Mesh(wingGeo, wingM);
  wL.position.set(-1.35, 1.7, -0.2);
  wL.rotation.y = 0.5;
  const wR = new THREE.Mesh(wingGeo, wingM);
  wR.position.set(1.35, 1.7, -0.2);
  wR.rotation.y = -0.5;
  const eyeM = new THREE.MeshBasicMaterial({ color: pal.eye ?? 0xffd75e });
  const eL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.08), eyeM);
  eL.position.set(-0.35, 1.35, 0.6);
  const eR = eL.clone();
  eR.position.x = 0.35;
  eL.userData.isShell = eR.userData.isShell = true;
  const hornM = toon(0x2b1410);
  const hL = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.8, 5), hornM);
  hL.position.set(-0.6, 2.05, -0.1);
  const hR = hL.clone();
  hR.position.x = 0.6;
  /* spine spikes + a signature battle scar on the flank */
  const sp1 = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.42, 5), hornM);
  sp1.position.set(-0.4, 1.9, -0.25);
  sp1.rotation.x = -0.3;
  const sp2 = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 5), hornM);
  sp2.position.set(0, 1.95, -0.3);
  sp2.rotation.x = -0.3;
  const sp3 = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.42, 5), hornM);
  sp3.position.set(0.4, 1.9, -0.25);
  sp3.rotation.x = -0.3;
  const scar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.03), hornM);
  scar.position.set(0.3, 1.2, 0.585);
  scar.rotation.z = 0.6;
  const scar2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.07, 0.03), hornM);
  scar2.position.set(-0.35, 1.0, 0.585);
  scar2.rotation.z = -0.5;
  g.add(body, jawTop, jawBot, wL, wR, eL, eR, hL, hR, sp1, sp2, sp3, scar, scar2);
  addOutline(g);
  g.userData = { wL, wR, jawBot, jawPhase: 0 };
  return g;
}

function buildKnight(pal) {
  const g = new THREE.Group();
  const armour = toon(pal.body ?? 0x3fa34d);
  const dark = toon(pal.dark ?? 0x1d5c28);
  const dentM = toon(0x101408);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.2, 0.7), armour);
  body.position.y = 1.0;
  const helm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.55, 0.6), dark);
  helm.position.y = 1.9;
  /* heavy pauldrons + a taller war-plume: do-not-mess-with silhouette */
  const pdL = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.44), armour);
  pdL.position.set(-0.62, 1.62, 0);
  const pdR = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.44), armour);
  pdR.position.set(0.62, 1.62, 0);
  const plume = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.68, 5), toon(0xe8322a));
  plume.position.y = 2.5;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.3, 0.14), toon(pal.sword ?? 0xf5e6c8));
  blade.position.set(0.75, 1.2, 0.2);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.2), dark);
  guard.position.set(0.75, 0.6, 0.2);
  const shield = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.9, 0.7), toon(pal.shield ?? 0x2e7a3a));
  shield.position.set(-0.68, 1.0, 0.25);
  /* dent gashes on the shield face: somebody has been swinging */
  const d1 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.42, 0.09), dentM);
  d1.position.set(-0.775, 1.1, 0.15);
  d1.rotation.x = 0.2;
  const d2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.34, 0.09), dentM);
  d2.position.set(-0.775, 0.88, 0.35);
  d2.rotation.x = -0.25;
  const glint = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false })
  );
  glint.position.set(-0.78, 1.3, 0.25);
  glint.rotation.y = -Math.PI / 2;
  glint.userData.isShell = true;
  const eyeM = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.05), eyeM);
  visor.position.set(0, 1.9, 0.32);
  visor.userData.isShell = true;
  g.add(body, helm, pdL, pdR, plume, blade, guard, shield, d1, d2, glint, visor);
  addOutline(g);
  g.userData = { shield, glint, sword: blade };
  return g;
}

const BUILDERS = { hero: buildHero, courier: buildCourier, cinderjaw: buildCinderjaw, knight: buildKnight };

export function createArena(canvas, opts = {}) {
  const reducedMotion = !!opts.reducedMotion;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = false; // blob shadows only, always

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffe9c4);
  scene.fog = new THREE.Fog(0xffe9c4, 30, 55);

  /* Fixed diorama camera: 3/4 angle, never moves (shake offsets only). */
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const CAM_BASE = new THREE.Vector3(0, 15.5, 12.5);
  const CAM_LOOK = new THREE.Vector3(0, 0, -0.8);
  camera.position.copy(CAM_BASE);
  camera.lookAt(CAM_LOOK);

  scene.add(new THREE.HemisphereLight(0xfff6e0, 0x3fa34d, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 1.15);
  sun.position.set(6, 12, 5);
  scene.add(sun);

  /* Ground: sun-baked dusty green + painted white arena ring. */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 44),
    toon(0x37a055)
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(9.2, 9.75, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);
  const ringInner = new THREE.Mesh(
    new THREE.RingGeometry(6.4, 6.55, 40),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide })
  );
  ringInner.rotation.x = -Math.PI / 2;
  ringInner.position.y = 0.01;
  scene.add(ringInner);
  const mid = new THREE.Mesh(
    new THREE.RingGeometry(1.0, 1.12, 24),
    new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
  );
  mid.rotation.x = -Math.PI / 2;
  mid.position.y = 0.01;
  scene.add(mid);

  /* Chunky diorama props outside the ring (flat, outlined, static). */
  const props = new THREE.Group();
  const propMats = [toon(0x2e7a3a), toon(0x8a6bc9), toon(0xe0572b), toon(0xc9962e)];
  const propSpots = [
    [-14.5, -6, 'tree'], [14.5, -5, 'rock'], [-13.5, 5.5, 'rock'],
    [13.8, 6, 'tree'], [-6, -11.5, 'rock'], [7, -11.8, 'tree'], [0, 11.5, 'rock'],
  ];
  propSpots.forEach(([x, z, kind], i) => {
    const m = propMats[i % propMats.length];
    let p;
    if (kind === 'tree') {
      p = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 1.2, 6), toon(0x6b4d22));
      trunk.position.y = 0.6;
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.3, 2.4, 7), m);
      top.position.y = 2.4;
      p.add(trunk, top);
    } else {
      p = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.2), m);
      p.position.y = 0.5;
      p.rotation.y = i * 0.7;
    }
    p.position.x = x;
    p.position.z = z;
    props.add(p);
  });
  addOutline(props, 1.04);
  scene.add(props);

  const hero = buildHero();
  scene.add(hero);
  const heroShadow = blobShadow(0.55);
  scene.add(heroShadow);

  let boss = null;
  let bossShadow = blobShadow(0.95);
  scene.add(bossShadow);
  let bossAura = null;
  let bossRecipe = 'courier';
  let flyTarget = 0;
  let enraged = false;
  let riposteOn = false;

  const telegraphs = [];   // {group, badge, t}
  const projectiles = new Map(); // id -> mesh
  const walls = new Map();       // id -> mesh
  const decoys = [];             // grey clone groups
  const bursts = [];             // {mesh, vx, vy, vz, life, max}
  let shakeT = 0;
  let shakeAmp = 0;
  if (!badgeTex) badgeTex = badgeTexture();
  const dashT = dashedRingTexture();

  function setBoss(recipe, visual = {}) {
    if (boss) { scene.remove(boss); }
    for (const d of decoys) scene.remove(d);
    decoys.length = 0;
    bossRecipe = recipe;
    const scale = visual.scale ?? 1;
    const pal = visual.palette ?? {};
    const build = BUILDERS[recipe] || BUILDERS.courier;
    boss = build(pal);
    boss.scale.setScalar(scale);
    scene.add(boss);
    if (bossAura) scene.remove(bossAura);
    const accent = pal.trim ?? pal.body ?? 0xe8322a;
    bossAura = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.45, 28),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    core.rotation.x = -Math.PI / 2;
    core.userData.isShell = true;
    const glow2 = new THREE.Mesh(
      new THREE.RingGeometry(1.45, 2.0, 28),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    glow2.rotation.x = -Math.PI / 2;
    glow2.position.y = 0.005;
    glow2.userData.isShell = true;
    bossAura.add(core, glow2);
    bossAura.position.y = 0.03;
    bossAura.userData.accent = accent;
    scene.add(bossAura);
    flyTarget = 0;
    enraged = false;
    riposteOn = false;
  }

  function heroPos(x, z, facing, iframes, dashing) {
    hero.position.set(x, 0, z);
    hero.rotation.y = facing;
    const u = hero.userData;
    u.blink = iframes ? u.blink + 1 : 0;
    hero.visible = iframes ? (u.blink % 6 < 3) : true; // i-frame blink, not alpha-alone
    heroShadow.position.set(x, 0.02, z);
  }

  function bossPos(x, z) {
    if (!boss) return;
    boss.position.x = x;
    boss.position.z = z;
    bossShadow.position.set(x, 0.02, z);
    if (bossAura) bossAura.position.set(x, 0.03, z);
    // face the hero: caller passes facing separately
  }

  function bossFace(angle) {
    if (boss) boss.rotation.y = angle;
  }

  function spawnTelegraph({ x, z, r, pattern = 'circle', fake = false, angle = 0, arc = 1.0, w = 6, d = 2.4 }) {
    const group = new THREE.Group();
    const red = fake ? 0x8a6bc9 : 0xef1f1f;
    /* near-opaque so the red survives blending over green (fighters inside
     * tint red = you are IN the danger); hot white core marks the middle */
    const discMat = new THREE.MeshBasicMaterial({ color: red, transparent: true, opacity: 0.78, depthWrite: false, side: THREE.DoubleSide });
    const rimMat = new THREE.MeshBasicMaterial({ map: dashT, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    /* near-white hot core at the center of every telegraph: danger screams */
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff6e8, transparent: true, opacity: 0.92, depthWrite: false, side: THREE.DoubleSide });
    if (pattern === 'cone') {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 14, -arc / 2, arc), discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.rotation.z = angle - Math.PI / 2;
      disc.position.y = 0.03;
      group.add(disc);
      const core = new THREE.Mesh(new THREE.CircleGeometry(r * 0.5, 10, -arc / 2, arc), coreMat);
      core.rotation.x = -Math.PI / 2;
      core.rotation.z = angle - Math.PI / 2;
      core.position.y = 0.04;
      group.add(core);
      /* white edge rails along the sector sides so the cone reads instantly */
      const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
      for (const s of [-1, 1]) {
        const edge = new THREE.Mesh(new THREE.BoxGeometry(r, 0.02, 0.14), edgeMat);
        const ea = angle + s * arc / 2;
        edge.position.set(Math.sin(ea) * r / 2, 0.045, Math.cos(ea) * r / 2);
        edge.rotation.y = ea + Math.PI / 2;
        edge.userData.isShell = true;
        group.add(edge);
      }
    } else if (pattern === 'wall') {
      const under = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.6, d + 0.6),
        new THREE.MeshBasicMaterial({ color: 0x14100c, transparent: true, opacity: 0.95, depthWrite: false }));
      under.rotation.x = -Math.PI / 2;
      under.position.y = 0.03;
      const mid2 = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.25, d + 0.25),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }));
      mid2.rotation.x = -Math.PI / 2;
      mid2.position.y = 0.04;
      const disc = new THREE.Mesh(new THREE.PlaneGeometry(w, d), discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.05;
      const core = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.55, d * 0.7), coreMat);
      core.rotation.x = -Math.PI / 2;
      core.position.y = 0.06;
      group.add(under, mid2, disc, core);
    } else {
      const rr = pattern === 'melee' ? Math.max(r, 2.2) : r;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(rr, 28), discMat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.03;
      const rim = new THREE.Mesh(new THREE.PlaneGeometry(rr * 2, rr * 2), rimMat);
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = 0.045;
      const core = new THREE.Mesh(new THREE.CircleGeometry(rr * 0.45, 20), coreMat);
      core.rotation.x = -Math.PI / 2;
      core.position.y = 0.04;
      group.add(disc, rim, core);
    }
    const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTex, depthTest: false, transparent: true }));
    if (fake) badge.material.color.set(0xcbb7ff);
    badge.scale.set(1.5, 1.5, 1);
    badge.position.set(x, 1.6, z);
    group.add(badge);
    group.position.set(x, 0, z);
    group.scale.setScalar(0.55);
    scene.add(group);
    const h = { group, badge, t: 0 };
    telegraphs.push(h);
    return h;
  }

  function popTelegraph(h, burstAt = null) {
    const i = telegraphs.indexOf(h);
    if (i !== -1) telegraphs.splice(i, 1);
    scene.remove(h.group);
    h.badge.material.dispose();
    if (burstAt) burst(...burstAt);
  }

  function clearTelegraphs() {
    while (telegraphs.length) popTelegraph(telegraphs[0]);
  }

  function burst(x, z, color = 0xffd75e, n = 10, up = 4, h = 0.9) {
    if (bursts.length > 40) return; // trivial counts, tablet-safe
    for (let i = 0; i < n; i++) {
      const s = 0.14 + Math.random() * 0.16;
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(s, s, s),
        new THREE.MeshBasicMaterial({ color })
      );
      m.position.set(x, h, z);
      m.userData.isShell = true;
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 3.5;
      scene.add(m);
      bursts.push({ mesh: m, vx: Math.cos(a) * sp, vy: up * (0.5 + Math.random() * 0.8), vz: Math.sin(a) * sp, life: 0.45 + Math.random() * 0.2, max: 0.6 });
    }
  }

  /* Billboard dust: kicked-up grit that rises, spreads and fades.
   * Shared geometry + texture; per-puff material only. Capped, tablet-safe. */
  const dustTex = puffTexture();
  const dustGeo = new THREE.PlaneGeometry(1, 1);
  const dusts = []; // {mesh, vx, vz, vy, life, max, grow}
  function dust(x, z, n = 8, color = 0xd8c49a, spread = 3, h = 0.4) {
    for (let i = 0; i < n; i++) {
      if (dusts.length > 30) return;
      const m = new THREE.Mesh(
        dustGeo,
        new THREE.MeshBasicMaterial({ map: dustTex, color, transparent: true, opacity: 0.55, depthWrite: false })
      );
      const s = 0.7 + Math.random() * 0.8;
      m.scale.setScalar(s);
      m.position.set(x + (Math.random() - 0.5) * 0.6, h, z + (Math.random() - 0.5) * 0.6);
      m.userData.isShell = true;
      const a = Math.random() * Math.PI * 2;
      const sp = 0.8 + Math.random() * spread;
      scene.add(m);
      dusts.push({
        mesh: m, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 1 + Math.random() * 1.4,
        life: 0.5 + Math.random() * 0.35, max: 0.8, grow: 1.4 + Math.random(),
      });
    }
  }

  /* Crack decals: heavy hits scar the ground for the rest of the fight.
   * Max 8; oldest fades out as new ones land. Cleared per fight. */
  const cracks = [];
  function spawnCrack(x, z, rot = Math.random() * Math.PI * 2, s = 1) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6 * s, 2.6 * s),
      new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, opacity: 0.85, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = rot;
    m.position.set(x, 0.02, z);
    m.userData.isShell = true;
    scene.add(m);
    cracks.push(m);
    if (cracks.length > 8) {
      const old = cracks.shift();
      scene.remove(old);
      old.material.dispose();
    }
  }
  function clearCracks() {
    while (cracks.length) {
      const m = cracks.pop();
      scene.remove(m);
      m.material.dispose();
    }
  }

  function spawnProjectile(id, x, z, color = 0xffb02e) {
    killProjectile(id);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 8, 6),
      new THREE.MeshBasicMaterial({ color })
    );
    const shell = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({ color: 0xfff6e8, side: THREE.BackSide }));
    shell.scale.setScalar(1.35);
    shell.raycast = () => {};
    m.add(shell);
    m.position.set(x, 1.0, z);
    scene.add(m);
    projectiles.set(id, m);
  }
  function moveProjectile(id, x, z) {
    const m = projectiles.get(id);
    if (m) m.position.set(x, 1.0, z);
  }
  function killProjectile(id) {
    const m = projectiles.get(id);
    if (m) { scene.remove(m); projectiles.delete(id); }
  }

  function spawnWall(id, x, z, w, d, color = 0x3fa34d) {
    killWall(id);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1.3, d), toon(color));
    m.position.set(x, 0.65, z);
    /* pale crown so the wall top reads at a glance (excluded from tri counts) */
    const crown = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.1, d + 0.08),
      new THREE.MeshBasicMaterial({ color: 0xeaffea })
    );
    crown.position.y = 0.68;
    crown.userData.isShell = true;
    m.add(crown);
    addOutline(m, 1.03);
    scene.add(m);
    walls.set(id, m);
  }
  function killWall(id) {
    const m = walls.get(id);
    if (m) { scene.remove(m); walls.delete(id); }
  }

  function spawnDecoys(list) {
    clearDecoys();
    for (const [x, z] of list) {
      const d = buildCourier({ body: 0x6a6a72, hat: 0x4a4a52, eye: 0xbbbbbb });
      d.position.set(x, 0, z);
      scene.add(d);
      decoys.push(d);
      const sh = blobShadow(0.55);
      sh.position.set(x, 0.02, z);
      d.userData.shadow = sh;
      scene.add(sh);
    }
  }
  function popDecoy(d) {
    burst(d.position.x, d.position.z, 0x8a6bc9, 8, 3);
    scene.remove(d);
    if (d.userData.shadow) scene.remove(d.userData.shadow);
    const i = decoys.indexOf(d);
    if (i !== -1) decoys.splice(i, 1);
  }
  function clearDecoys() {
    while (decoys.length) popDecoy(decoys[0]);
  }

  function shake(amt) {
    if (reducedMotion) return;
    shakeAmp = Math.max(shakeAmp, amt);
    shakeT = 0.3;
  }

  function setFlight(on) { flyTarget = on ? 4 : 0; }
  function setEnrage(on) {
    enraged = on;
    if (bossAura) {
      /* ember flare: both rings go hot red; calm restores the boss accent */
      const c = on ? 0xff3b30 : (bossAura.userData.accent ?? 0xffffff);
      bossAura.traverse((o) => { if (o.isMesh) o.material.color.set(c); });
      bossAura.scale.setScalar(on ? 1.35 : 1);
    }
  }
  function setRiposte(on) {
    riposteOn = on;
    if (boss && boss.userData.glint) boss.userData.glint.material.opacity = on ? 0.9 : 0;
  }
  function puffSmoke() {
    if (boss && boss.userData.puffs) boss.userData.puffT = 1;
  }

  function project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(camera);
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height };
  }

  function countTris() {
    const out = { hero: 0, boss: 0 };
    const count = (root) => {
      let n = 0;
      root.traverse((o) => {
        if (o.isMesh && !o.userData.isShell && o.geometry) {
          const g = o.geometry;
          n += Math.round((g.index ? g.index.count : g.attributes.position.count) / 3);
        }
      });
      return n;
    };
    out.hero = count(hero);
    if (boss) out.boss = count(boss);
    out.total = out.hero + out.boss;
    return out;
  }
  function drawCalls() { return renderer.info.render.calls; }

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const clockV = new THREE.Vector3();
  function frame(dt, t) {
    /* idle animation: cheap sin/cos dressing, frozen when reduced-motion */
    const k = reducedMotion ? 0 : 1;
    // hero scarf flutter
    const u = hero.userData;
    if (u.scarf && k) {
      const pos = u.scarf.geometry.attributes.position;
      const base = u.scarfBase;
      for (let i = 0; i < pos.count; i++) {
        const bx = base[i * 3];
        pos.setZ(i, Math.sin(t * 7 + bx * 5) * 0.09 * (0.5 - bx + 0.75));
      }
      pos.needsUpdate = true;
      u.halo.rotation.z = t * 0.8;
    }
    if (boss && k) {
      const bu = boss.userData;
      if (bu.wL) {
        const flap = Math.sin(t * (flyTarget > 0 ? 9 : 3.5)) * 0.4;
        bu.wL.rotation.x = flap * 0.5;
        bu.wR.rotation.x = -flap * 0.5;
        bu.jawBot.position.z = 0.55 + Math.max(0, Math.sin(t * 1.7)) * 0.18; // jaw chomp
      }
      if (bu.shield && riposteOn) {
        bu.shield.position.set(-0.68, 1.55, 0.45); // shield raised
        bu.glint.material.opacity = 0.55 + Math.abs(Math.sin(t * 10)) * 0.35;
      } else if (bu.shield) {
        bu.shield.position.set(-0.68, 1.0, 0.25);
      }
      if (bu.puffs) {
        if (bu.puffT > 0) bu.puffT = Math.max(0, bu.puffT - dt * 1.4);
        for (const p of bu.puffs) {
          const ph = (t * 0.7 + p.userData.seed + (1 - bu.puffT) * 2) % 1;
          const active = bu.puffT > 0;
          p.material.opacity = active ? 0.55 * bu.puffT * (1 - ph * 0.4) : 0.12;
          p.position.set(Math.sin((p.userData.seed + t) * 1.3) * 0.5, 0.6 + ph * 1.1, -0.4 - ph * 0.7);
          p.scale.setScalar(0.7 + ph * 0.9);
          p.quaternion.copy(camera.quaternion);
        }
      }
      // flight lift (deterministic lerp; shadow stays grounded)
      const by = boss.position.y + (flyTarget - boss.position.y) * Math.min(1, dt * 1.6);
      boss.position.y = Math.abs(by - flyTarget) < 0.02 ? flyTarget : by;
      // aura pulse (enrage flares harder)
      if (bossAura) {
        const s = (enraged ? 1.3 : 1.05) + Math.sin(t * (enraged ? 9 : 3)) * (enraged ? 0.16 : 0.06) * k;
        bossAura.scale.set(s, s, 1);
      }
      // painted ring breathes (frozen under reduced-motion)
      ringInner.material.opacity = 0.47 + Math.sin(t * 2) * 0.1 * k;
      // hero bob
      hero.position.y = Math.abs(Math.sin(t * 2.2)) * 0.06 * k;
    }
    // telegraph windup pulse
    for (const h of telegraphs) {
      h.t += dt;
      const s = h.t < WINDUP_SCALE_T
        ? 0.55 + (h.t / WINDUP_SCALE_T) * 0.45
        : 1 + Math.sin(h.t * 14) * 0.03 * k;
      h.group.scale.setScalar(s);
      h.badge.position.y = 1.6 + Math.sin((h.t + 1) * 5) * 0.12 * k;
    }
    // bursts
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      b.life -= dt;
      if (b.life <= 0) { scene.remove(b.mesh); b.mesh.geometry.dispose(); b.mesh.material.dispose(); bursts.splice(i, 1); continue; }
      b.vy -= 12 * dt;
      b.mesh.position.x += b.vx * dt;
      b.mesh.position.y = Math.max(0.1, b.mesh.position.y + b.vy * dt);
      b.mesh.position.z += b.vz * dt;
      b.mesh.rotation.x += dt * 6;
      b.mesh.rotation.y += dt * 5;
    }
    // dust: rise, spread, fade (billboarded, shared geo)
    for (let i = dusts.length - 1; i >= 0; i--) {
      const d = dusts[i];
      d.life -= dt;
      if (d.life <= 0) { scene.remove(d.mesh); d.mesh.material.dispose(); dusts.splice(i, 1); continue; }
      d.mesh.position.x += d.vx * dt;
      d.mesh.position.y += d.vy * dt;
      d.mesh.position.z += d.vz * dt;
      d.mesh.scale.addScalar(d.grow * dt);
      d.mesh.material.opacity = 0.55 * Math.max(0, d.life / d.max);
      d.mesh.quaternion.copy(camera.quaternion);
    }
    // camera shake (off under reduced-motion)
    if (shakeT > 0 && !reducedMotion) {
      shakeT -= dt;
      const a = shakeAmp * Math.max(0, shakeT / 0.3);
      camera.position.set(
        CAM_BASE.x + (Math.random() - 0.5) * a,
        CAM_BASE.y + (Math.random() - 0.5) * a * 0.6,
        CAM_BASE.z + (Math.random() - 0.5) * a
      );
      camera.lookAt(CAM_LOOK);
      if (shakeT <= 0) { shakeAmp = 0; camera.position.copy(CAM_BASE); camera.lookAt(CAM_LOOK); }
    }
    // decoy bob
    if (k) for (const d of decoys) d.position.y = Math.abs(Math.sin(t * 3 + d.position.x)) * 0.08;
    renderer.render(scene, camera);
    clockV.set(0, 0, 0);
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
