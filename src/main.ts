// Nixie Clock for the BUSY Bar.
//
// The tubes are pre-rendered: tools/bake.mjs renders the Nixie Clock app's glow, flicker and
// warm-up into .anim files, and the firmware plays them itself. JavaScript only picks which
// section each tube plays, once a second:
//
// - an unchanged tube plays a 2 s loop on its own (p<d> starts at x.5 s of an even second,
//   q<d> of an odd one), so it is never restarted;
// - a tube whose digit changes at the next second gets a change section c<a|b><was><now>
//   that starts half a second before the change and covers the cool-down and warm-up, then
//   the firmware chains the matching loop behind it (await_previous_end);
// - the seconds tube plays a 10 s loop t<d> and is put back on time every 10 s;
// - in Live, a tube now and then plays px/qx, its loop with a dip at the very start.

import manifest from "./appmeta/manifest.json";

const APP = manifest.id;
const API = "http://localhost/api";

const LEVELS = ["steady", "calm", "live"] as const;
const COLOURS = ["orange", "white"] as const;
const COLON_MODES = ["on", "blink", "pulse"] as const;
type ColonMode = (typeof COLON_MODES)[number];

/** x of each tube and colon strip, by tube count. */
const LAYOUT = {
  4: { xs: [10, 22, 38, 50], colons: [35] },
  6: { xs: [0, 10, 25, 35, 50, 60], colons: [22, 47] },
} as const;
const ALL_IDS = ["tube0", "tube1", "tube2", "tube3", "tube4", "tube5", "colon0", "colon1"];

/** ms into each second when the next second's sections are sent; a draw takes effect ~60 ms
 * later, at the half second the sections start on (measured on firmware 1.4.1). */
const TICK = 400;
/** Live: chance per tube per second of a dip, about three a minute. */
const DIP_P = 3 / 60;
/** s between reads of the settings and the time zone. */
const POLL_EVERY = 10;

/** First run: HINT_AFTER ms after the start the clock gives way to an arrow that draws itself up
 * to the wheel and the word "TRY" (animations/ui/hint.anim), for HINT_FOR ms or until the wheel
 * turns. Shown on every start until the wheel has been turned once. */
const HINT_AFTER = 3000, HINT_FOR = 10000;
const HINT_ID = "hint";
const TRIED_KEY = "wheel_tried";

/** While the wheel turns, a gauge on the bottom row slides to the new flicker level, holds and
 * fades (animations/ui/gauge.anim, sections <colour>_<from><to>, then "off"). */
const GAUGE_ID = "gauge";

/** Animation files: animations/<colour>-<level>-<count>/tube<i>.anim and colons.anim. */
const FILES = import.meta.glob<string>("./animations/*/*.anim", { eager: true, query: "?url", import: "default" });
const file = (set: string, name: string): string => {
  const url = FILES[`./animations/${set}/${name}.anim`];
  if (!url) throw new Error("missing animation " + set + "/" + name);
  return url;
};

// ---- settings -------------------------------------------------------------------------------

interface Settings {
  level: number;
  colour: number;
  seconds: boolean;
  hour12: boolean;
  colons: ColonMode;
}

/** The wheel and OK override level and colour until the settings themselves are edited. */
interface Override {
  level: number;
  colour: number;
  /** the settings' level and colour when the override was made */
  seenLevel: number;
  seenColour: number;
}

const STORE_KEY = "override";

function fromSettings(v: Record<string, unknown>): Settings {
  const level = LEVELS.indexOf(v.flicker as (typeof LEVELS)[number]);
  const colour = COLOURS.indexOf(v.colour as (typeof COLOURS)[number]);
  const colons = COLON_MODES.indexOf(v.colons as ColonMode);
  return {
    level: level < 0 ? 1 : level,
    colour: colour < 0 ? 0 : colour,
    seconds: v.show_seconds === true,
    hour12: v.time === "12h",
    colons: colons < 0 ? "blink" : COLON_MODES[colons],
  };
}

