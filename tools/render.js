// The renderer of the native Nixie clock (busybar-nixie/app/nixie_render.c), ported line by line:
// integer maths, C truncating division where the operands can go negative.

export const W = 72;
export const H = 16;
export const FRAME_BYTES = W * H * 3;

const ONE = 1024;
const TUBE_W = 11;
const GLYPH_W = 7;
const GLYPH_H = 11;
const GLYPH_Y = 2;
const WINDOW_MS = 1000000;
const PRE_MS = 300;
const HEAT_MS = 650;
const COOL_MS = 600;
const WAVE_MS = 50;
const EMBER = 150;
const SPUTTER_MS = 90;

// round(1024*sin(2*pi*i/256)), copied from sine_table.inc
const SIN = [0,25,50,75,100,125,150,175,200,224,249,273,297,321,345,369,392,415,438,460,483,505,526,548,569,590,610,630,650,669,688,706,724,742,759,775,792,807,822,837,851,865,878,891,903,915,926,936,946,955,964,972,980,987,993,999,1004,1009,1013,1016,1019,1021,1023,1024,1024,1024,1023,1021,1019,1016,1013,1009,1004,999,993,987,980,972,964,955,946,936,926,915,903,891,878,865,851,837,822,807,792,775,759,742,724,706,688,669,650,630,610,590,569,548,526,505,483,460,438,415,392,369,345,321,297,273,249,224,200,175,150,125,100,75,50,25,0,-25,-50,-75,-100,-125,-150,-175,-200,-224,-249,-273,-297,-321,-345,-369,-392,-415,-438,-460,-483,-505,-526,-548,-569,-590,-610,-630,-650,-669,-688,-706,-724,-742,-759,-775,-792,-807,-822,-837,-851,-865,-878,-891,-903,-915,-926,-936,-946,-955,-964,-972,-980,-987,-993,-999,-1004,-1009,-1013,-1016,-1019,-1021,-1023,-1024,-1024,-1024,-1023,-1021,-1019,-1016,-1013,-1009,-1004,-999,-993,-987,-980,-972,-964,-955,-946,-936,-926,-915,-903,-891,-878,-865,-851,-837,-822,-807,-792,-775,-759,-742,-724,-706,-688,-669,-650,-630,-610,-590,-569,-548,-526,-505,-483,-460,-438,-415,-392,-369,-345,-321,-297,-273,-249,-224,-200,-175,-150,-125,-100,-75,-50,-25];

const td = (a, b) => (a / b) | 0; // C int32 division
const mod = (a, m) => {
  const r = a % m;
  return r < 0 ? r + m : r;
};
const sinAt = (p) => SIN[mod(p, 256)];

const XS4_ = [10, 22, 38, 50];
const XS6_ = [0, 10, 25, 35, 50, 60];
let forceSputterFrom = 0, forceSputterTo = 0;
/** Force a dip over [from, to) absolute ms, for baking sputter variants. */
export function forceSputter(from, to) { forceSputterFrom = from; forceSputterTo = to; }
let RIPPLE_MHZ = [3000, 5600, 9400];
let CRAWL_MHZ = [1100, 1600];
/** Retune so the whole look repeats every 2 s (all frequencies multiples of 0.5 Hz). */
export const LAYOUT = { 4: { xs: XS4_, colons: [35] }, 6: { xs: XS6_, colons: [22, 47] } };
export function setLoop2s() { RIPPLE_MHZ = [3000, 5500, 9500]; CRAWL_MHZ = [1000, 1500]; }

