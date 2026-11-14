// The tool wheel: the only way to the tools (in place of the tool column).
//
// With it on, a tap on the model - or on an empty spot - brings the tools up
// in a ring round the pointer: what's picked at the top, then the main groups
// (Sketch, Freeform, Insert, Construct, Transform, Tools, BIM) clockwise, each
// always in the same place. Pointing at a group fans its tools out from that
// side of the ring; a tap on one runs it. A tool with kinds of its own (Plane,
// Colour…) opens them in place of the fan; the group brings its list back.
//
// Its middle is a handle: dragged, the wheel goes where it is put and is kept
// there - it then stays up, showing what the pick offers, instead of coming up
// at the pointer (a tap on the middle folds it to just the handle, two let it
// go back to the pointer). In a sketch it is the sketch's wheel, always kept:
// the drawing tools by what they are for.
//
// It holds exactly what the column and the bottom bar hold - the same
// ToolItems, by the same rule (only what can be used now) - so the keys, the
// search box and the column itself (wheel off) go on working as they did.
// With it on, the bottom bar steps aside with the column, and the right
// column keeps Fit, Screenshot and History: its other lists (snapping, units,
// appearance, shaders, the numpad) are under Settings, in View. While a tool
// with a window of its own is open (Extrude, Fillet, Measure…) the wheel is
// folded to its handle, a cog there: unfolded, it is those Settings.

import { isCoarse, screenClass } from "../device";
import { settings } from "../settings";
import { evaluate, toDisplay, UNIT_LABEL, units } from "../units";
import { numpadInput, openNumpad } from "./numpad";
import { selectAll } from "./textField";
import { iconNameFor, icons, type IconName } from "./icons";
import { el, usable, type PanelItem, type ToolItem, type UI } from "./ui";

/**
 * What it shows: the selection tool's column ("model"), the sketch's, or -
 * the second wheel, always on the screen - the Settings ("settings"), or -
 * the third, up while a tool has a window - the tool's options ("options").
 */
export type WheelLayout = "model" | "sketch" | "freeform" | "settings" | "options";

/** What the tool wheel stands in for now (the Options wheel leaves to it what it shows). */
let toolsLayout: WheelLayout | null = null;

/** More for the model wheel's top sector, beside what the column holds for what's picked (Reveal in Items). */
export type WheelExtras = () => ToolItem[];

/** What a tool sees of the wheel. */
export interface WheelHandle {
  /** Switched on (always, now: the setting is kept on). */
  readonly on: boolean;
  /** Up now: round the pointer, or at the place it is kept. */
  readonly isOpen: boolean;
  /** It has a place of its own on the screen and stays up there (dragged there by its middle; in a sketch or beside a tool, always). */
  readonly kept: boolean;
  /**
   * What it shows from now on: the selection tool's column ("model": what's
   * picked, or the main tools), the sketch's (its tools by what they are
   * for), a freeform shape's (what its card offers, by what it does), or
   * nothing (false: another tool's own column and window show).
   */
  cover(layout: "model" | "sketch" | "freeform" | false, extras?: WheelExtras): void;
  /** Bring it up round a point of the page. (Kept somewhere, it is up already: `summon` unfolds it.) */
  open(x: number, y: number, opts?: WheelOpen): void;
  /** Up at the point, or away again (kept somewhere: folded, or unfolded). */
  toggle(x: number, y: number, opts?: WheelOpen): void;
  close(): void;
  /** Did the press now being handled close an open wheel? (A tap on an empty spot then only closes it.) */
  takeDismissed(): boolean;
}

export interface WheelOpen {
  type?: "mouse" | "pen" | "touch";
  /** Opened under a finger still down (press and hold): it can slide to a tool and lift there. */
  held?: boolean;
  /** Asked for (right-click, Q): a kept wheel that is folded unfolds. */
  summon?: boolean;
}

export interface WheelHost {
  readonly ui: UI;
  mainTools(): ToolItem[];
}

interface Metrics {
  /** The middle: the handle. */
  hub: number;
  /** The ring of groups: from, to. */
  r0: number;
  r1: number;
  /** Between the ring and a row of tools, and between rows. */
  gap: number;
  /** How deep a row of tools is. */
  depth: number;
  /** A tool's cell along its row: as wide as `max`, down to `min` when the row is full. */
  min: number;
  max: number;
}
const FINE: Metrics = { hub: 24, r0: 30, r1: 100, gap: 4, depth: 54, min: 46, max: 58 };
/** Fingers (and a headset's ray): bigger cells. */
const COARSE: Metrics = { hub: 26, r0: 32, r1: 108, gap: 4, depth: 58, min: 52, max: 64 };
/** A small gap (px) where a new part of a list starts. */
const PART_GAP = 9;
/** The drawings are this far (px) each way from the middle at most. */
const BOX = 440;
const SVG = "http://www.w3.org/2000/svg";
const TAU = Math.PI * 2;
/** Where the wheel is kept, per kind of screen (as the tool card's place is). */
const SPOTS = "sg-wheel-spot";
/** The tools last run from the model's wheel, shown under View (most recent first). */
const RECENT = "sg-wheel-recent";
const RECENT_MAX = 3;

/** Every tool that runs, in a tree of them (groups and families opened). */
function leaves(items: ToolItem[]): ToolItem[] {
  return items.flatMap((it) => (it.children?.length ? leaves(it.children) : it.run ? [it] : []));
}

/** The top sector: what's picked (its own tools), and the view's. */
const OWN = "own";
/**
 * Where a picked thing's tool goes when it isn't named like one of the main
 * tools (those go where the main tool is). Anything not known: the top sector.
 */
const GROUP_OF: Record<string, string> = {
  text: "sketch", offset: "sketch", projs: "sketch",
  editFreeform: "freeform", fillHole: "freeform", thicken: "freeform",
  planePerp: "construct", planeEdge: "construct",
  moveBody: "transform", moveVertex: "transform", patl: "transform", patc: "transform", copySketch: "transform", align: "transform",
  offsetFromEdge: "modify",
  drawing: "more", material: "more",
  deselect: OWN, wholePattern: OWN, color: OWN, opacity: OWN, delete: OWN, deleteBody: OWN,
};

/**
 * The sketch's wheel, clockwise from the top: Exit, then the tools by what
 * they are for down the right (their fans open away from the screen's edge
 * the wheel starts at), and the rest - the line type, Normal to Sketch, a tool
 * not named here - under More; Delete and Select on the left, a tap each.
 */
const SKETCH: ({ tool: string; label?: string } | { id: string; label: string; icon: IconName; tools: string[] })[] = [
  { tool: "exit", label: "Exit" },
  { id: "draw", label: "Draw", icon: "line", tools: ["line", "arc", "spline", "rect", "circle", "ellipse", "polygon", "text"] },
  { id: "modify", label: "Modify", icon: "trim", tools: ["fillet", "trim", "extend", "split", "align", "offset", "project"] },
  { id: "transform", label: "Transform", icon: "transform", tools: ["move", "rotate", "scale", "mirror", "pattern"] },
  { id: "more", label: "More", icon: "more", tools: [] },
  { tool: "delete" },
  { tool: "select" },
];

interface Cell {
  item: ToolItem;
  /** A new part of the list starts here. */
  gap?: boolean;
}
interface Sector {
  id: string;
  label: string;
  icon: IconName;
  cells: Cell[];
  /** A place on the ring that is a tool itself (Sketch with nothing picked; Exit, Select, Delete in a sketch): a tap runs it. */
  item?: ToolItem;
  /** That tool is the one in use. */
  on?: boolean;
  /** Nothing in it now: why. */
  why?: string;
  /** The tool most likely next (or the one in use, or one that is on) is in it. */
  mark: boolean;
}
interface Placed extends Cell {
  r0: number;
  r1: number;
  a0: number;
  a1: number;
  /** 0: the group's own tools; 1, 2: the kinds of a tool opened further out (the cascade). */
  level: number;
}

// What the pointer is over, as a number (compared on every move): nothing, the middle, a group, a tool.
const NONE = -1;
const HUB = 0;
const SECTOR = 1;
const CELL = 100;

const notSep = (it: ToolItem) => !it.id.startsWith("---");
const kidsOf = (it: ToolItem) => usable(it.children ?? []).filter(notSep);
/** A tap opens its kinds - not one that starts with the kind used last and shows them once it's the tool in use. */
const opens = (it: ToolItem) => kidsOf(it).length > 0 && !(it.variantsWhenActive && !it.active && !!it.run);
const marked = (cells: Cell[]) => cells.some((c) => !!c.item.active || !!c.item.pulse);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Everything a ring shows, as text: the same again needs no drawing again. */
function signature(sectors: Sector[]): string {
  const tool = (it: ToolItem): unknown[] => [it.id, it.label, it.icon, it.sub, !!it.active, !!it.pulse, it.swatch, it.shortcut, kidsOf(it).map(tool)];
  return JSON.stringify(sectors.map((s) => [s.id, s.label, s.icon, !!s.on, s.mark, s.why, s.item && tool(s.item), s.cells.map((c) => [!!c.gap, tool(c.item)])]));
}

/** A piece of a ring, from r0 to r1 and a0 to a1 (clockwise, 0 to the right), a gap of `gap` px kept round it. */
function wedge(r0: number, r1: number, a0: number, a1: number, gap = 2): string {
  const p = (r: number, a: number) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
  const i0 = a0 + gap / 2 / r0;
  const i1 = a1 - gap / 2 / r0;
  const o0 = a0 + gap / 2 / r1;
  const o1 = a1 - gap / 2 / r1;
  const big = (a: number, b: number) => (b - a > Math.PI ? 1 : 0);
  return `M${p(r0, i0)}L${p(r1, o0)}A${r1} ${r1} 0 ${big(o0, o1)} 1 ${p(r1, o1)}L${p(r0, i1)}A${r0} ${r0} 0 ${big(i0, i1)} 0 ${p(r0, i0)}Z`;
}

/**
 * A group's tools as rows of a piece of ring outside the ring of groups,
 * centred on the group (`mid`): half a ring at most (`spanAt` says how much
 * of the ring a row reaching out to a radius may take - less than half where
 * the screen is too small for that). One row while they fit, then more
 * further out.
 */