async function readSettings(): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${API}/apps/settings?app_id=${encodeURIComponent(APP)}`);
    if (r.ok) return ((await r.json()) as { values?: Record<string, unknown> }).values ?? null;
  } catch (e) {}
  return null;
}

// ---- time -----------------------------------------------------------------------------------

/** The runtime fixes Date's time zone when the app starts, so a zone change or a DST switch
 * would go unseen until a restart; the bar's zone is read with the settings instead. */
let zoneS = -new Date().getTimezoneOffset() * 60;

/** Returns true when the zone changed. */
async function readZone(): Promise<boolean> {
  try {
    const r = await fetch(`${API}/time/timezone`);
    const m = r.ok ? /^([+-])(\d\d):(\d\d)$/.exec(((await r.json()) as { offset?: string }).offset ?? "") : null;
    if (m) {
      const z = (m[1] === "-" ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60);
      if (z !== zoneS) {
        zoneS = z;
        return true;
      }
    }
  } catch (e) {}
  return false;
}

/** Local time in whole seconds. */
const localS = (now: number): number => Math.floor(now / 1000) + zoneS;

/** What each tube shows at local second s, as section names use it: a digit, or "n" for the dark
 * first tube of 12-hour time below 10 o'clock. */
function digits(s: number, hour12: boolean): string[] {
  const day = ((s % 86400) + 86400) % 86400;
  let h = Math.floor(day / 3600);
  if (hour12) h = h % 12 || 12;
  const m = Math.floor((day % 3600) / 60), x = day % 60;
  const tens = hour12 && h < 10 ? "n" : String(Math.floor(h / 10));
  return [tens, ...[h % 10, Math.floor(m / 10), m % 10, Math.floor(x / 10), x % 10].map(String)];
}

/** The 2 s loop whose first frame belongs at S + 0.5 s. */
const half = (S: number): "p" | "q" => (S % 2 ? "q" : "p");

// ---- display --------------------------------------------------------------------------------

interface AnimElement {
  id: string;
  type: "animation";
  path: string;
  section: string;
  loop: true;
  await_previous_end?: boolean;
  x: number;
  y: number;
  align: "top_left";
}
type Element = AnimElement;

async function request(method: "POST" | "DELETE", body: object): Promise<void> {
  const r = await fetch(`${API}/display/draw`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} display/draw: HTTP ${r.status}`);
}
const draw = (elements: Element[]) => request("POST", { application_name: APP, priority: 50, elements });
const clear = (ids?: string[]) => request("DELETE", ids ? { application_name: APP, element_ids: ids } : { application_name: APP });

declare const busy: { display?: { clear?: (display: string) => void } } | undefined;

/** Some firmware keeps its "Loading..." screen under the app's elements until the app shows
 * text of its own; clearing the text hides it. */
function hideLoading(): void {
  try {
    if (typeof busy !== "undefined") busy?.display?.clear?.("both");
  } catch (e) {}
}

// ---- the clock ------------------------------------------------------------------------------

type Op = { draw: Element[] } | { clear: string[] } | { poll: true };