const COLOURS = [
  // core_top, core_bot, halo, corner, far, knight, glass, stack, colon
  [[255, 130, 38], [255, 89, 26], [128, 14, 0], [38, 4, 0], [0, 0, 0], [2, 0, 0], [1, 0, 0], [1, 0, 0], [106, 12, 0]],
  [[90, 200, 255], [30, 120, 255], [4, 26, 128], [0, 8, 38], [0, 0, 0], [0, 0, 3], [0, 0, 3], [0, 1, 6], [4, 24, 106]],
  [[120, 255, 160], [30, 255, 70], [6, 128, 22], [0, 38, 6], [0, 0, 0], [0, 2, 0], [0, 1, 0], [0, 2, 0], [6, 106, 18]],
  [[255, 50, 24], [255, 14, 8], [128, 5, 0], [38, 2, 0], [0, 0, 0], [2, 0, 0], [1, 0, 0], [1, 0, 0], [106, 4, 0]],
  // 4: white, slightly warm; cools through red like a filament (red is the dominant channel)
  [[255, 236, 212], [230, 214, 196], [96, 84, 72], [28, 24, 20], [0, 0, 0], [2, 2, 2], [1, 1, 1], [1, 1, 1], [92, 84, 76]],
];

export function presetMake(colour) {
  const c = COLOURS[colour] || COLOURS[0];
  return {
    core_top: c[0].slice(), core_bot: c[1].slice(), halo: c[2].slice(), corner: c[3].slice(),
    far: c[4].slice(), knight: c[5].slice(), glass: c[6].slice(), stack: c[7].slice(), colon: c[8].slice(),
    ripple: [185, 115, 70], core_field: 200, glow_field: 200, sputter_to: 1004, sputter_per_min: 0,
  };
}

export function presetSetDepth(p, depth) {
  if (depth < 1) depth = 1;
  if (depth > 64) depth = 64;
  const d = depth - 1;
  const m = 1 + td(d * d * 63, 3969);
  for (let i = 0; i < 3; i++) p.ripple[i] *= m;
  p.core_field = Math.min(p.core_field * m, 7800);
  p.glow_field = Math.min(p.glow_field * m, 7800);
  if (depth >= 16) {
    p.sputter_per_min = 1 + td(depth - 16, 4);
    p.sputter_to = ONE - 205 - td((depth - 16) * 595, 48);
  } else {
    p.sputter_per_min = 0;
  }
}

const ring = (from, pct) => [0, 1, 2].map((n) => td(from[n] * pct + 50, 100));

export function presetSetGlow(p, glow) {
  const halo = p.halo.slice();
  if (glow === 1) {
    p.corner = ring(halo, 55); p.far = ring(halo, 25); p.knight = ring(halo, 12);
  } else if (glow === 2) {
    p.halo = ring(p.core_top, 50); p.corner = ring(p.core_top, 15); p.far = [0, 0, 0]; p.knight = [0, 0, 0];
  } else if (glow === 3) {
    p.halo = ring(p.core_top, 45); p.corner = ring(p.core_top, 22); p.far = ring(p.core_top, 10); p.knight = ring(p.core_top, 5);
  } else if (glow === 4) {
    p.halo = ring(halo, 70); p.corner = ring(halo, 15); p.far = [0, 0, 0]; p.knight = [0, 0, 0];
  }
}

