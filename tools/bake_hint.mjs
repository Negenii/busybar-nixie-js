// bake_hint.mjs <outdir>: the first-run hint, 72x16, 25 fps. Writes hint.raw + hint.sections.json.
//
// <colour>_in: a thin arrow draws itself from the middle of the left edge and turns up into the
// top edge under the wheel; the head is drawn, then the tail is wiped from the left until "TRY"
// fits, and the word lights.
// <colour>_hold: the word and what is left of the arrow, the arrow breathing; loops after _in.
//
// Everything is drawn in whole pixels, 1 px wide, like the firmware font the word is set in.
import fs from 'node:fs';
import { presetMake } from './render.js';

const [outdir] = process.argv.slice(2);
const W = 72, H = 16, FLOOR = 8;

/** The wheel sits above the screen around this column (from the device's photo). */
const WHEEL_X = 61;

// level along the middle, a rounded corner, then straight up into the top edge under the wheel
const R = 5, MID = 8.5, TOP = 0.5, CX = WHEEL_X + 0.5 - R, CY = MID - R;
const SEGMENTS = [
  { len: CX - 0.5, at: (d) => [0.5 + d, MID] },
  { len: (Math.PI / 2) * R, at: (d) => [CX + R * Math.sin(d / R), CY + R * Math.cos(d / R)] },
  { len: CY - TOP, at: (d) => [WHEEL_X + 0.5, CY - d] },
];
const LENGTH = SEGMENTS.reduce((s, g) => s + g.len, 0);
const at = (t) => {
  let d = t * LENGTH;
  for (const g of SEGMENTS) { if (d <= g.len) return g.at(d); d -= g.len; }
  return SEGMENTS[SEGMENTS.length - 1].at(SEGMENTS[SEGMENTS.length - 1].len);
};

/** The line as a thin 8-connected run of pixels, in drawing order. */
const path = (() => {
  const px = [];
  for (let i = 0; i <= 4000; i++) {
    const [x, y] = at(i / 4000).map(Math.floor);
    const last = px[px.length - 1];
    if (!last || last[0] !== x || last[1] !== y) px.push([x, y]);
  }
  // drop the inner pixel of every L-shaped step, so the line stays one pixel wide
  for (let i = 1; i < px.length - 1; i++) {
    const [a, c] = [px[i - 1], px[i + 1]];
    if (Math.abs(a[0] - c[0]) <= 1 && Math.abs(a[1] - c[1]) <= 1) { px.splice(i, 1); i--; }
  }
  return px;
})();
// the head: a 2 px chevron on each side of the tip
const HEAD = [[[WHEEL_X - 1, 1], [WHEEL_X + 1, 1]], [[WHEEL_X - 2, 2], [WHEEL_X + 2, 2]]];
// where the wipe stops: the arrow keeps what lies right of x = 34
const KEEP_FROM = path.findIndex(([x]) => x >= 34);

// "TRY" in the firmware's normal font, lifted from the bar's own rendering
const TRY = [
  '#####.####..#...#',
  '..#...#...#.#...#',
  '..#...#...#..#.#.',
  '..#...####...#.#.',
  '..#...#...#...#..',
  '..#...#...#...#..',
  '..#...#...#...#..',
];
const TRY_X = 13, TRY_Y = 5;

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** from/to: the run of path pixels shown; head: 0..2 chevron steps; arrow, word: brightness 0..1 */
function frame(p, { from, to, head, arrow, word }) {
  const k = new Float32Array(W * H);
  const lit = ([x, y], v) => { if (x >= 0 && x < W && y >= 0 && y < H) k[y * W + x] = Math.max(k[y * W + x], v); };
  for (let i = from; i < to; i++) lit(path[i], arrow);
  for (let s = 0; s < head; s++) for (const q of HEAD[s]) lit(q, arrow);
  if (word > 0) TRY.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') lit([TRY_X + x, TRY_Y + y], word); }));
  const c = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) for (let n = 0; n < 3; n++) {
    const v = Math.round(p.core_top[n] * k[i]);
    c[i * 3 + n] = v < FLOOR ? 0 : v;
  }
  return c;
}

const frames = [], sections = [];
const add = (name, list) => { const start = frames.length; frames.push(...list); sections.push({ name, start, end: frames.length - 1 }); };
const N = path.length;
for (const [name, colour] of [['orange', 0], ['white', 4]]) {
  const p = presetMake(colour);
  const intro = [];
  const DRAW = 22, PAUSE = 5, WIPE = 12, LIGHT = 10;
  for (let f = 1; f <= DRAW; f++) intro.push(frame(p, { from: 0, to: Math.round(N * ease(f / DRAW)), head: 0, arrow: 1, word: 0 }));
  for (const head of [1, 2]) intro.push(frame(p, { from: 0, to: N, head, arrow: 1, word: 0 }));
  for (let f = 0; f < PAUSE; f++) intro.push(frame(p, { from: 0, to: N, head: 2, arrow: 1, word: 0 }));
  for (let f = 1; f <= WIPE; f++) intro.push(frame(p, { from: Math.round(KEEP_FROM * ease(f / WIPE)), to: N, head: 2, arrow: 1, word: 0 }));
  for (let f = 1; f <= LIGHT; f++) intro.push(frame(p, { from: KEEP_FROM, to: N, head: 2, arrow: 1, word: ease(f / LIGHT) }));
  add(name + '_in', intro);
  // 1.6 s: the arrow breathes between 70 and 100 %, starting full so it joins _in without a jump
  const HOLD = 40;
  add(name + '_hold', Array.from({ length: HOLD }, (_, f) =>
    frame(p, { from: KEEP_FROM, to: N, head: 2, arrow: 0.85 + 0.15 * Math.cos((2 * Math.PI * f) / HOLD), word: 1 })));
}
fs.mkdirSync(outdir, { recursive: true });
fs.writeFileSync(`${outdir}/hint.raw`, Buffer.concat(frames));
fs.writeFileSync(`${outdir}/hint.sections.json`, JSON.stringify(sections));
console.log(sections.map((s) => `${s.name} ${s.end - s.start + 1}`).join(', '));
