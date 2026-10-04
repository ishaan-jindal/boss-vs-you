// ponytail: procedural rects, swap internals to PNG sheets later, same API
const cache = new Map();
function C() { const c = document.createElement('canvas'); c.width = c.height = 16; return c; }
function R(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x | 0, y | 0, w, h); }

function base(fn) { const c = C(); fn(c.getContext('2d')); return c; }

function drawFloor(g) {
  R(g, 0, 0, 16, 16, '#4a3f55');
  R(g, 0, 0, 8, 8, '#443a4e'); R(g, 8, 8, 8, 8, '#443a4e');
  R(g, 2, 3, 2, 1, '#2a2438'); R(g, 10, 11, 2, 1, '#2a2438'); R(g, 11, 4, 1, 1, '#5a4d68');
}
function drawWall(g) {
  R(g, 0, 0, 16, 16, '#2a2438');
  R(g, 0, 0, 16, 4, '#4a3f55');
  R(g, 0, 7, 16, 1, '#1a1626'); R(g, 0, 12, 16, 1, '#1a1626');
  R(g, 3, 4, 1, 3, '#1a1626'); R(g, 9, 4, 1, 3, '#1a1626'); R(g, 6, 8, 1, 4, '#1a1626');
  R(g, 12, 8, 1, 4, '#1a1626'); R(g, 1, 1, 3, 1, '#5a4d68');
}
function drawRug(g) {
  R(g, 0, 0, 16, 16, '#3a2a4a');
  R(g, 0, 0, 16, 2, '#c9962e'); R(g, 0, 14, 16, 2, '#c9962e');
  R(g, 0, 0, 2, 16, '#c9962e'); R(g, 14, 0, 2, 16, '#c9962e');
  R(g, 6, 6, 4, 4, '#c9962e'); R(g, 7, 7, 2, 2, '#3a2a4a');
}
function drawPillar(g) {
  R(g, 2, 12, 12, 4, '#1a1626');
  R(g, 3, 11, 10, 2, '#4a3f55');
  R(g, 4, 3, 8, 8, '#2a2438');
  R(g, 4, 3, 2, 8, '#4a3f55'); R(g, 6, 3, 1, 8, '#1a1626'); R(g, 10, 3, 1, 8, '#1a1626');
  R(g, 3, 0, 10, 3, '#4a3f55'); R(g, 3, 0, 10, 1, '#5a4d68');
}
function drawBrazier(g, frame) {
  R(g, 6, 4, 4, 3, frame ? '#ff9a2e' : '#e0572b');
  R(g, 7, 2, 2, 3, frame ? '#ffd75e' : '#ff9a2e');
  R(g, 7, 1, 2, 1, '#ffd75e');
  R(g, 5, 7, 6, 2, '#1a1626');
  R(g, 6, 9, 4, 5, '#2a2438'); R(g, 4, 14, 8, 2, '#1a1626');
}
function drawHero(g, frame) {
  const b = frame ? 1 : 0;
  R(g, 5, 2, 6, 4, '#e8b98a');
  R(g, 5, 1, 6, 2, '#6b4d22');
  R(g, 4, 6, 8, 5, '#4da3ff');
  R(g, 4, 6, 8, 1, '#2e6fc4');
  R(g, 5, 11 + b, 2, 4, '#2a2438'); R(g, 9, 11 - b, 2, 4, '#2a2438');
  R(g, 12, 0 - b, 2, 5, '#c0c8d0'); R(g, 12, 5 - b, 3, 2, '#c9962e');
}
function body(g, main, dark, tall) {
  const h = tall ? 12 : 9, y = tall ? 2 : 5;
  R(g, 3, y, 10, h, main);
  R(g, 3, y, 3, h, dark);
  R(g, 5, y + 2, 2, 2, '#ffd75e'); R(g, 9, y + 2, 2, 2, '#ffd75e');
  R(g, 2, y + h - 2, 12, 2, dark);
}
function drawBoss(g, kind, frame) {
  const b = frame ? 1 : 0;
  if (kind === 'crawler') { R(g, 1, 8, 14, 6, '#e8322a'); R(g, 1, 8, 4, 6, '#8f140e'); eyes(g, 9); legs(g, b); }
  else if (kind === 'wraith') { body(g, '#8a6bc9', '#4a2e8a', true); horns(g); if (frame) R(g, 7, 0, 2, 2, '#cbb7ff'); }
  else if (kind === 'colossus') { body(g, '#5a6b5a', '#2e3a2e', true); R(g, 2, 2 + b, 12, 3, '#c9962e'); R(g, 1, 12, 4, 4, '#2e3a2e'); R(g, 11, 12, 4, 4, '#2e3a2e'); }
  else { R(g, 2, 2, 5, 12, '#141126'); R(g, 9 + b, 2, 5, 12, '#1e1a33'); eyes(g, 6); R(g, 7, 4, 2, 10, '#c9962e'); }
}
function eyes(g, y) { R(g, 5, y, 2, 2, '#ff4a1e'); R(g, 9, y, 2, 2, '#ff4a1e'); }
function legs(g, b) { R(g, 3, 14, 3, 2, '#8f140e'); R(g, 10, 14 - b, 3, 2, '#8f140e'); }
function horns(g) { R(g, 2, 0, 3, 3, '#e8e0f0'); R(g, 11, 0, 3, 3, '#e8e0f0'); }
function drawMinion(g, lobber, frame) {
  const b = frame ? 1 : 0;
  R(g, 4, 6 - b, 8, 7, lobber ? '#8a6bc9' : '#e8322a');
  R(g, 4, 6 - b, 2, 7, lobber ? '#4a2e8a' : '#8f140e');
  R(g, 6, 8 - b, 2, 2, '#fff'); R(g, 9, 8 - b, 2, 2, '#fff');
  R(g, 5, 13, 2, 3, '#1a1626'); R(g, 9, 13, 2, 3, '#1a1626');
  if (lobber) R(g, 12, 4 - b, 3, 3, '#ff9a2e'); else { R(g, 2, 4, 2, 3, '#8f140e'); R(g, 12, 4, 2, 3, '#8f140e'); }
}

const DRAW = {
  floor: drawFloor, wall: drawWall, rug: drawRug, pillar: drawPillar,
  brazier_0: (g) => drawBrazier(g, 0), brazier_1: (g) => drawBrazier(g, 1),
  hero_idle_0: (g) => drawHero(g, 0), hero_idle_1: (g) => drawHero(g, 1),
  boss_crawler: (g) => drawBoss(g, 'crawler', 0),
  boss_wraith: (g) => drawBoss(g, 'wraith', 0),
  boss_colossus: (g) => drawBoss(g, 'colossus', 0),
  boss_hollow: (g) => drawBoss(g, 'hollow', 0),
  minion_chaser: (g) => drawMinion(g, false, 0),
  minion_lobber: (g) => drawMinion(g, true, 0),
};

export function getSprite(name, frame = 0) {
  if (!DRAW[name] && DRAW[name + '_' + (Math.abs(frame | 0) % 2)]) name = name + '_' + (Math.abs(frame | 0) % 2);
  if (!DRAW[name]) name = 'boss_crawler';
  if (!cache.has(name)) cache.set(name, base(DRAW[name]));
  return cache.get(name);
}
