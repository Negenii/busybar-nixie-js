// bake.mjs <outdir> <colour 0 orange|4 white> <level steady|calm|live> <count 4|6>: one set of tubes, 11x15
// Colons go to k.raw (2 px wide): p_/q_ + on1/on3/blink1/pulse1, 2 s loops starting at phase 500/1500.
// Slots 0..4: steady 2 s loops p<d>/q<d> (start phase 500/1500 ms), dipped px<d>/qx<d> for live,
//   change sections c<half><was><cur> covering [B-500, B+1500) around boundary B; after one ends
//   the firmware chains into q (B even) or p (B odd).
// Slot 5: t<d>, a 10 s loop starting 550 ms after digit d lights (seamless, plays on its own).
import fs from 'node:fs';
import { envelope, heatK, coolK, ONE, render, renderTube, presetMake, presetSetDepth, presetSetGlow, setLoop2s, digitAt, forceSputter, setHour12, BLANK, LAYOUT, FRAME_BYTES, W } from './render.js';
const [outdir, colourS, level, countS] = process.argv.slice(2);
const COUNT = +countS;
const colour = +colourS;
setLoop2s();
const p = presetMake(colour);
presetSetDepth(p, level === 'live' ? 32 : level === 'calm' ? 24 : 1);
presetSetGlow(p, 0);
p.glass = [0, 0, 0]; p.stack = [0, 0, 0]; p.knight = [0, 0, 0];
if (level === 'steady') { p.ripple = [0, 0, 0]; p.core_field = 0; p.glow_field = 0; }
const sputterTo = p.sputter_to;
p.sputter_per_min = 0;
const FLOOR = 8, N2 = 47, S2 = 2000 / N2, N10 = 238, S10 = 10000 / N10, BASE = 4000000; // BASE even, multiple of 10
const fb = new Uint8Array(FRAME_BYTES);
fs.mkdirSync(outdir, { recursive: true });
const xs = LAYOUT[COUNT].xs;

// rows kept: the tubes never light the bottom two, and the last row is the gauge's
const AH = 15;
function crop(x0) {
  const c = Buffer.alloc(11 * AH * 3); let o = 0;
  for (let y = 0; y < AH; y++) for (let x = x0; x < x0 + 11; x++) { const q = (y * W + x) * 3; for (let n = 0; n < 3; n++) { const v = fb[q + n]; c[o++] = v < FLOOR ? 0 : v; } }
  return c;
}
const frameAt = (i, t) => { render(fb, Math.floor(t / 1000), ((t % 1000) + 1000) % 1000, p, COUNT === 6, i); return crop(xs[i]); };

const index = {};
for (let i = 0; i < COUNT; i++) {
  const frames = [], sections = [];
  const add = (name, n, f) => { const start = frames.length; for (let k = 0; k < n; k++) frames.push(f(k)); sections.push({ name, start, end: frames.length - 1 }); };
  if (COUNT === 6 && i === 5) {
    for (let d = 0; d < 10; d++) { const t0 = (BASE + d) * 1000 + 550; add('t' + d, N10, (k) => frameAt(i, t0 + Math.round(k * S10))); }
  } else {
    // every digit and every change the tube makes over two days, in 24- and then 12-hour time;
    // a dark tube is named n
    const name = (d) => (d === BLANK ? 'n' : String(d));
    const digits = new Set(), changes = new Map();
    for (const hour12 of [false, true]) {
      setHour12(hour12);
      for (let s = BASE; s < BASE + 2 * 86400; s++) {
        const was = digitAt(i, s - 1), cur = digitAt(i, s);
        digits.add(cur);
        if (was !== cur) { const k = 'c' + (s % 2 ? 'b' : 'a') + name(was) + name(cur); if (!changes.has(k)) changes.set(k, { s, hour12 }); }
      }
    }
    setHour12(false);
    for (const d of [...digits].sort((a, b) => a - b)) {
      for (const [ph, off] of [['p', 500], ['q', 1500]]) {
        const t0 = BASE * 1000 + off;
        const steady = (k) => { const t = t0 + Math.round(k * S2); renderTube(fb, i, xs[i], d, t, p); return crop(xs[i]); };
        add(ph + name(d), N2, steady);
        if (level === 'live') {
          p.sputter_to = sputterTo; forceSputter(t0 + 40, t0 + 130);
          add(ph + 'x' + name(d), N2, steady);
          forceSputter(0, 0);
        }
      }
    }
    for (const [k, { s, hour12 }] of changes) {
      setHour12(hour12);
      const t0 = s * 1000 - 500;
      add(k, N2, (f) => frameAt(i, t0 + Math.round(f * S2)));
    }
    setHour12(false);
  }
  fs.writeFileSync(`${outdir}/s${i}.raw`, Buffer.concat(frames));
  fs.writeFileSync(`${outdir}/s${i}.sections.json`, JSON.stringify(sections));
  index[i] = sections.length;
}
// colons: 2x16, the C dots (2x2 at y 4 and 9), breathing with tube 1 or 3, times the blink shape
{
  const frames = [], sections = [];
  const shape = {
    on: () => ONE,
    // lights like a cathode in 250 ms, burns to the odd second, then cools like one
    blink: (ms) => (ms < 1000 ? Math.round(((heatK(Math.round((ms * 650) / 250)) - 150) * ONE) / (ONE - 150)) : coolK(ms - 1000)),
    pulse: (ms) => Math.round(ONE * (0.5 + 0.5 * Math.cos((2 * Math.PI * (ms - 500)) / 2000))),
  };
  const kinds = [['on', 1], ['on', 3], ['blink', 1], ['pulse', 1]];
  for (const [ph, off] of [['p', 500], ['q', 1500]]) for (const [kind, idx] of kinds) {
    const start = frames.length;
    for (let k = 0; k < N2; k++) {
      const t = BASE * 1000 + off + Math.round(k * S2), ms = (off + Math.round(k * S2)) % 2000;
      const kk = Math.max(0, Math.min(ONE, shape[kind](ms)));
      const env = envelope(p, idx, t);
      const c = Buffer.alloc(2 * AH * 3);
      for (const cy of [4, 9]) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) for (let n = 0; n < 3; n++) {
        let v = Math.floor((Math.floor((p.colon[n] * env) / ONE) * kk) / ONE); if (v > 255) v = 255; if (v < FLOOR) v = 0;
        c[((cy + dy) * 2 + dx) * 3 + n] = v;
      }
      frames.push(c);
    }
    sections.push({ name: ph + '_' + kind + idx, start, end: frames.length - 1 });
  }
  // busy-cli's Vite inlines assets under 4 KB as data: URLs the firmware cannot open; noise keeps this one a file
  { const start = frames.length; let seed = 7; for (let k = 0; k < 24; k++) { const c = Buffer.alloc(2 * AH * 3); for (let n = 0; n < c.length; n++) { seed = (seed * 1103515245 + 12345) >>> 0; c[n] = seed >>> 24; } frames.push(c); } sections.push({ name: 'pad', start, end: frames.length - 1 }); }
  fs.writeFileSync(`${outdir}/k.raw`, Buffer.concat(frames));
  fs.writeFileSync(`${outdir}/k.sections.json`, JSON.stringify(sections));
}
console.log(outdir, JSON.stringify(index));
