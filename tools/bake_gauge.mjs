// bake_gauge.mjs <outdir>: the flicker gauge, 72x1 on the bottom row, 25 fps.
// Writes gauge.raw + gauge.sections.json.
//
// As in the Nixie Clock app: a faint track the whole width, filled from the left in the
// tubes' colour at two thirds. Steady leaves it empty, Calm fills half, Live all of it.
// <colour>_<from><to>: the fill slides from one level to the other, holds, and fades out;
// <colour>_off: dark, for the firmware to chain behind so the gauge does not loop back.
import fs from 'node:fs';
import { presetMake } from './render.js';

const [outdir] = process.argv.slice(2);
const W = 72, FLOOR = 8;
const FILL = [0, 36, 72];
const SLIDE = 8, HOLD = 30, FADE = 10; // frames: 320 ms, 1.2 s, 400 ms
const TRACK = 26 / 256, LIT = 170 / 256;

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

function frame(p, filled, k) {
  const c = Buffer.alloc(W * 3);
  for (let x = 0; x < W; x++) {
    // the fill's leading pixel is shaded by how far into it the edge is, so the slide is smooth
    const cover = Math.max(0, Math.min(1, filled - x));
    const level = (TRACK + (LIT - TRACK) * cover) * k;
    for (let n = 0; n < 3; n++) { const v = Math.round(p.core_top[n] * level); c[x * 3 + n] = v < FLOOR ? 0 : v; }
  }
  return c;
}

const frames = [], sections = [];
const add = (name, list) => { const start = frames.length; frames.push(...list); sections.push({ name, start, end: frames.length - 1 }); };
for (const [name, colour] of [['orange', 0], ['white', 4]]) {
  const p = presetMake(colour);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const list = [];
    for (let f = 1; f <= SLIDE; f++) list.push(frame(p, FILL[a] + (FILL[b] - FILL[a]) * ease(f / SLIDE), 1));
    for (let f = 0; f < HOLD; f++) list.push(frame(p, FILL[b], 1));
    for (let f = 1; f <= FADE; f++) list.push(frame(p, FILL[b], 1 - ease(f / FADE)));
    add(`${name}_${a}${b}`, list);
  }
}
add('off', [Buffer.alloc(W * 3)]);
fs.mkdirSync(outdir, { recursive: true });
fs.writeFileSync(`${outdir}/gauge.raw`, Buffer.concat(frames));
fs.writeFileSync(`${outdir}/gauge.sections.json`, JSON.stringify(sections));
console.log(sections.length, 'sections,', frames.length, 'frames');