function fanLayout(cells: Cell[], mid: number, m: Metrics, spanAt: (reach: number) => number = () => Math.PI, inner = m.r1, level = 0): Placed[] {
  const N = cells.length;
  if (!N) return [];
  const rows: { r0: number; r1: number; rm: number; span: number; cap: number }[] = [];
  let room = 0;
  for (let k = 0; room < N && k < 5; k++) {
    const r0 = inner + m.gap + k * (m.depth + m.gap);
    const rm = r0 + m.depth / 2;
    const span = spanAt(r0 + m.depth);
    const cap = Math.max(1, Math.floor((span * rm) / m.min));
    rows.push({ r0, r1: r0 + m.depth, rm, span, cap });
    room += cap;
  }
  // Read top to bottom at either side, left to right above and below.
  const flip = Math.cos(mid) < -0.01 || (Math.abs(Math.cos(mid)) <= 0.01 && Math.sin(mid) > 0);
  const out: Placed[] = [];
  let at = 0;
  rows.forEach((row, k) => {
    const left = N - at;
    const later = rows.slice(k + 1).reduce((s, r) => s + r.cap, 0);
    // In proportion to the row's room (so the cells come out about as wide in each), the list kept in order.
    const n = k === rows.length - 1 ? left : Math.max(left - later, Math.min(row.cap, left, Math.round((N * row.cap) / room)));
    const part = cells.slice(at, at + n);
    at += n;
    if (!part.length) return;
    const seq = flip ? [...part].reverse() : part;
    const gapAt = seq.map((c, j) => j > 0 && !!(flip ? seq[j - 1].gap : c.gap));
    const gaps = gapAt.filter(Boolean).length * PART_GAP;
    const w = Math.min(m.max, (row.span * row.rm - gaps) / seq.length);
    let a = mid - (seq.length * w + gaps) / row.rm / 2;
    const placed = seq.map((c, j): Placed => {
      if (gapAt[j]) a += PART_GAP / row.rm;
      const a0 = a;
      a += w / row.rm;
      return { ...c, r0: row.r0, r1: row.r1, a0, a1: a, level };
    });
    out.push(...(flip ? placed.reverse() : placed));
  });
  return out;
}

function svgBox(): SVGSVGElement {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("class", "wheel-svg");
  s.setAttribute("viewBox", `${-BOX} ${-BOX} ${2 * BOX} ${2 * BOX}`);
  s.setAttribute("width", String(2 * BOX));
  s.setAttribute("height", String(2 * BOX));
  s.style.left = s.style.top = `${-BOX}px`;
  return s;
}