function hash32(a) {
  let x = a >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

const phaseOf = (t, mhz) => Math.floor((mod(t, WINDOW_MS) * mhz * 256) / 1000000);

function sputtering(p, i, t) {
  if (p.sputter_per_min <= 0) return false;
  const slot = Math.floor(mod(t, WINDOW_MS) / 1000);
  const h = hash32(slot * 977 + i * 61);
  if (h % 60 >= p.sputter_per_min) return false;
  const start = slot * 1000 + ((h >>> 8) % (1000 - SPUTTER_MS));
  const w = mod(t, WINDOW_MS);
  return w >= start && w < start + SPUTTER_MS;
}

function envelope(p, i, t) {
  let k = ONE;
  for (let n = 0; n < 3; n++) {
    const ph = phaseOf(t, RIPPLE_MHZ[n]) + i * (31 + n * 17);
    k += td(p.ripple[n] * sinAt(ph), 40000);
  }
  if (sputtering(p, i, t) || (t >= forceSputterFrom && t < forceSputterTo)) k = td(k * p.sputter_to, ONE);
  if (k < ONE / 16) k = ONE / 16;
  if (k > 2 * ONE) k = 2 * ONE;
  return k;
}

// per-frame phases of the crawl, computed once per frame instead of per pixel
let crawl1 = 0;
let crawl2 = 0;
function fieldAt(x, y, i) {
  const off = i * 61;
  const p1 = 35 * x + 65 * y - crawl1 + off;
  const p2 = 86 * x - 29 * y + crawl2 + off;
  return td(62 * sinAt(p1) + 38 * sinAt(p2), 100);
}

const DIGITS = [
  [".#####.", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", "#.....#", ".#####."],
  ["...#...", "..##...", ".#.#...", "...#...", "...#...", "...#...", "...#...", "...#...", "...#...", "...#...", ".#####."],
  [".#####.", "#.....#", "......#", "......#", "......#", ".....#.", "....#..", "...#...", "..#....", ".#.....", "#######"],
  [".#####.", "#.....#", "......#", "......#", "..####.", "......#", "......#", "......#", "......#", "#.....#", ".#####."],
  [".....#.", "....##.", "...#.#.", "..#..#.", ".#...#.", "#....#.", "#######", ".....#.", ".....#.", ".....#.", ".....#."],
  ["#######", "#......", "#......", "#......", "######.", "......#", "......#", "......#", "......#", "#.....#", ".#####."],
  ["..####.", ".#.....", "#......", "#......", "#......", "######.", "#.....#", "#.....#", "#.....#", "#.....#", ".#####."],
  ["#######", "#.....#", "......#", ".....#.", ".....#.", "....#..", "....#..", "...#...", "...#...", "..#....", "..#...."],
  [".#####.", "#.....#", "#.....#", "#.....#", "#.....#", ".#####.", "#.....#", "#.....#", "#.....#", "#.....#", ".#####."],
  [".#####.", "#.....#", "#.....#", "#.....#", "#.....#", ".######", "......#", "......#", "......#", ".....#.", ".####.."],
];
// lit cells as flat [c, r, c, r, ...] so the hot loop skips the dots
const LIT = DIGITS.map((rows) => {
  const out = [];
  for (let r = 0; r < GLYPH_H; r++) for (let c = 0; c < GLYPH_W; c++) if (rows[r][c] === "#") out.push(c, r);
  return out;
});

let fb = null;

function lift(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  if (r > fb[o]) fb[o] = r;
  if (g > fb[o + 1]) fb[o + 1] = g;
  if (b > fb[o + 2]) fb[o + 2] = b;
}

const clamp = (s) => (s < 0 ? 0 : s > 255 ? 255 : s);

function dominantOf(p) {
  let d = 0;
  for (let n = 1; n < 3; n++) if (p.core_top[n] > p.core_top[d]) d = n;
  return d;
}

const KDX = [-2, -1, 1, 2];
const KDY = [-1, -2, -2, -1];

function drawGlyph(p, x0, d, k, temp, i) {
  if (k <= td(ONE, 100) || d > 9) return;
  const gx = x0 + td(TUBE_W - GLYPH_W, 2);
  const lit = LIT[d];
  const dom = dominantOf(p);
  const hasFar = (p.far[0] | p.far[1] | p.far[2]) > 0;
  const hasKnight = (p.knight[0] | p.knight[1] | p.knight[2]) > 0;
  for (let j = 0; j < lit.length; j += 2) {
    const c = lit[j];
    const r = lit[j + 1];
    const x = gx + c;
    const y = GLYPH_Y + r;
    const f = fieldAt(x, y, i);
    const coreK = td(k * (ONE + td(p.core_field * f, 40000)), ONE);
    const glowK = td(k * (ONE + td(p.glow_field * f, 40000)), ONE);
    const col = [0, 0, 0];
    for (let n = 0; n < 3; n++) {
      const a = p.core_top[n];
      const b = p.core_bot[n];
      col[n] = (a + td((b - a) * r, GLYPH_H - 1)) & 255;
    }
    if (temp < ONE) {
      for (let n = 0; n < 3; n++) {
        const cold = td(col[n] * (n === dom ? 60 : 12), 100);
        col[n] = (cold + td((col[n] - cold) * temp, ONE)) & 255;
      }
    }
    lift(x, y, clamp(td(col[0] * coreK, ONE)), clamp(td(col[1] * coreK, ONE)), clamp(td(col[2] * coreK, ONE)));
    let hr = clamp(td(p.halo[0] * glowK, ONE)), hg = clamp(td(p.halo[1] * glowK, ONE)), hb = clamp(td(p.halo[2] * glowK, ONE));
    lift(x - 1, y, hr, hg, hb); lift(x + 1, y, hr, hg, hb); lift(x, y - 1, hr, hg, hb); lift(x, y + 1, hr, hg, hb);
    hr = clamp(td(p.corner[0] * glowK, ONE)); hg = clamp(td(p.corner[1] * glowK, ONE)); hb = clamp(td(p.corner[2] * glowK, ONE));
    lift(x - 1, y - 1, hr, hg, hb); lift(x + 1, y - 1, hr, hg, hb); lift(x - 1, y + 1, hr, hg, hb); lift(x + 1, y + 1, hr, hg, hb);
    if (hasFar) {
      hr = clamp(td(p.far[0] * glowK, ONE)); hg = clamp(td(p.far[1] * glowK, ONE)); hb = clamp(td(p.far[2] * glowK, ONE));
      lift(x - 2, y, hr, hg, hb); lift(x + 2, y, hr, hg, hb); lift(x, y - 2, hr, hg, hb); lift(x, y + 2, hr, hg, hb);
    }
    if (hasKnight) {
      hr = clamp(td(p.knight[0] * glowK, ONE)); hg = clamp(td(p.knight[1] * glowK, ONE)); hb = clamp(td(p.knight[2] * glowK, ONE));
      for (let n = 0; n < 4; n++) {
        lift(x + KDX[n], y + KDY[n], hr, hg, hb);
        lift(x - KDX[n], y - KDY[n], hr, hg, hb);
      }
    }
  }
}

function heatK(t) {
  if (t <= 0) return EMBER;
  if (t >= HEAT_MS) return ONE;
  const a = td(t * ONE, HEAT_MS);
  let eased;
  if (a < ONE / 2) eased = td(2 * a * a, ONE);
  else {
    const rest = ONE - a;
    eased = ONE - td(2 * rest * rest, ONE);
  }
  return EMBER + td((ONE - EMBER) * eased, ONE);
}

function coolK(age) {
  if (age >= COOL_MS) return 0;
  const a = td(age * ONE, COOL_MS);
  const rest = ONE - a;
  return td(rest * rest, ONE);
}

function drawTube(p, i, x0, cur, was, next, age, period, wave, t) {
  const env = envelope(p, i, t);
  const cx = x0 + td(TUBE_W, 2);
  let r = clamp(td(p.glass[0] * env, ONE)), g = clamp(td(p.glass[1] * env, ONE)), b = clamp(td(p.glass[2] * env, ONE));
  for (let y = 0; y < H; y++) {
    for (let x = x0; x < x0 + TUBE_W; x++) {
      const a = (x - cx) * 80;
      const bb = (2 * y - 15) * 27;
      if (a * a + bb * bb <= 432 * 432) lift(x, y, r, g, b);
    }
  }
  r = clamp(td(p.stack[0] * env, ONE)); g = clamp(td(p.stack[1] * env, ONE)); b = clamp(td(p.stack[2] * env, ONE));
  for (let y = GLYPH_Y; y < GLYPH_Y + GLYPH_H; y++) for (let x = cx - 3; x <= cx + 3; x++) lift(x, y, r, g, b);

  const eff = age - wave;
  if (was !== cur) {
    if (eff < 0) {
      drawGlyph(p, x0, was, env, ONE, i);
      if (eff >= -PRE_MS) {
        const heat = heatK(eff + PRE_MS);
        drawGlyph(p, x0, cur, td(heat * env, ONE), heat, i);
      }
    } else {
      const cool = coolK(eff);
      if (cool > 0) drawGlyph(p, x0, was, td(cool * env, ONE), cool, i);
      const heat = heatK(eff + PRE_MS);
      drawGlyph(p, x0, cur, td(heat * env, ONE), heat, i);
    }
  } else {
    drawGlyph(p, x0, cur, env, ONE, i);
  }
  if (next !== cur && eff >= period - PRE_MS) {
    const heat = heatK(eff - (period - PRE_MS));
    drawGlyph(p, x0, next, td(heat * env, ONE), heat, i);
  }
}

const XS4 = XS4_;
const COLONS4 = [35];
const XS6 = XS6_;
const COLONS6 = [22, 47];
const PERIOD_S = [36000, 3600, 600, 60, 10, 1];

// 12-hour time: 1..12, and the first tube dark below 10. A dark tube is digit 10, which
// drawGlyph skips, so the old digit still cools down and the new one heats up as usual.
let HOUR12 = false;
export function setHour12(on) { HOUR12 = on; }
export const BLANK = 10;

function digitsOf(localS) {
  const day = mod(localS, 86400);
  let h = Math.floor(day / 3600);
  if (HOUR12) h = h % 12 || 12;
  const m = Math.floor((day % 3600) / 60);
  const s = day % 60;
  return [HOUR12 && h < 10 ? BLANK : Math.floor(h / 10), h % 10, Math.floor(m / 10), m % 10, Math.floor(s / 10), s % 10];
}

/** Draw one frame into out (Uint8Array or Array of FRAME_BYTES). */
export function render(out, localS, ms, p, seconds, only = -1) {
  fb = out;
  for (let n = 0; n < FRAME_BYTES; n++) fb[n] = 0;
  const count = seconds ? 6 : 4;
  const xs = seconds ? XS6 : XS4;
  const colons = seconds ? COLONS6 : COLONS4;
  const t = localS * 1000 + ms;
  const dayMs = mod(localS, 86400) * 1000 + ms;
  crawl1 = phaseOf(t, CRAWL_MHZ[0]);
  crawl2 = phaseOf(t, CRAWL_MHZ[1]);
  const cur = digitsOf(localS);
  const was = digitsOf(localS - 1);
  const next = digitsOf(localS + 1);
  for (let i = 0; i < count; i++) {
    if (only >= 0 && i !== only) continue;
    // in 12-hour time the first tube changes on the hour (12 to 1, 9 to 10), not every ten hours
    const period = (i === 0 && HOUR12 ? 3600 : PERIOD_S[i]) * 1000;
    const age = mod(dayMs, period);
    const n = count - 1 - i;
    const wave = td(WAVE_MS * n * (n + 1), 2);
    drawTube(p, i, xs[i], cur[i], was[i], next[i], age, period, wave, t);
  }
  for (let n = 0; n < colons.length && only < 0; n++) {
    const env = envelope(p, 2 * n + 1, t);
    const r = clamp(td(p.colon[0] * env, ONE)), g = clamp(td(p.colon[1] * env, ONE)), b = clamp(td(p.colon[2] * env, ONE));
    for (let cy = 4; cy <= 9; cy += 5) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) lift(colons[n] + dx, cy + dy, r, g, b);
  }
}

/** One tube alone, steady digit, no transition: for baking loops. */
export function renderTube(out, i, x0, digit, t, p) {
  fb = out;
  for (let n = 0; n < FRAME_BYTES; n++) fb[n] = 0;
  crawl1 = phaseOf(t, CRAWL_MHZ[0]);
  crawl2 = phaseOf(t, CRAWL_MHZ[1]);
  drawTube(p, i, x0, digit, digit, digit, 0, 1000000, 0, t);
}

/** Digit of tube i (0..5 = h h m m s s) at local second s. */
export function digitAt(i, s) {
  return digitsOf(s)[i];
}
/** The section a tube shows during local second s: loop half, previous, current, next digit. */
export function sectionKey(i, s) {
  const d = digitsOf(s - 1)[i] + "" + digitsOf(s)[i] + digitsOf(s + 1)[i];
  return (mod(s, 2) ? "b" : "a") + d;
}
export { envelope, heatK, coolK, ONE, PRE_MS };