function main(): void {
  hideLoading();

  const st: Settings = { level: 1, colour: 0, seconds: false, hour12: false, colons: "blink" };
  let seen = { level: 1, colour: 0 };
  let override: Override | null = null;
  try {
    override = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as Override | null;
  } catch (e) {}

  /** Returns true when anything on screen changes. */
  const applySettings = (v: Record<string, unknown>): boolean => {
    const s = fromSettings(v);
    const before = JSON.stringify(st);
    st.seconds = s.seconds;
    st.hour12 = s.hour12;
    st.colons = s.colons;
    if (override && override.seenLevel === s.level && override.seenColour === s.colour) {
      st.level = override.level;
      st.colour = override.colour;
    } else {
      override = null;
      st.level = s.level;
      st.colour = s.colour;
    }
    seen = { level: s.level, colour: s.colour };
    return JSON.stringify(st) !== before;
  };

  let stopped = false, full = true, lastT = 0, lastColons = 0, lastPoll = 0;

  let tried = false;
  try { tried = localStorage.getItem(TRIED_KEY) === "1"; } catch (e) {}
  let hint: "waiting" | "shown" | "ending" | "done" = tried ? "done" : "waiting";
  let hintAt = Date.now() + HINT_AFTER;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // One request at a time, in order: the firmware handles them one by one anyway.
  const queue: Op[] = [];
  const shown = new Set<string>(); // a clear naming an id that is not on screen fails as a whole
  let inFlight = false;
  const flush = (): void => {
    if (inFlight || stopped) return;
    const op = queue.shift();
    if (!op) return;
    inFlight = true;
    let job: Promise<unknown>;
    if ("draw" in op) {
      for (const e of op.draw) shown.add(e.id);
      job = draw(op.draw);
    } else if ("clear" in op) {
      const ids = op.clear.filter((id) => shown.has(id));
      for (const id of ids) shown.delete(id);
      job = ids.length ? clear(ids) : Promise.resolve();
    } else {
      job = readSettings()
        .then((v) => { if (v && applySettings(v)) full = true; })
        .then(readZone)
        .then((changed) => { if (changed) full = true; });
    }
    job.catch(() => {}).then(() => {
      inFlight = false;
      flush();
    });
  };

  const setName = () => `${COLOURS[st.colour]}-${LEVELS[st.level]}-${st.seconds ? 6 : 4}`;
  const tube = (i: number, section: string, after = false): AnimElement => ({
    id: "tube" + i, type: "animation", path: file(setName(), "tube" + i), section, loop: true,
    await_previous_end: after, x: LAYOUT[st.seconds ? 6 : 4].xs[i], y: 0, align: "top_left",
  });
  const colon = (c: number, S: number): AnimElement => ({
    id: "colon" + c, type: "animation", path: file(setName(), "colons"),
    // with seconds the two colons blink in turn, on odd and even seconds
    section: half(S) + "_" + (st.seconds ? "on" + (2 * c + 1) : st.colons + "1"),
    loop: true, x: LAYOUT[st.seconds ? 6 : 4].colons[c], y: 0, align: "top_left",
  });

  /** The hint's arrow: _in draws it once, _hold loops behind it. */
  const hintEl = (part: "in" | "hold"): AnimElement => ({
    id: HINT_ID, type: "animation", path: file("ui", "hint"), section: COLOURS[st.colour] + "_" + part, loop: true,
    await_previous_end: part === "hold", x: 0, y: 0, align: "top_left",
  });
  const gaugeEl = (section: string, after: boolean): AnimElement => ({
    id: GAUGE_ID, type: "animation", path: file("ui", "gauge"), section, loop: true,
    await_previous_end: after, x: 0, y: 15, align: "top_left",
  });
  /** Ahead of everything else queued, replacing a gauge still waiting there. */
  const showGauge = (from: number, to: number): void => {
    for (let i = queue.length - 1; i >= 0; i--) {
      const op = queue[i];
      if ("draw" in op && op.draw[0]?.id === GAUGE_ID) queue.splice(i, 1);
    }
    queue.unshift({ draw: [gaugeEl(`${COLOURS[st.colour]}_${from}${to}`, false)] }, { draw: [gaugeEl("off", true)] });
    flush();
  };

  /** The next tick puts the whole clock back and only then takes the hint away. */
  const endHint = (): void => {
    if (hint === "shown") { hint = "ending"; full = true; }
    else if (hint === "waiting") hint = "done";
  };

  /** A tube to put back on its plain loop once a change or a dip is over. */
  const pending = new Map<number, { section: string; at: number }>();

  /** Runs at S + TICK ms and sets up what plays from S + 0.5 s. */
  const tick = (S: number): void => {
    if (hint === "shown" && Date.now() >= hintAt) endHint();
    const count = st.seconds ? 6 : 4, loops = count - (st.seconds ? 1 : 0);
    const els = new Map<number | string, AnimElement>();
    const d = digits(S, st.hour12), next = digits(S + 1, st.hour12);
    const wasFull = full;
    if (full) {
      full = false;
      pending.clear();
      for (let i = 0; i < loops; i++) els.set(i, tube(i, half(S) + d[i]));
      if (st.seconds) { els.set(5, tube(5, "t" + d[5])); lastT = S; }
      els.set("c0", colon(0, S));
      if (st.seconds) els.set("c1", colon(1, S));
      lastColons = S;
    } else {
      for (const [i, p] of pending) if (p.at <= S) { els.set(i, tube(i, p.section, true)); pending.delete(i); }
      if (st.seconds && S - lastT >= 10) { els.set(5, tube(5, "t" + d[5])); lastT = S; }
      // the colons' blink is a 2 s loop too; put it back on the second now and then
      if (S - lastColons >= 60) {
        els.set("c0", colon(0, S));
        if (st.seconds) els.set("c1", colon(1, S));
        lastColons = S;
      }
      if (LEVELS[st.level] === "live") {
        const later = digits(S + 3, st.hour12);
        for (let i = 0; i < loops; i++) {
          if (pending.has(i) || els.has(i)) continue;
          if (next[i] !== d[i] || later[i] !== d[i] || Math.random() >= DIP_P) continue;
          // the dip is at the very start of its section, so it also hides the restart
          els.set(i, tube(i, half(S) + "x" + d[i]));
          pending.set(i, { section: half(S) + d[i], at: S + 1 });
        }
      }
    }
    // tubes that change at B = S + 1: the change section starts at B - 0.5 s
    const B = S + 1;
    for (let i = 0; i < loops; i++) {
      if (next[i] === d[i]) continue;
      els.set(i, tube(i, "c" + (B % 2 ? "b" : "a") + d[i] + next[i]));
      pending.set(i, { section: (B % 2 ? "p" : "q") + next[i], at: B });
    }
    let list: Element[] = [0, 1, 2, 3, 4, 5, "c0", "c1"].flatMap((k) => els.get(k) ?? []);
    const now = Date.now();
    if (hint === "waiting" && now >= hintAt) {
      hint = "shown";
      hintAt = now + HINT_FOR;
      queue.push({ clear: ALL_IDS }, { draw: [hintEl("in")] }, { draw: [hintEl("hold")] });
      list = [];
    } else if (hint === "shown") {
      // the clock keeps counting underneath; a new colour restarts the hint's loop in it
      list = wasFull ? [{ ...hintEl("hold"), await_previous_end: false }] : [];
    }
    if (list.length) queue.push({ draw: list });
    if (hint === "ending") { hint = "done"; queue.push({ clear: [HINT_ID] }); }
    // A full redraw replaces every element in place and only then removes the ones the new
    // layout lacks: the screen is never empty, so no firmware "Loading..." shows through.
    if (wasFull) queue.push({ clear: ALL_IDS.filter((id) => !list.some((e) => e.id === id)) });
    // polls go last, into the quiet part of the second
    if (S - lastPoll >= POLL_EVERY) { lastPoll = S; queue.push({ poll: true }); }
    flush();
  };

  const schedule = (): void => {
    if (stopped) return;
    let wait = (1000 + TICK - (Date.now() % 1000)) % 1000;
    if (wait < 30) wait += 1000;
    timer = setTimeout(() => {
      if (stopped) return;
      tick(localS(Date.now()));
      schedule();
    }, wait);
  };

  // localStorage rewrites the app's whole store on flash: save once the wheel has settled
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = (): void => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(override)); } catch (e) {}
  };
  const remember = (): void => {
    override = { level: st.level, colour: st.colour, seenLevel: seen.level, seenColour: seen.colour };
    full = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 3000);
  };

  const unbind = listen("input", (ev) => {
    if (stopped) return;
    if (ev.key === "encoder") {
      const from = st.level;
      st.level = Math.max(0, Math.min(LEVELS.length - 1, st.level + ev.delta));
      showGauge(from, st.level); // also at either end, to show it is there
      remember();
      if (!tried) {
        tried = true;
        try { localStorage.setItem(TRIED_KEY, "1"); } catch (e) {}
        endHint();
      }
    } else if (ev.key === "ok" && ev.action === "short") {
      st.colour = (st.colour + 1) % COLOURS.length;
      remember();
    } else if (ev.key === "back" && ev.action === "short") {
      stopped = true;
      clearTimeout(timer);
      if (saveTimer !== undefined) save();
      // elements outlive the app and keep their files open unless they are cleared
      clear().catch(() => {}).then(() => unbind());
    }
  });

  readZone()
    .then(readSettings)
    .then((v) => {
      applySettings(v ?? {});
      lastPoll = localS(Date.now());
      schedule();
    });
}

main();