function path(cls: string, d: string): SVGPathElement {
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("class", cls);
  p.setAttribute("d", d);
  return p;
}

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class Wheel implements WheelHandle {
  private readonly root = el("div", "");
  private readonly body = el("div", "wheel-body");
  private readonly ringBox = el("div", "wheel-ring");
  private readonly fanBox = el("div", "wheel-fan");
  private readonly hubBox = el("div", "wheel-mid");
  private readonly ringSvg = svgBox();
  private readonly fanSvg = svgBox();
  private readonly hubSvg = svgBox();
  private readonly ringItems = el("div", "wheel-items");
  private readonly fanItems = el("div", "wheel-items");
  private readonly tip = el("div", "wheel-tip");
  private readonly hubEl = document.createElementNS(SVG, "circle");
  /** The mark on the middle: the handle's, or a cog beside a tool (it is the Settings there). */
  private readonly grip = el("div", "wheel-item wheel-grip");
  private ringEls: SVGElement[] = [];
  private fanEls: SVGElement[] = [];

  private m = FINE;
  /** Whose column it stands in for now (null: no one's - the column shows). */
  private layout: WheelLayout | null = null;
  private extras: WheelExtras | null = null;
  private sectors: Sector[] = [];
  /** What the ring was last drawn from. */
  private sig = "";
  /** What's picked, as the top sector names it ("" nothing): a wheel up at the pointer goes when that changes under it. */
  private pick = "";
  private fan: Placed[] = [];
  /** The group whose tools are fanned out (-1: none), and the tools opened inside it (Plane › …). */
  private openSector = -1;
  private trail: ToolItem[] = [];
  private hot = NONE;
  private up = false;
  private dismissed = false;

  /** Where it is kept, by layout: the middle as fractions of the page's width and height. */
  private spots: Partial<Record<WheelLayout, [number, number]>> = {};
  /** Kept, and folded to just its middle (until the page is loaded again). */
  private folded: Record<WheelLayout, boolean> = { model: false, sketch: screenClass() === "phone", freeform: screenClass() === "phone", settings: true, options: true };
  /** Where it belongs (px): where it was put, or where it came up. */
  private home = { x: 0, y: 0 };
  /** The middle, on the page (off its home while a fan needs the room). */
  private cx = 0;
  private cy = 0;
  private slid = false;
  /** Where the pointer is, and where it was when the wheel came up. */
  private px = 0;
  private py = 0;
  private from = { x: 0, y: 0 };
  /** Not moved since it came up: what's under the pointer doesn't count yet. */
  private still = false;
  /** The wheel slid under a pointer that stayed put: nothing changes until it moves from here. */
  private hold: { x: number; y: number } | null = null;
  private type: "mouse" | "pen" | "touch" = "mouse";
  /** The pointer pressed on the wheel (it may slide to a tool and let go there). */
  private pressed: number | null = null;
  /** Pressed on the middle: the wheel goes with it once it moves. */
  private grab: { dx: number; dy: number; moved: boolean } | null = null;
  private hubTapAt = -Infinity;
  /** Opened under a finger still down: its next move makes it the pressed one. */
  private adopt = false;
  private adopted = false;
  private openAtPress = -1;
  /** What the press came down on, and where: a tap acts on that, wherever the wheel has slid to since. */
  private pressHit = NONE;
  private pressAt = { x: 0, y: 0 };
  /** Counts the fans shown: a tool pressed in a fan that has since been replaced isn't run. */
  private fanCount = 0;
  private pressFan = 0;
  /** A list swapped in under a resting pointer: a click this soon after isn't for it. */
  private guardUntil = 0;
  /** When the wheel last slid to bring a fan on the screen. */
  private slidAt = -Infinity;
  /**
   * Just up at the pointer: the second tap of a double tap (the whole body)
   * still goes to the model - through the middle, or through all of it when
   * it had to open off the pointer (which is then on one of its pieces).
   */
  private fresh: "" | "hub" | "all" = "";
  private switchTimer = 0;
  private drillTimer = 0;
  private freshTimer = 0;
  private leaveTimer = 0;
  private tipTimer = 0;
  private refreshing = false;

  /**
   * The tool wheel ("tools": what a tool asks for with `cover`), or the
   * Settings wheel ("settings"): always on the screen while the wheel is on,
   * folded to its cog unless opened.
   */
  constructor(
    private host: WheelHost,
    private readonly kind: "tools" | "settings" | "options" = "tools",
  ) {
    this.root.id = kind === "tools" ? "wheel" : `wheel-${kind}`;
    this.root.classList.add("wheel-root");
    if (kind !== "tools") this.layout = kind;
    this.root.hidden = true;
    this.tip.hidden = true;
    this.hubEl.setAttribute("class", "wheel-hub");
    this.hubSvg.append(this.hubEl);
    this.hubBox.append(this.hubSvg, this.grip);
    this.fanBox.append(this.fanSvg, this.fanItems);
    this.ringBox.append(this.ringSvg, this.ringItems);
    this.body.append(this.fanBox, this.ringBox, this.hubBox);
    this.root.append(this.body, this.tip);
    document.body.append(this.root);
    document.addEventListener("pointerdown", this.onDown, true);
    document.addEventListener("pointermove", this.onMove, true);
    document.addEventListener("pointerup", this.onUp, true);
    document.addEventListener("pointercancel", this.onCancel, true);
    // A finger on the wheel is never the page scrolling or zooming: else a phone's browser
    // takes it over after a few millimetres and the drag stops (pointercancel).
    document.addEventListener("touchmove", (e) => this.pressed !== null && e.cancelable && e.preventDefault(), { capture: true, passive: false });
    window.addEventListener("keydown", this.onKey, true);
    // Scrolling zooms the view: the wheel is out of its way (kept somewhere, its fan is).
    window.addEventListener("wheel", () => this.away(), { capture: true, passive: true });
    window.addEventListener("blur", () => this.away());
    window.addEventListener("resize", () => {
      // (Typing a value: on a phone the keyboard coming up is a resize - the wheel stays as it is.)
      if (!this.up || this.typer) return;
      if (!this.kept) return this.hide();
      // (A fan laid out for the old screen may not fit the new one: it is put away, opened again where it fits.)
      this.shut();
      this.home = this.homeNow();
      this.rest();
    });
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    if (kind === "tools") host.ui.onTools = () => this.itemsChanged();
    // (The tool's window opened, closed or changed: the Options wheel comes, goes, or shows what it holds now.)
    if (kind === "tools") host.ui.onPanel = () => this.layout === "freeform" && this.itemsChanged();
    if (kind === "options") {
      const before = host.ui.onPanel;
      host.ui.onPanel = () => (before?.(), this.sync(), this.itemsChanged());
    }
    // (A setting changed: the mode itself, or what Settings shows - the unit, the numpad on or off.)
    settings.onChange(() => (this.sync(), this.itemsChanged()));
    if (kind !== "tools") {
      this.loadSpots();
      // (Once the app is set up: its lists are the right column's, made after the wheels.)
      setTimeout(() => this.sync());
    } else this.sync();
  }

  get on(): boolean {
    return settings.value.wheel;
  }

  get isOpen(): boolean {
    return this.up;
  }

  get kept(): boolean {
    return this.layout === "sketch" || this.layout === "freeform" || this.layout === "settings" || this.layout === "options" || (this.layout === "model" && !!this.spots.model);
  }

  private get isFolded(): boolean {
    return !!this.layout && this.kept && this.folded[this.layout];
  }

  cover(layout: "model" | "sketch" | "freeform" | false, extras?: WheelExtras): void {
    if (this.kind !== "tools") return;
    const next = layout || null;
    toolsLayout = next;
    if (extras) this.extras = extras;
    // (The sketch says so each time it sets its tools: the same again is nothing new.)
    if (next === this.layout) return;
    this.hide();
    this.layout = next;
    if (!extras) this.extras = null;
    this.loadSpots();
    this.sync();
  }

  /** The column steps aside while the wheel stands in for it; a kept wheel is up whenever there is something for it to show. */
  private sync(): void {
    if (this.kind === "tools") {
      // (On at all: the right column keeps only Fit, Screenshot and History - the rest is on the Settings wheel.)
      document.body.classList.toggle("wheel-ui", this.on);
      // (While another tool is open it stands in for nothing: the tool's own column and bar stay.)
      document.body.classList.toggle("wheel-covers", this.on && (this.layout === "model" || this.layout === "sketch" || this.layout === "freeform"));
    }
    if (this.kind === "options") {
      // Up only while the open tool has a window with something to set; the window itself then stays out of sight.
      // (Not while the window holds a text box to type into - a sketch's Text: the window shows, with all of it.)
      const typing = !!document.querySelector("#panel .text-input");
      const has = this.on && this.host.ui.panelOpen && !typing && this.content().sectors.length > 0;
      document.body.classList.toggle("wheel-options", has);
      if (!has) return this.hide();
    }
    if (!this.on || !this.layout) return this.hide();
    if (this.kept && !this.up) this.showKept();
  }

  takeDismissed(): boolean {
    const d = this.dismissed;
    this.dismissed = false;
    return d;
  }

  // ------------------------------------------------------------------ places

  private loadSpots(): void {
    try {
      this.spots = JSON.parse(localStorage.getItem(SPOTS) ?? "{}")?.[screenClass()] ?? {};
    } catch {
      this.spots = {};
    }
  }

  private saveSpots(): void {
    try {
      const all = JSON.parse(localStorage.getItem(SPOTS) ?? "{}") ?? {};
      // (Both wheels keep their places here: each writes only its own.)
      const mine: WheelLayout[] = this.kind === "tools" ? ["model", "sketch", "freeform"] : [this.kind];
      const spots = { ...(all[screenClass()] ?? {}) };
      for (const k of mine) {
        if (this.spots[k]) spots[k] = this.spots[k];
        else delete spots[k];
      }
      all[screenClass()] = spots;
      localStorage.setItem(SPOTS, JSON.stringify(all));
    } catch {
      // private window: not remembered
    }
  }

  /** Where a kept wheel belongs on the page as it is now. */
  private homeNow(): { x: number; y: number } {
    if (this.layout === "settings" || this.layout === "options") {
      const s = this.spots[this.layout];
      if (s) return { x: s[0] * innerWidth, y: s[1] * innerHeight };
      // Never put anywhere: at the bottom right, beside the right-hand column (folded, just its icon) -
      // the Options above the Settings.
      const col = document.getElementById("right-col")?.getBoundingClientRect();
      const right = col && col.width > 0 ? col.left : innerWidth;
      // (Placed by the folded size: the two icons keep their places; unfolded, a wheel comes in from the edges as far as it must.)
      const r = this.m.r0;
      const step = this.layout === "options" ? 2 * r + 16 : 0;
      // (A phone: no tool strip along the bottom any more - down on the row of undo/redo, level
      // with its bottom; upright, where there's no room above the guide text, side by side.)
      const undo = document.getElementById("undo-dock")?.getBoundingClientRect();
      if (document.documentElement.dataset.screen === "phone" && undo && undo.height > 0) {
        const upright = innerHeight > innerWidth;
        return { x: right - 8 - r - (upright ? step : 0), y: undo.bottom - r - (upright ? 0 : step) };
      }
      return { x: right - 8 - r, y: innerHeight - 70 - step - r };
    }
    // (The sketch's wheel never moved: where the model's is kept, if it is.)
    const s = (this.layout && this.spots[this.layout]) ?? this.spots.model;
    if (s) return { x: s[0] * innerWidth, y: s[1] * innerHeight };
    // Never put anywhere: where the tool column is - at the left, beside Items when that is open
    // (folded, its middle is at the edge; unfolded, the ring is clear of it).
    const items = document.getElementById("items");
    const left = items?.classList.contains("open") && innerWidth > 720 ? items.getBoundingClientRect().right : 0;
    return { x: left + 8 + (this.isFolded ? this.m.r0 : this.m.r1), y: innerHeight / 2 };
  }

  /** A kept wheel at its home, as near it as keeps it whole on the screen (folded: just its middle). */
  private rest(): void {
    const M = 6;
    const r = this.isFolded ? this.m.r0 : this.m.r1;
    this.cx = clamp(this.home.x, r + M, Math.max(r + M, innerWidth - r - M));
    this.cy = clamp(this.home.y, r + M, Math.max(r + M, innerHeight - r - M));
    this.slid = false;
    this.place();
  }

  private place(): void {
    this.root.style.transform = `translate(${Math.round(this.cx)}px, ${Math.round(this.cy)}px)`;
  }

  /** Folded to just the middle (the handle), or whole again. */
  private fold(on: boolean): void {
    if (!this.layout) return;
    this.folded[this.layout] = on;
    this.root.classList.toggle("folded", on);
    if (!on && this.layout === "settings") {
      // (Unfolded: the lists as they are now - the settings may have changed from elsewhere since.)
      this.sectors = this.content().sectors;
      this.sig = signature(this.sectors);
      this.drawRing();
    }
    if (on) this.shut();
    this.unpoint();
    this.root.classList.add("slide");
    this.home = this.homeNow();
    this.rest();
  }

  /** Let go where it was dragged to: it is kept there from now on. */
  private drop(): void {
    const layout = this.layout;
    if (!layout) return;
    const was = this.kept;
    this.home = { x: this.cx, y: this.cy };
    this.spots[layout] = [this.cx / innerWidth, this.cy / innerHeight];
    this.saveSpots();
    if (was) return;
    // Up at the pointer until now: from here on it stays where it was put.
    this.settle();
    this.still = false;
    this.root.classList.add("kept");
    this.host.ui.toast("The wheel stays here now. Tap its middle to fold it away - twice, and it comes up at the pointer again.");
  }

  /** The model's wheel no longer kept anywhere: it comes up at the pointer again. */
  private letGo(): void {
    delete this.spots.model;
    this.saveSpots();
    this.folded.model = false;
    this.hide();
    this.host.ui.toast("The wheel comes up at the pointer again: tap the model, or an empty spot.");
  }

  // ---------------------------------------------------------------- content

  private content(): { sectors: Sector[]; pick: string } {
    return this.layout === "sketch" ? this.sketchContent() : this.layout === "freeform" ? this.freeformContent() : this.layout === "settings" ? this.settingsContent() : this.layout === "options" ? this.optionsContent() : this.modelContent();
  }

  /**
   * The Settings wheel: Snap to, Units, Appearance, Shaders - each fanning out
   * its switches and choices, set with a tap right there (what only a slider or
   * a typed value can set is under More…, in the list's window) - NumPad and Snapshot.
   */
  private settingsContent(): { sectors: Sector[]; pick: string } {
    const ui = this.host.ui;
    const lists: [string, string, IconName][] = [
      ["snap", "Snap to", "magnet"],
      ["units", "Units", "ruler"],
      ["appearance", "Appearance", "eye"],
      ["display", "Shaders", "display"],
    ];
    const sectors = lists.map(([id, label, icon]): Sector => ({
      id,
      label,
      icon,
      cells: ui.optionItems(id, () => this.openList(id, label)),
      mark: false,
    }));
    const pad = settings.value.numpad;
    const numpad: ToolItem = { id: "set-numpad", label: "NumPad", icon: "numpad", sub: pad ? "On" : "Off", active: pad, run: () => ui.popAt("numpad", 0, 0) };
    sectors.push({ id: "numpad", label: "NumPad", icon: "numpad", cells: [], item: numpad, on: pad, mark: false });
    const shot: ToolItem = { id: "set-shot", label: "Snapshot", icon: "camera", run: () => ui.popAt("shot", 0, 0) };
    sectors.push({ id: "shot", label: "Snapshot", icon: "camera", cells: [], item: shot, mark: false });
    return { sectors, pick: "" };
  }

  /**
   * The Options wheel: what the open tool's window holds. Each choice fans out
   * its options, a switch or a slot is one tap, chips fan out; numbers and
   * sliders are typed in the window, which Values brings back. Then the
   * window's own actions (under More), Cancel and Done.
   */
  private optionsContent(): { sectors: Sector[]; pick: string } {
    const ui = this.host.ui;
    const p = ui.panelContent();
    if (!p) return { sectors: [], pick: "" };
    let k = 0;
    // ("opt-": set right there, the wheel stays open showing it.)
    const opt = (label: string, run: () => void, on?: boolean, sub?: string, icon?: IconName): ToolItem => ({ id: `opt-panel-${k++}`, label, icon: icon ?? iconNameFor(label) ?? (on ? "check" : "options"), sub, active: on, run });
    const sectors: Sector[] = [];
    // (A freeform shape: its wheel has the rest - here only the values to set.)
    const ff = toolsLayout === "freeform";
    const more: Cell[] = ff ? [] : p.actions.filter((a) => !a.disabled).map((item) => ({ item }));
    const valueCells: Cell[] = [];
    for (const it of p.items) {
      if (ff && it.type !== "number" && it.type !== "slider") continue;
      if (it.type === "choice") {
        const now = it.options.find((o) => o.id === it.value);
        const cells = it.options.map((o): Cell => ({ item: opt(o.label, () => it.onChange(o.id), o.id === it.value) }));
        sectors.push({ id: `choice-${k}`, label: it.label ?? now?.label ?? "Kind", icon: "more", cells, mark: false });
      } else if (it.type === "toggle") {
        const item = opt(it.label, () => it.onChange(!it.value), it.value, it.value ? "On" : "Off", iconNameFor(it.label) ?? (it.value ? "check" : "close"));
        sectors.push({ id: item.id, label: it.label, icon: item.icon, cells: [], item, on: it.value, mark: false });
      } else if (it.type === "slot") {
        const item = opt(it.label, it.onClick, it.active, it.value, iconNameFor(it.label) ?? (it.filled ? "check" : "point"));
        sectors.push({ id: item.id, label: it.label, icon: item.icon, cells: [], item, on: it.active, mark: false });
      } else if (it.type === "chips") {
        if (!it.chips.length) continue;
        const cells = it.chips.map((c): Cell => ({ item: opt(c.glyph ? `${c.glyph} ${c.label}` : c.label, c.onClick, !!c.on, undefined, "constraints") }));
        sectors.push({ id: `chips-${k++}`, label: it.label ?? "Add", icon: "constraints", cells, mark: false });
      } else if (it.type === "button") {
        // A tap each, on the ring (where to sketch: XY, XZ, YZ…); past the room there, under More.
        const item: ToolItem = { id: `panel-btn-${k++}`, label: it.label, icon: it.icon ?? iconNameFor(it.label) ?? "tools", run: it.onClick };
        sectors.push({ id: item.id, label: it.label, icon: item.icon, cells: [], item, mark: !!it.primary });
      } else if (it.type === "number" || it.type === "slider") {
        // A value: a tap and its box is up to type it in (the numpad with it,
        // where that's on) - the value itself as its second line.
        const len = it.type === "number" && (it.kind ?? "length") === "length";
        const show = it.type === "slider" ? (it.show?.(it.value) ?? String(it.value)) : len ? `${+(toDisplay(it.value)).toFixed(3)} ${UNIT_LABEL[units()]}` : String(+it.value.toFixed(3));
        const put = (to: number) => {
          let v = to;
          if (it.type === "slider") v = Math.min(it.max, Math.max(it.min, v));
          else if (it.min !== undefined) v = Math.max(it.min, v);
          if (it.type === "number" && it.kind === "int") v = Math.round(v);
          it.onInput(v);
          // (A tool that does not draw its window again keeps this item: it holds the new value from now on.)
          it.value = v;
          ui.syncPanelValue(it, v);
        };
        const kind = it.type === "slider" || it.kind === "int" || it.kind === "number" ? "number" : it.kind === "angle" ? "angle" : "length";
        const now = it.type === "number" && kind === "length" ? String(+toDisplay(it.value).toFixed(4)) : String(+it.value.toFixed(4));
        valueCells.push({ item: opt(it.label, () => this.typeValue(it.label, now, kind, put), false, show, "numpad") });
      }
    }
    // Room on the ring: past six of its own, the rest of the window's switches and buttons go under More.
    while (sectors.length > 6) {
      const s = sectors.pop()!;
      more.unshift(...(s.item ? [{ item: s.item }] : s.cells));
    }
    if (more.length) sectors.push({ id: "more", label: "More", icon: "more", cells: more, mark: false });
    // Only values to set (a new shape's size): each its own place on the ring, a tap to type it -
    // not one lone Values group on a whole ring.
    if (!sectors.length && valueCells.length <= 8) for (const c of valueCells) sectors.push({ id: c.item.id, label: c.item.label, icon: c.item.icon, cells: [], item: c.item, mark: false });
    // (One value: Values is it - a tap and its box is up.)
    else if (valueCells.length === 1) sectors.push({ id: "values", label: valueCells[0].item.label, icon: "numpad", cells: [], item: valueCells[0].item, mark: false });
    else if (valueCells.length) sectors.push({ id: "values", label: "Values", icon: "numpad", cells: valueCells, mark: false });
    if (p.cancel && !ff) sectors.push({ id: "cancel", label: "Cancel", icon: "close", cells: [], item: { id: "cancel", label: "Cancel", icon: "close", shortcut: "Esc", run: p.cancel }, mark: false });
    if (p.done && !ff) sectors.push({ id: "done", label: "Done", icon: "check", cells: [], item: { id: "done", label: "Done", icon: "check", shortcut: "Enter", run: p.done }, mark: false });
    // (Only Done or Cancel: nothing to set - no wheel; the tool's own ways to finish stay.)
    return { sectors: sectors.some((s) => s.id !== "done" && s.id !== "cancel") ? sectors : [], pick: "" };
  }

  /** The box a value is being typed into, on the wheel. */
  private typer: HTMLElement | null = null;
  /** Ends that box: true sets what is typed, false leaves the value as it was. */
  private typerEnd: ((keep: boolean) => void) | null = null;

  /**
   * Type a value right on the wheel: a small box by the pointer, the value
   * in it selected. Enter (or tapping away) sets it, Esc leaves it as it was.
   */
  private typeValue(label: string, now: string, kind: "length" | "angle" | "number", put: (v: number) => void): void {
    this.typerEnd?.(false);
    const box = el("div", "wheel-type");
    box.append(el("span", "wheel-type-label", label));
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = now;
    input.dataset.kind = kind === "number" ? "number" : kind;
    numpadInput(input);
    box.append(input);
    const unit = kind === "length" ? UNIT_LABEL[units()] : kind === "angle" ? "°" : "";
    if (unit) box.append(el("span", "wheel-type-unit", unit));
    box.style.left = `${Math.round(this.px - this.cx)}px`;
    box.style.top = `${Math.round(this.py - this.cy)}px`;
    this.root.append(box);
    this.typer = box;
    let over = false;
    const done = (keep: boolean) => {
      if (over) return;
      over = true;
      if (keep) {
        const v = evaluate(input.value, kind);
        if (v !== null) put(v);
      }
      box.remove();
      if (this.typer === box) (this.typer = null), (this.typerEnd = null);
      this.itemsChanged();
    };
    this.typerEnd = done;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        done(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && done(true), 150));
    // Kept on the screen.
    const r = box.getBoundingClientRect();
    if (r.right > innerWidth - 6) box.style.left = `${Math.round(this.px - this.cx - (r.right - innerWidth + 6))}px`;
    if (r.bottom > innerHeight - 6) box.style.top = `${Math.round(this.py - this.cy - (r.bottom - innerHeight + 6))}px`;
    input.focus();
    selectAll(input);
    openNumpad(input);
  }

  /** A list's window (for what the wheel can't set: a slider, a typed size), beside the wheel on the side the pointer is. */
  private openList(id: string, label: string): void {
    const out = Math.hypot(this.px - this.cx, this.py - this.cy) + 34;
    this.host.ui.popAt(id, this.px >= this.cx ? this.cx + out : this.cx - out - 270, this.py - 28, label);
  }

  /** The model's ring: the top sector, then the main groups in the column's order - each with what it holds now. */
  private modelContent(): { sectors: Sector[]; pick: string } {
    const { column, bar } = this.host.ui.shown();
    const main = this.host.mainTools();
    const shown = usable(column).filter(notSep);
    let groups: Sector[];
    let own: Cell[] = [];
    if (shown.length > 0 && shown.every((it) => main.some((g) => g.id === it.id))) {
      // Nothing picked: the column is the main tools themselves.
      groups = shown.map((g) => {
        const cells = kidsOf(g).map((item) => ({ item }));
        return { id: g.id, label: g.label, icon: g.icon, cells, item: g.children?.length ? undefined : g, mark: !!g.pulse || marked(cells) };
      });
    } else {
      // Something picked: its tools, each in the group the main tool of that name is in.
      const where = new Map<string, string>();
      const walk = (items: ToolItem[], g: string) => {
        for (const it of items) {
          if (!where.has(it.id)) where.set(it.id, g);
          walk(it.children ?? [], g);
        }
      };
      for (const g of main) walk([g], g.id);
      const groupOf = (id: string) => GROUP_OF[id] ?? where.get(id) ?? OWN;
      const lists = new Map<string, Cell[]>(main.map((g) => [g.id, []]));
      for (const it of shown) (lists.get(groupOf(it.id)) ?? own).push({ item: it });
      // A group with nothing for this pick says why: its tools that are off, with their reasons.
      const off = new Map<string, string[]>();
      for (const it of column) if (it.disabled && it.why && it.label) off.set(groupOf(it.id), [...(off.get(groupOf(it.id)) ?? []), `${it.label}: ${it.why}`]);
      const what = shown.find((it) => it.id === "deselect")?.sub;
      groups = main.map((g) => {
        const cells = lists.get(g.id)!;
        const why = cells.length ? undefined : off.get(g.id)?.slice(0, 3).join(" · ") ?? `${g.label} has nothing for ${what ?? "this"}`;
        return { id: g.id, label: g.label, icon: g.icon, cells, why, mark: marked(cells) };
      });
    }
    const pick = shown.find((it) => it.id === "deselect")?.sub ?? "";
    own = [...own, ...(this.extras?.() ?? []).map((item) => ({ item }))];
    const view = usable(bar).filter(notSep).map((item, i): Cell => ({ item, gap: i === 0 && own.length > 0 }));
    // Nothing picked: the tools run last, after the view's (a picked thing's own come first instead).
    const all = pick ? [] : leaves(main);
    const recent = this.recent
      .map((id) => all.find((t) => t.id === id))
      .filter((t): t is ToolItem => !!t && !t.disabled && !view.some((c) => c.item.id === t.id))
      .map((item, i): Cell => ({ item, gap: i === 0 }));
    const top: Sector = { id: OWN, label: pick || "View", icon: pick ? "pointer" : "eye", cells: [...own, ...view, ...recent], mark: marked(view) };
    return { sectors: [top, ...groups], pick };
  }

  /**
   * A freeform shape's wheel: what its card offers, by what it does, each
   * group in the same place every time (greyed, saying why, while nothing
   * picked fits it) - Done at the top, Select all and Cancel a tap each. The
   * values to type stay on the Options wheel.
   */
  private freeformContent(): { sectors: Sector[]; pick: string } {
    const p = this.host.ui.panelContent();
    if (!p) return { sectors: [], pick: "" };
    let k = 0;
    // ("opt-": set right there, the fan stays showing it; a button that changes the shape closes it.)
    const opt = (label: string, run: () => void, on?: boolean, sub?: string, icon?: IconName): ToolItem => ({ id: `opt-ff-${k++}`, label, icon: icon ?? iconNameFor(label) ?? (on ? "check" : "options"), sub, active: on, run });
    const act = (label: string, run: () => void, icon?: IconName): ToolItem => ({ id: `ff-${k++}`, label, icon: icon ?? iconNameFor(label) ?? "freeform", run });
    const cells: Record<string, Cell[]> = { shape: [], holes: [], move: [], symmetry: [], solid: [], more: [] };
    const choice = (it: Extract<PanelItem, { type: "choice" }>) => it.options.map((o): Cell => ({ item: opt(o.label, () => it.onChange(o.id), o.id === it.value) }));
    for (const it of p.items) {
      if (it.type === "button") {
        const to = /^(Extrude face|Inset|Extend surface|Add edge loop|Bridge faces)/.test(it.label) ? "shape" : /^(Fill hole|Bridge holes|Connect edges|Delete face)/.test(it.label) ? "holes" : /^Fill to a plane/.test(it.label) ? "solid" : "more";
        cells[to].push({ item: act(it.label, it.onClick, it.icon) });
      } else if (it.type === "choice") {
        const ids = it.options.map((o) => o.id);
        if (ids.includes("move") && ids.includes("turn")) cells.move.push(...choice(it));
        else if (ids.includes("up") && ids.includes("down")) cells.solid.unshift(...choice(it));
        else if (it.label === "Mirror across") cells.symmetry.push(...choice(it));
        else cells.more.push({ item: { id: `ff-kinds-${k++}`, label: it.label ?? "Kind", icon: "more", sub: it.options.find((o) => o.id === it.value)?.label, children: choice(it).map((c) => c.item) } });
      } else if (it.type === "toggle") {
        const to = it.label === "Symmetry" ? "symmetry" : "more";
        cells[to].unshift({ item: opt(it.label, () => it.onChange(!it.value), it.value, it.value ? "On" : "Off", iconNameFor(it.label) ?? (it.value ? "check" : "close")) });
      } else if (it.type === "slot") {
        cells.more.push({ item: opt(it.label, it.onClick, it.active, it.value, iconNameFor(it.label) ?? (it.filled ? "check" : "point")) });
      } else if (it.type === "chips") {
        for (const c of it.chips) cells.more.push({ item: opt(c.label, c.onClick, !!c.on) });
      }
    }
    let selectAll: ToolItem | undefined;
    for (const a of p.actions) {
      if (a.disabled) continue;
      if (a.id === "all") selectAll = a;
      else if (a.id === "refine") cells.shape.push({ item: a });
      else cells.more.push({ item: a });
    }
    const group = (id: string, label: string, icon: IconName, why: string): Sector => ({ id, label, icon, cells: cells[id], why: cells[id].length ? undefined : why, mark: false });
    const sectors: Sector[] = [];
    if (p.done) sectors.push({ id: "done", label: "Done", icon: "check", cells: [], item: { id: "ff-done", label: "Done", icon: "check", shortcut: "Enter", run: p.done }, mark: true });
    sectors.push(
      group("shape", "Shape", "extrude", "Pick faces, edges or points to shape"),
      group("holes", "Holes", "fill", "Pick a hole's rim, two borders, or faces"),
      group("move", "Move", "move", "Pick points, edges or faces to move them"),
      group("symmetry", "Symmetry", "mirror", "Not while the shape is being placed or set up"),
      group("solid", "Solid", "shell", "A closed shape is solid already"),
    );
    if (cells.more.length) sectors.push(group("more", "More", "more", ""));
    if (selectAll) sectors.push({ id: "select", label: "Select all", icon: "selectAll", cells: [], item: selectAll, mark: false });
    if (p.cancel) sectors.push({ id: "cancel", label: "Cancel", icon: "close", cells: [], item: { id: "ff-cancel", label: "Cancel", icon: "close", shortcut: "Esc", run: p.cancel }, mark: false });
    return { sectors, pick: "" };
  }

  /** The sketch's ring: its tools by what they are for (see SKETCH). */
  private sketchContent(): { sectors: Sector[]; pick: string } {
    const { column, bar } = this.host.ui.shown();
    const tools = usable(column).filter(notSep);
    const byId = new Map(tools.map((t) => [t.id, t]));
    const placed = new Set<string>();
    const sectors: Sector[] = [];
    for (const spec of SKETCH) {
      if ("tool" in spec) {
        const it = byId.get(spec.tool);
        if (!it) continue;
        placed.add(it.id);
        sectors.push({ id: it.id, label: spec.label ?? it.label, icon: it.icon, cells: [], item: it, on: !!it.active, mark: !!it.pulse });
        continue;
      }
      const cells = spec.tools.flatMap((id): Cell[] => {
        const it = byId.get(id);
        if (!it) return [];
        placed.add(id);
        return [{ item: it }];
      });
      sectors.push({ id: spec.id, label: spec.label, icon: spec.icon, cells, mark: false });
    }
    // More: what isn't named above (Other plane, a tool added since), then the bottom bar's (the line
    // type, Normal to Sketch) and the constraints column on or off. (Settings are on their own wheel.)
    const more = sectors.find((s) => s.id === "more" && !s.item);
    if (more) {
      const rest = tools.filter((t) => !placed.has(t.id)).map((item): Cell => ({ item }));
      const cons = settings.value.showConstraints;
      const constraints: ToolItem = { id: "set-constraints", label: "Constraints", icon: "constraints", sub: cons ? "On" : "Off", active: cons, run: () => this.host.ui.popAt("constraints", 0, 0) };
      more.cells = [...rest, ...[...usable(bar).filter(notSep), constraints].map((item, i): Cell => ({ item, gap: i === 0 && rest.length > 0 }))];
    }
    for (const s of sectors) if (!s.item) s.mark = marked(s.cells);
    // (A category with nothing in it has no place on the ring.)
    return { sectors: sectors.filter((s) => s.item || s.cells.length), pick: "" };
  }

  /**
   * A group's fan, and in a cascade outside it the kinds of each tool opened
   * on the way (`trail`): each further row centred on the tool it comes from,
   * the rows before it staying where they are.
   */
  private buildFan(i: number, trail: ToolItem[]): { fan: Placed[]; trail: ToolItem[] } {
    const s = this.sectors[i];
    if (!s) return { fan: [], trail: [] };
    const fan = this.fanFor(s.cells, this.midOf(i));
    const kept: ToolItem[] = [];
    for (const t of trail) {
      const from = fan.find((c) => c.level === kept.length && c.item.id === t.id && opens(c.item));
      if (!from) break;
      const inner = fan.reduce((r, c) => Math.max(r, c.r1), this.m.r1);
      const kinds = this.kindsOf(from.item);
      const mid = (from.a0 + from.a1) / 2;
      // Centred on the tool it comes from - or turned round the wheel, a little at a time, to where the screen holds it with the rest.
      const fits = (row: Placed[]) => {
        const e = this.spread([...fan, ...row]);
        return e.l + e.r <= innerWidth - 12 && e.t + e.b <= innerHeight - 12;
      };
      let row = this.fanFor(kinds, mid, inner, kept.length + 1);
      for (let k = 1; k <= 12 && !fits(row); k++) {
        const d = ((k + 1) >> 1) * (Math.PI / 18) * (k % 2 ? 1 : -1);
        const turned = this.fanFor(kinds, mid + d, inner, kept.length + 1);
        if (fits(turned)) row = turned;
      }
      fan.push(...row);
      kept.push(from.item);
    }
    return { fan, trail: kept };
  }

  /** A tool's kinds, as cells of the row opened for it. */
  private kindsOf(parent: ToolItem): Cell[] {
    const kids = kidsOf(parent);
    const cells = kids.map((item): Cell => ({ item }));
    // What a tap on it does in the column (the kind used last) comes first, unless one of its kinds is marked as that.
    if (parent.run && !kids.some((k) => k.active)) cells.unshift({ item: { ...parent, children: undefined } });
    return cells;
  }

  // ------------------------------------------------------------ open / close

  open(x: number, y: number, opts: WheelOpen = {}): void {
    if (!this.on || this.layout !== "model") return;
    // Kept somewhere: it is up already, with what's picked (asked for by name, it unfolds).
    if (this.kept) return void (opts.summon && this.folded.model && this.fold(false));
    this.hide();
    const { sectors, pick } = this.content();
    if (!sectors.some((s) => s.cells.length || s.item)) return;
    this.sectors = sectors;
    this.sig = signature(sectors);
    this.pick = pick;
    this.type = opts.type ?? "mouse";
    this.m = this.type === "touch" || isCoarse ? COARSE : FINE;
    // For a pointer that hovers: whole on the screen with any of its fans out, as near the
    // pointer as that allows - it then never has to move under the pointer. For a finger (nothing
    // is under it between taps), and where the screen is too small for that: the ring whole, right
    // where it was asked for, and it slides when a fan needs the room (see fit).
    const M = 6;
    const reach = this.extent();
    const ring = this.m.r1;
    const hovers = this.type !== "touch";
    const [l, r] = hovers && innerWidth >= reach.l + reach.r + 2 * M ? [reach.l, reach.r] : [ring, ring];
    const [t, b] = hovers && innerHeight >= reach.t + reach.b + 2 * M ? [reach.t, reach.b] : [ring, ring];
    this.cx = clamp(x, l + M, Math.max(l + M, innerWidth - r - M));
    this.cy = clamp(y, t + M, Math.max(t + M, innerHeight - b - M));
    this.home = { x: this.cx, y: this.cy };
    this.px = this.from.x = x;
    this.py = this.from.y = y;
    this.still = true;
    this.hold = null;
    this.root.classList.remove("kept", "folded", "slide", "dragging");
    this.draw();
    this.place();
    this.root.hidden = false;
    this.up = true;
    if (!calm()) this.body.animate([{ opacity: 0, transform: "scale(0.82)" }, { opacity: 1, transform: "none" }], { duration: 110, easing: "ease-out" });
    this.adopt = !!opts.held;
    this.adopted = false;
    if (!opts.held) {
      this.fresh = Math.hypot(x - this.cx, y - this.cy) > this.m.hub - 6 ? "all" : "hub";
      this.root.classList.add(this.fresh === "all" ? "fresh-all" : "fresh");
      this.freshTimer = window.setTimeout(() => this.settle(), 350);
    }
  }

  /** A kept wheel comes up at its place, with what there is now. */
  private showKept(): void {
    const { sectors, pick } = this.content();
    this.sectors = sectors;
    this.sig = signature(sectors);
    this.pick = pick;
    this.type = isCoarse ? "touch" : "mouse";
    this.m = isCoarse ? COARSE : FINE;
    this.still = false;
    this.hold = null;
    this.adopt = this.adopted = false;
    this.settle();
    this.root.classList.remove("slide", "dragging");
    this.root.classList.add("kept");
    this.root.classList.toggle("folded", this.isFolded);
    this.draw();
    this.home = this.homeNow();
    this.rest();
    this.root.hidden = false;
    this.up = true;
  }

  toggle(x: number, y: number, opts: WheelOpen = {}): void {
    if (!this.on || !this.layout) return;
    if (this.kept) return this.fold(!this.isFolded);
    if (this.up) this.hide();
    else this.open(x, y, opts);
  }

  /** No longer just up: every piece takes the pointer. */
  private settle(): void {
    clearTimeout(this.freshTimer);
    this.fresh = "";
    this.root.classList.remove("fresh", "fresh-all");
  }

  /** Away: one up at the pointer goes; one kept somewhere stays, its fan put away. */
  close(): void {
    if (this.kept) this.shut();
    else this.hide();
  }

  private away(): void {
    if (this.up) this.close();
  }

  /** Off the screen altogether. */
  private hide(): void {
    if (!this.up) return;
    this.up = false;
    this.root.hidden = true;
    this.clearTimers();
    this.settle();
    this.root.classList.remove("slide", "dragging");
    this.tip.hidden = true;
    this.pressed = null;
    this.grab = null;
    this.adopt = false;
    this.hot = NONE;
    this.openSector = -1;
    this.trail = [];
    this.fan = [];
  }

  private clearTimers(): void {
    clearTimeout(this.switchTimer);
    clearTimeout(this.drillTimer);
    clearTimeout(this.leaveTimer);
    clearTimeout(this.tipTimer);
  }

  /** Put the fan away, if one is out. */
  private shut(): void {
    if (this.openSector >= 0) this.showFan(-1);
  }

  /** Nothing pointed at any more (what was is redrawn, or gone). */
  private unpoint(): void {
    this.elOf(this.hot)?.classList.remove("hot");
    this.hot = NONE;
    this.tip.hidden = true;
    this.clearTimers();
  }

  /** The column or the bar was given new tools while the wheel is up: it shows them. */
  private itemsChanged(): void {
    if (!this.up || this.refreshing) return;
    this.refreshing = true;
    queueMicrotask(() => {
      this.refreshing = false;
      if (!this.up) return;
      const { sectors, pick } = this.content();
      // Up at the pointer, and what's picked changed under it (deleted, deselected by a key): it goes.
      if (!this.kept && pick !== this.pick) return this.hide();
      this.pick = pick;
      const open = this.sectors[this.openSector]?.id;
      const sig = signature(sectors);
      const same = sig === this.sig;
      this.sectors = sectors;
      this.sig = sig;
      const at = sectors.findIndex((s) => s.id === open && s.cells.length > 0);
      // The tools opened inside a tool (Plane › …), found again among the new ones.
      const trail: ToolItem[] = [];
      let from = at >= 0 ? sectors[at].cells.map((c) => c.item) : [];
      for (const t of this.trail) {
        const it = from.find((x) => x.id === t.id);
        if (!it) break;
        trail.push(it);
        from = kidsOf(it);
      }
      if (same && trail.length === this.trail.length) {
        // Nothing looks different (the model rebuilt, the same tools made again): only what a tap runs is new.
        const fresh = this.buildFan(this.openSector, trail);
        if (fresh.fan.length === this.fan.length) {
          this.fan = fresh.fan;
          this.trail = fresh.trail;
        }
        return;
      }
      this.unpoint();
      this.drawRing();
      this.showFan(at, at >= 0 ? trail : []);
    });
  }

  // ----------------------------------------------------------------- drawing

  private midOf(i: number): number {
    return -Math.PI / 2 + (i * TAU) / this.sectors.length;
  }

  private item(it: { icon: IconName; swatch?: string }, label: string, cls: string, r: number, a: number, width?: number): HTMLElement {
    const d = el("div", `wheel-item ${cls}`);
    if (it.swatch) {
      const sw = el("span", "swatch");
      sw.style.background = it.swatch;
      d.append(sw);
    } else d.innerHTML = icons[it.icon] ?? "";
    // (A long word - Transparency, Perpendicular - a size smaller: it stays in one piece.)
    const name = el("span", `wheel-name${label.split(/[\s/]+/).some((w) => w.length > 10) ? " long" : ""}`, label);
    if (width) name.style.width = `${Math.round(width)}px`;
    d.append(name);
    d.style.left = `${(r * Math.cos(a)).toFixed(1)}px`;
    d.style.top = `${(r * Math.sin(a)).toFixed(1)}px`;
    return d;
  }

  /** The whole wheel anew: the middle, the ring, no fan. */
  private draw(): void {
    this.hubEl.setAttribute("r", String(this.m.hub));
    this.grip.innerHTML = this.layout === "settings" ? icons.settings : this.layout === "options" ? icons.options : icons.move;
    this.hot = NONE;
    this.tip.hidden = true;
    this.drawRing();
    this.showFan(-1);
  }

  private drawRing(): void {
    const m = this.m;
    const step = TAU / this.sectors.length;
    // What takes the pointer is a plate under the pieces (the hairlines between them included): a
    // press on a hairline is a press on the wheel, not on the model behind it.
    const plate = document.createElementNS(SVG, "circle");
    plate.setAttribute("class", "wheel-plate");
    plate.setAttribute("r", String((m.r0 + m.r1) / 2));
    plate.setAttribute("stroke-width", String(m.r1 - m.r0 + m.gap));
    this.ringSvg.replaceChildren(plate);
    this.ringItems.replaceChildren();
    this.ringEls = this.sectors.map((s, i) => {
      const mid = this.midOf(i);
      const dim = !s.cells.length && !s.item;
      const p = path(`wheel-cell wheel-sector${dim ? " dim" : ""}${i === 0 && (this.layout === "model" || this.layout === "sketch") ? " own" : ""}${s.on ? " on" : ""}`, wedge(m.r0, m.r1, mid - step / 2, mid + step / 2, 3));
      this.ringSvg.append(p);
      this.ringItems.append(this.item(s, s.label, `sector${dim ? " dim" : ""}${s.mark ? " mark" : ""}${s.on ? " on" : ""}`, (m.r0 + m.r1) / 2 + 1, mid));
      return p;
    });
  }

  /** Fan out a group's tools (-1: none), or the tools of a tool opened inside it. */
  private showFan(i: number, trail: ToolItem[] = []): void {
    this.ringEls[this.openSector]?.classList.remove("open");
    this.ringItems.children[this.openSector]?.classList.remove("open");
    this.fanCount++;
    // (Another row of a cascade added to the same group's fan: only that row comes in.)
    const before = i === this.openSector && i >= 0 ? this.fan.length : 0;
    const deeper = before > 0 && trail.length > this.trail.length;
    this.openSector = i;
    const built = i < 0 ? { fan: [], trail: [] } : this.buildFan(i, trail);
    this.trail = built.trail;
    this.root.classList.toggle("fanned", i >= 0);
    const open = this.ringEls[i];
    if (open) {
      open.classList.add("open");
      this.ringItems.children[i]?.classList.add("open");
      // (Drawn last: its outline whole, over its neighbours'.)
      this.ringSvg.append(open);
    }
    if (this.hot >= CELL) {
      this.hot = NONE;
      this.tip.hidden = true;
    }
    const m = this.m;
    this.fan = built.fan;
    this.fanSvg.replaceChildren();
    this.fanItems.replaceChildren();
    // (A plate under each row takes the pointer, as under the ring.)
    for (const key of new Set(this.fan.map((c) => `${c.level}:${c.r0}`))) {
      const row = this.fan.filter((c) => `${c.level}:${c.r0}` === key);
      const r0 = row[0].r0;
      this.fanSvg.append(path("wheel-plate", wedge(r0 - m.gap / 2, row[0].r1 + m.gap / 2, Math.min(...row.map((c) => c.a0)), Math.max(...row.map((c) => c.a1)), 0)));
    }
    const opened = new Set(this.trail);
    this.fanEls = this.fan.map((c) => {
      const it = c.item;
      const p = path(`wheel-cell${it.active ? " on" : ""}${opened.has(it) ? " open" : ""}`, wedge(c.r0, c.r1, c.a0, c.a1));
      this.fanSvg.append(p);
      const rm = (c.r0 + c.r1) / 2;
      const mid = (c.a0 + c.a1) / 2;
      // The room for its name: the cell's width along the row above and below the wheel, its depth at the sides.
      const up = Math.abs(Math.sin(mid));
      const across = Math.abs(Math.cos(mid));
      const width = (up * (c.a1 - c.a0) * rm + across * (c.r1 - c.r0)) / (up + across) - 4;
      this.fanItems.append(this.item(it, kidsOf(it).length ? `${it.label} ›` : it.label, `${it.active ? "on" : ""}${opened.has(it) ? " open" : ""}${it.pulse ? " mark" : ""}`, rm, mid, width));
      return p;
    });
    // (What's on or open is drawn last: its outline whole, not under its neighbours'.)
    for (const p of this.fanEls) if (p.classList.contains("on") || p.classList.contains("open")) this.fanSvg.append(p);
    if (deeper && !calm()) {
      const grow = [{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "none" }];
      for (let k = before; k < this.fan.length; k++) this.fanEls[k]?.animate(grow, { duration: 90, easing: "ease-out" });
      this.fanItems.querySelectorAll<HTMLElement>(".wheel-item").forEach((d, k) => k >= before && d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90 }));
    } else if (this.fan.length && !calm()) this.fanBox.animate([{ opacity: 0, transform: "scale(0.9)" }, { opacity: 1, transform: "none" }], { duration: 90, easing: "ease-out" });
    if (this.fan.length) this.fit();
    // A kept wheel that slid for the fan goes back to its place once the fan is away.
    else if (this.kept && this.slid && this.up) {
      this.root.classList.add("slide");
      this.rest();
    }
  }

  /** How far the ring with these tools fanned out reaches each way from the middle. */
  private spread(fan: Placed[], e = { l: this.m.r1, r: this.m.r1, t: this.m.r1, b: this.m.r1 }): { l: number; r: number; t: number; b: number } {
    for (const c of fan)
      for (const a of [c.a0, (c.a0 + c.a1) / 2, c.a1]) {
        const x = c.r1 * Math.cos(a);
        const y = c.r1 * Math.sin(a);
        e.l = Math.max(e.l, -x);
        e.r = Math.max(e.r, x);
        e.t = Math.max(e.t, -y);
        e.b = Math.max(e.b, y);
      }
    return e;
  }

  /**
   * A fan that the screen can hold: half a ring where there is room for that.
   * Where there isn't (a phone on its side is too short for nineteen tools
   * down one side), each row is as much of the ring as fits at its distance -
   * the outer rows narrower - and there are more rows, reaching further out.
   */
  private fanFor(cells: Cell[], mid: number, inner = this.m.r1, level = 0): Placed[] {
    if (level === 0) {
      const rays = this.rayFor(cells, mid);
      if (rays) return rays;
    }
    return this.arcFor(cells, mid, inner, level);
  }

  /**
   * A group's tools as rays straight out from it: the first tool right next to
   * the group (where the pointer or finger already is), the next ones further
   * out along the same ray, then rays to either side in turn. As many tools to
   * a ray as the screen holds at that distance (two on a phone, up to four).
   * Null when that would go most of the way round the wheel: then rows.
   */
  private rayFor(cells: Cell[], mid: number): Placed[] | null {
    const N = cells.length;
    if (!N) return [];
    const m = this.m;
    const pitch = m.depth + m.gap;
    const most = Math.max(1, Math.min(4, Math.floor((Math.min(innerWidth, innerHeight) - 12 - 2 * m.r1) / pitch)));
    const L = Math.min(N <= 5 ? N : 4, most);
    const R = Math.ceil(N / L);
    // Each ray as wide as a full cell where it is narrowest (next to the ring).
    const w = m.max / (m.r1 + m.gap + m.depth / 2);
    if (R * w > 1.6 * Math.PI) return null;
    const out: Placed[] = [];
    cells.forEach((c, i) => {
      const ray = Math.floor(i / L);
      const k = i % L;
      // Symmetric about the group: an odd number of rays has the first straight
      // out from it, then one to the clockwise side, one to the other...; an
      // even number has the first two either side of the middle, and so on out.
      const side = R % 2 ? (ray === 0 ? 0 : ray % 2 ? (ray + 1) / 2 : -ray / 2) : ray % 2 ? -(ray + 1) / 2 + 0.5 : ray / 2 + 0.5;
      const a = mid + side * w;
      const r0 = m.r1 + m.gap + k * pitch;
      out.push({ ...c, r0, r1: r0 + m.depth, a0: a - w / 2, a1: a + w / 2, level: 0 });
    });
    return out;
  }

  /** Rows of ring (the cascade's further rows, and a group too big for rays). */
  private arcFor(cells: Cell[], mid: number, inner: number, level: number): Placed[] {
    const W = innerWidth - 12;
    const H = innerHeight - 12;
    const ring = this.m.r1;
    // The widest piece of ring reaching out to R, centred on the group, that the screen holds together with the ring.
    const spanAt = (R: number): number => {
      for (let deg = 180; deg > 40; deg -= 10) {
        const s = (deg * Math.PI) / 180;
        let l = ring;
        let r = ring;
        let t = ring;
        let b = ring;
        for (let k = 0; k <= 16; k++) {
          const a = mid - s / 2 + (s * k) / 16;
          l = Math.max(l, -R * Math.cos(a));
          r = Math.max(r, R * Math.cos(a));
          t = Math.max(t, -R * Math.sin(a));
          b = Math.max(b, R * Math.sin(a));
        }
        if (l + r <= W && t + b <= H) return s;
      }
      return (40 * Math.PI) / 180;
    };
    return fanLayout(cells, mid, this.m, spanAt, inner, level);
  }

  /** How far the wheel reaches each way from its middle, with every group's fan out. */
  private extent(): { l: number; r: number; t: number; b: number } {
    const e = { l: this.m.r1, r: this.m.r1, t: this.m.r1, b: this.m.r1 };
    this.sectors.forEach((s, i) => this.spread(this.fanFor(s.cells, this.midOf(i)), e));
    return e;
  }

  /** How far out the fan reaches. */
  private reach(): number {
    return this.fan.reduce((r, c) => Math.max(r, c.r1), this.m.r1);
  }

  /** A fan that would run off the screen: the wheel slides to bring it on. */
  private fit(): void {
    const e = this.spread(this.fan);
    const M = 6;
    let dx = this.cx + e.r > innerWidth - M ? innerWidth - M - this.cx - e.r : 0;
    if (this.cx - e.l + dx < M) dx = M - this.cx + e.l;
    let dy = this.cy + e.b > innerHeight - M ? innerHeight - M - this.cy - e.b : 0;
    if (this.cy - e.t + dy < M) dy = M - this.cy + e.t;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    this.cx += dx;
    this.cy += dy;
    this.slid = true;
    if (this.up) this.root.classList.add("slide");
    this.place();
    // The pointer stayed put and the wheel moved: what's under it now counts once it moves
    // again - and another group it lands on has to wait a little longer to take the fan.
    this.hold = { x: this.px, y: this.py };
    this.slidAt = performance.now();
  }

  // -------------------------------------------------------------------- tip

  /** The name of what's pointed at (with its second line and key), just outside the wheel there. */
  private say(a: number, r: number, name: string, opts: { sub?: string; key?: string; beta?: boolean; why?: boolean } = {}): void {
    const t = this.tip;
    t.replaceChildren(el("span", "wheel-tip-name", name));
    if (opts.beta) t.append(el("span", "beta-tag", "BETA"));
    if (opts.sub) t.append(el("span", "wheel-tip-sub", opts.sub));
    if (opts.key) t.append(el("kbd", "", opts.key));
    t.classList.toggle("why", !!opts.why);
    t.hidden = false;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = r * c;
    const y = r * s;
    t.style.left = `${Math.round(x)}px`;
    t.style.top = `${Math.round(y)}px`;
    t.style.transform = `translate(${c > 0.4 ? "0" : c < -0.4 ? "-100%" : "-50%"}, ${s > 0.4 ? "0" : s < -0.4 ? "-100%" : "-50%"})`;
    // Kept on the screen (once per thing pointed at, not per move).
    const b = t.getBoundingClientRect();
    const dx = b.left < 6 ? 6 - b.left : b.right > innerWidth - 6 ? innerWidth - 6 - b.right : 0;
    const dy = b.top < 6 ? 6 - b.top : b.bottom > innerHeight - 6 ? innerHeight - 6 - b.bottom : 0;
    if (dx) t.style.left = `${Math.round(x + dx)}px`;
    if (dy) t.style.top = `${Math.round(y + dy)}px`;
  }

  private sayTool(it: ToolItem, a: number, r: number): void {
    this.say(a, r, it.label, { sub: it.sub, key: it.shortcut, beta: it.beta });
  }

  /** What the middle is for, said under the wheel once the pointer rests on it. */
  private sayHub(): void {
    const text = this.isFolded
      ? this.layout === "settings" || this.layout === "options"
        ? `${this.layout === "settings" ? "Settings" : "Options"}: click · drag to move`
        : "Click to unfold · drag to move"
      : !this.kept
        ? "Drag to keep it somewhere · click to close"
        : this.layout === "model"
          ? "Drag to move · click to fold · twice: back at the pointer"
          : "Drag to move · click to fold";
    this.say(Math.PI / 2, (this.isFolded ? this.m.r0 : this.reach()) + 8, text);
  }

  // ---------------------------------------------------------------- pointer

  /** What's at a point of the page: by its distance and direction from the middle (no looking at the page). */
  private hitAt(x: number, y: number): number {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const r = Math.hypot(dx, dy);
    const m = this.m;
    if (r < m.r0) return HUB;
    if (this.isFolded) return NONE;
    const a = Math.atan2(dy, dx);
    if (r <= m.r1 + m.gap / 2) {
      const n = this.sectors.length;
      const step = TAU / n;
      return SECTOR + ((((Math.floor((a + Math.PI / 2 + step / 2) / step) % n) + n) % n));
    }
    for (let i = 0; i < this.fan.length; i++) {
      const c = this.fan[i];
      if (r < c.r0 - m.gap / 2 || r > c.r1 + m.gap / 2) continue;
      if ((((a - c.a0) % TAU) + TAU) % TAU <= c.a1 - c.a0) return CELL + i;
    }
    return NONE;
  }

  private elOf(hit: number): SVGElement | null | undefined {
    return hit === HUB ? this.hubEl : hit >= CELL ? this.fanEls[hit - CELL] : hit >= SECTOR ? this.ringEls[hit - SECTOR] : null;
  }

  private track(x: number, y: number): void {
    this.px = x;
    this.py = y;
    if (this.still) {
      if (Math.hypot(x - this.from.x, y - this.from.y) < 8) return;
      this.still = false;
    }
    if (this.hold) {
      if (Math.hypot(x - this.hold.x, y - this.hold.y) < 10) return;
      this.hold = null;
    }
    const hit = this.hitAt(x, y);
    // (The same thing as before: nothing to do. This runs on every move.)
    if (hit !== this.hot) this.point(hit);
  }

  /** The pointer came onto a group, a tool, the middle - or off them all. */
  private point(hit: number): void {
    // A group's tools are out: the other groups are greyed, and the pointer crossing one on its
    // way to a tool neither lights it nor swaps the fan for it (a tap on it still does).
    const greyed = hit >= SECTOR && hit < CELL && this.openSector >= 0 && hit - SECTOR !== this.openSector;
    this.elOf(this.hot)?.classList.remove("hot");
    this.hot = hit;
    if (!greyed) this.elOf(hit)?.classList.add("hot");
    this.clearTimers();
    if (greyed) return void (this.tip.hidden = true);
    if (hit >= CELL) {
      const c = this.fan[hit - CELL];
      this.sayTool(c.item, (c.a0 + c.a1) / 2, this.reach() + 8);
      if (this.type === "touch") return;
      // Resting on a tool with kinds of its own opens them in a row further out (a tap does at
      // once); resting on another tool of a row whose neighbour is open closes that one's row.
      const drills = opens(c.item) && !c.item.variantsWhenActive && this.trail[c.level] !== c.item;
      const closes = !drills && c.level < this.trail.length && this.trail[c.level] !== c.item;
      if (drills) this.drillTimer = window.setTimeout(() => this.hot === hit && this.drill(hit - CELL, true), 280);
      else if (closes) this.drillTimer = window.setTimeout(() => this.hot === hit && this.collapse(c.level), 280);
      return;
    }
    this.tip.hidden = true;
    if (hit === NONE) {
      // Off a kept wheel: its fan goes away after a moment (one up at the pointer is closed as a whole).
      if (this.kept && this.openSector >= 0 && this.pressed === null) this.leaveTimer = window.setTimeout(() => this.hot === NONE && this.shut(), 500);
      return;
    }
    if (hit === HUB) {
      this.tipTimer = window.setTimeout(() => this.hot === HUB && !this.grab?.moved && this.sayHub(), 700);
      return;
    }
    const i = hit - SECTOR;
    const s = this.sectors[i];
    const mid = this.midOf(i);
    if (!s.cells.length && !s.item) return this.say(mid, this.m.r1 + 8, s.why ?? `${s.label} has nothing here`, { why: true });
    if (s.item) this.sayTool(s.item, mid, this.m.r1 + 8);
    if (i === this.openSector) {
      // Back from a tool's kinds to the group's own list.
      if (this.trail.length) this.showFan(i);
      return;
    }
    const go = () => this.hot === hit && this.showFan(i);
    // Straight away - except from one group's fan to the next: heading across a
    // neighbour for a tool at the far end of the fan mustn't swap the fan away.
    // (Longer just after the wheel slid: the pointer is still on its way to the fan that moved.)
    const slid = performance.now() - this.slidAt < 450;
    if (this.openSector < 0 || (this.pressed !== null && !slid)) go();
    else this.switchTimer = window.setTimeout(go, slid ? 450 : 90);
  }

  /** A tool's own kinds (Plane ›, Colour ›) open in a row outside the one it is in. */
  private drill(index: number, resting: boolean): void {
    const c = this.fan[index];
    if (!c || this.trail[c.level] === c.item) return;
    const hot = this.hot;
    this.showFan(this.openSector, [...this.trail.slice(0, c.level), c.item]);
    // The pointer is still on the tool it opened (the rows before stay put): it stays lit.
    const at = this.fan.findIndex((f) => f.level === c.level && f.item.id === c.item.id);
    if (resting && at >= 0 && hot === CELL + index) {
      this.hot = CELL + at;
      this.elOf(this.hot)?.classList.add("hot");
      this.sayTool(this.fan[at].item, (this.fan[at].a0 + this.fan[at].a1) / 2, this.reach() + 8);
    }
    this.guardUntil = resting ? performance.now() + 260 : 0;
  }

  /** The rows opened beyond this level of the cascade go. */
  private collapse(level: number): void {
    if (this.trail.length <= level) return;
    const hot = this.hot >= CELL ? this.fan[this.hot - CELL] : null;
    this.showFan(this.openSector, this.trail.slice(0, level));
    const at = hot ? this.fan.findIndex((f) => f.level === hot.level && f.item.id === hot.item.id) : -1;
    if (at >= 0) {
      this.hot = CELL + at;
      this.elOf(this.hot)?.classList.add("hot");
      this.sayTool(this.fan[at].item, (this.fan[at].a0 + this.fan[at].a1) / 2, this.reach() + 8);
    }
  }

  /** The tools last run from the model's wheel (ids, newest first): shown under View. */
  private recent: string[] = (() => {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT) ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, RECENT_MAX) : [];
    } catch {
      return [];
    }
  })();

  /** A main tool was run: first among the recent ones. */
  private remember(item: ToolItem): void {
    if (this.kind !== "tools" || this.layout !== "model" || !leaves(this.host.mainTools()).some((t) => t.id === item.id)) return;
    this.recent = [item.id, ...this.recent.filter((x) => x !== item.id)].slice(0, RECENT_MAX);
    try {
      localStorage.setItem(RECENT, JSON.stringify(this.recent));
    } catch {
      // (Not kept: just this visit's.)
    }
  }

  private run(item: ToolItem): void {
    // A switch or a choice on the Settings wheel is set right there: the fan stays, showing it set.
    if (item.id.startsWith("opt-") && !item.id.endsWith("-more")) {
      item.run?.();
      this.itemsChanged();
      return;
    }
    this.close();
    this.remember(item);
    item.run?.();
  }

  /** A tap (or a press let go) on a group or a tool. */
  private activate(hit: number): void {
    if (hit >= CELL) {
      const c = this.fan[hit - CELL];
      if (!c) return;
      // (Tapped again once its kinds are out: they go.)
      if (opens(c.item)) return this.trail[c.level] === c.item ? this.collapse(c.level) : this.drill(hit - CELL, false);
      if (performance.now() < this.guardUntil) return;
      return this.run(c.item);
    }
    const i = hit - SECTOR;
    const s = this.sectors[i];
    if (!s) return;
    if (s.item) return this.run(s.item);
    if (!s.cells.length) return this.say(this.midOf(i), this.m.r1 + 8, s.why ?? `${s.label} has nothing here`, { why: true });
    // A group with one tool, its fan already showing: a tap on the group runs it.
    const only = s.cells.length === 1 ? s.cells[0].item : null;
    if (only && this.openAtPress === i && !this.trail.length && !opens(only)) return this.run(only);
    if (this.openSector !== i || this.trail.length) this.showFan(i);
  }

  /** A tap on the middle: one up at the pointer closes; one kept somewhere folds or unfolds - twice, the model's is let go. */
  private hubTap(): void {
    if (!this.kept) return this.hide();
    const now = performance.now();
    if (this.layout === "model" && now - this.hubTapAt < 400) return this.letGo();
    this.hubTapAt = now;
    this.fold(!this.isFolded);
  }

  private onDown = (e: PointerEvent): void => {
    // (Typing a value: a press in its box, or on the numpad, is for that.)
    if (this.typer && ((e.target as Element).closest?.(".wheel-type, .numpad") ?? null)) return;
    if (!this.up) {
      this.dismissed = false;
      return;
    }
    // On the wheel, by where the press is (the same sums as for pointing; the pieces can still be
    // sliding or growing into place on the page) - unless something lying over the wheel was pressed.
    const hit = this.hitAt(e.clientX, e.clientY);
    const target = e.target as Element;
    const onView = target.tagName === "CANVAS";
    const mine = hit !== NONE && (this.root.contains(target) || onView);
    const through = this.fresh === "all" || (this.fresh === "hub" && hit === HUB);
    if (!mine || through) {
      if (!this.kept) {
        // A press anywhere else closes it, and goes on to what was pressed (the model: a tap picks, a drag turns the view).
        this.dismissed = true;
        this.hide();
        return;
      }
      // Kept somewhere, it stays: the press only puts its fan away. A finger's is spent on that
      // (nothing hovers a fan away for a finger, and a tap meant to close it would draw a point).
      if (this.openSector < 0) return;
      this.shut();
      if (e.pointerType === "touch" && onView) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return this.close();
    this.type = e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse";
    this.pressed = e.pointerId;
    this.adopt = this.adopted = false;
    this.still = false;
    this.hold = null;
    this.openAtPress = this.openSector;
    this.pressHit = hit;
    this.pressFan = this.fanCount;
    this.pressAt = { x: e.clientX, y: e.clientY };
    // The middle is the handle: the wheel goes with a press that moves; one that doesn't is a tap on it.
    this.grab = hit === HUB ? { dx: e.clientX - this.cx, dy: e.clientY - this.cy, moved: false } : null;
    this.track(e.clientX, e.clientY);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.up) return;
    const g = this.grab;
    if (g && this.pressed === e.pointerId) {
      if (!g.moved) {
        if (Math.hypot(e.clientX - this.pressAt.x, e.clientY - this.pressAt.y) < 6) return;
        g.moved = true;
        this.shut();
        this.unpoint();
        this.root.classList.remove("slide");
        this.root.classList.add("dragging");
      }
      this.home = { x: e.clientX - g.dx, y: e.clientY - g.dy };
      this.rest();
      return;
    }
    if (this.adopt && e.pointerType !== "mouse") {
      this.adopt = false;
      this.adopted = true;
      this.pressed = e.pointerId;
      this.openAtPress = this.openSector;
    }
    // (A finger only counts while it is down on the wheel.)
    if (e.pointerType === "touch") {
      if (this.pressed !== e.pointerId) return;
    } else this.type = e.pointerType === "pen" ? "pen" : "mouse";
    this.track(e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.up) return;
    // Lifted where it was held: the wheel stays up, as after a tap.
    if (this.adopt && e.pointerType !== "mouse") return void (this.adopt = false);
    if (this.pressed !== e.pointerId) return;
    this.pressed = null;
    const g = this.grab;
    this.grab = null;
    if (g) {
      e.preventDefault();
      this.root.classList.remove("dragging");
      if (g.moved) this.drop();
      else this.hubTap();
      return;
    }
    // A tap is for what it came down on (a group tapped near the screen's edge slides the
    // wheel to fit its fan - what's under the finger then is not what was tapped); a press
    // that slid somewhere is for where it was let go.
    const tap = !this.adopted && Math.hypot(e.clientX - this.pressAt.x, e.clientY - this.pressAt.y) < 10;
    const hit = tap ? this.pressHit : this.hitAt(e.clientX, e.clientY);
    if (hit === NONE || hit === HUB) return;
    if (tap && hit >= CELL && this.pressFan !== this.fanCount) return;
    // (Not kept from the view: a finger that came down on it, and was held for the wheel, is let go of there too.)
    e.preventDefault();
    this.activate(hit);
  };

  private onCancel = (e: PointerEvent): void => {
    if (this.pressed === e.pointerId) {
      this.pressed = null;
      if (this.grab?.moved) this.drop();
      this.grab = null;
      this.root.classList.remove("dragging");
    }
    this.adopt = false;
  };

  private onKey = (e: KeyboardEvent): void => {
    if (!this.up || e.key !== "Escape") return;
    // (Typing a value: Esc is the box's, it leaves the value as it was.)
    if (this.typer) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.typerEnd?.(false);
      return;
    }
    // Esc closes the wheel only (kept somewhere: its fan), and what's picked stays picked. With no fan out, Esc is the app's.
    if (this.kept && this.openSector < 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close();
  };

  // ------------------------------------------------------------ for checking

  /** Every tool the wheel offers now, by where it is ("Tools › Fillet"), whether it is up or not. */
  tools(): { id: string; label: string; path: string }[] {
    const { sectors } = this.up ? { sectors: this.sectors } : this.content();
    const out: { id: string; label: string; path: string }[] = [];
    const walk = (it: ToolItem, path: string[]) => {
      const here = [...path, it.label];
      const kids = kidsOf(it);
      if (it.run) out.push({ id: it.id, label: it.label, path: here.join(" › ") });
      for (const k of kids) walk(k, here);
    };
    for (const s of sectors) {
      if (s.item) walk(s.item, []);
      for (const c of s.cells) walk(c.item, [s.label]);
    }
    return out;
  }

  /** The wheel as it is now: where its middle, each group and each fanned-out tool is on the page (to point and tap at). */
  describe() {
    const at = (r: number, a: number) => ({ x: Math.round(this.cx + r * Math.cos(a)), y: Math.round(this.cy + r * Math.sin(a)) });
    const m = this.m;
    return {
      on: this.on,
      open: this.up,
      layout: this.layout,
      kept: this.kept,
      ...(this.up
        ? {
            folded: this.isFolded,
            center: { x: Math.round(this.cx), y: Math.round(this.cy) },
            group: this.sectors[this.openSector]?.id ?? null,
            inside: this.trail.map((t) => t.label),
            sectors: this.sectors.map((s, i) => ({
              id: s.id,
              label: s.label,
              ...at((m.r0 + m.r1) / 2, this.midOf(i)),
              ...(s.item ? { runs: s.item.label } : {}),
              ...(s.on ? { inUse: true } : {}),
              ...(s.cells.length || s.item ? {} : { off: s.why }),
              tools: s.cells.map((c) => c.item.label + (c.item.active ? " *" : "")),
            })),
            fan: this.fan.map((c) => ({ id: c.item.id, label: c.item.label, ...at((c.r0 + c.r1) / 2, (c.a0 + c.a1) / 2), ...(c.item.active ? { inUse: true } : {}), ...(kidsOf(c.item).length ? { opens: kidsOf(c.item).map((k) => k.label) } : {}) })),
            tip: this.tip.hidden ? null : this.tip.textContent,
          }
        : {}),
    };
  }
}
