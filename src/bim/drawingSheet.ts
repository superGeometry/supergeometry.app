// Drawings: the model on a sheet of paper, the way a workshop or a site reads
// it. Orthographic views (front, top, side) in first-angle (ISO, the default)
// or third-angle projection, an isometric view, dimensions, balloons with the
// item numbers of the technical sheet's parts list, that parts list, and a
// title block inside a frame with grid zones (ISO 5457, ISO 7200). The views
// are the solids themselves, hidden lines found by the kernel - not a picture
// of the screen - so the sheet is at a true scale and prints as one.
//
// The drawing and the technical sheet are the two halves of one document: the
// balloons here and the rows there share their item numbers.
//
// This file makes the sheet (SVG, mm); drawing.ts shows it and edits it.

import type { DrawingDetail, DrawingDim, DrawingImage, DrawingMark, DrawingNote, DrawingOptions, DrawingSection, DrawingView, ProjectDoc, ProjectInfo, ViewOrient } from "../doc/types";
import type { ProjectedView, ViewSpec } from "../kernel/protocol";
import { trim, UNIT_MM, units } from "../units";
import { fmtMass } from "./materials";
import type { PartRow } from "./sheet";

/** Paper sizes, landscape, mm (ISO 216 and ANSI). */
export const SHEETS: Record<NonNullable<DrawingOptions["size"]>, [number, number]> = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
  "ANSI A": [279.4, 215.9],
  "ANSI B": [431.8, 279.4],
  "ANSI C": [558.8, 431.8],
  "ANSI D": [863.6, 558.8],
  "ANSI E": [1117.6, 863.6],
};
export type SheetSize = keyof typeof SHEETS;

/** Every scale offered, largest first. */
export const SCALES = [
  10, 5, 4, 3, 2, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8, 1 / 9, 1 / 10, 1 / 12, 1 / 16, 1 / 20, 1 / 25, 1 / 32, 1 / 40, 1 / 50, 1 / 75, 1 / 100, 1 / 200,
  1 / 500, 1 / 1000, 1 / 2000, 1 / 5000,
];
/** The standard ones (ISO 5455), which the automatic scale picks from. */
export const AUTO_SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000, 1 / 2000, 1 / 5000];

export const scaleLabel = (s: number) => (s >= 1 ? `${trim(s, 3)}:1` : `1:${trim(1 / s, 3)}`);

/** The views the kernel draws: Z is up in the model. */
export const VIEW_SPECS: ViewSpec[] = [
  { id: "front", dir: [0, -1, 0], xAxis: [1, 0, 0] },
  { id: "top", dir: [0, 0, 1], xAxis: [1, 0, 0] },
  // Seen from the left (first angle puts it on the right of the front view).
  { id: "left", dir: [-1, 0, 0], xAxis: [0, -1, 0] },
  // Seen from the right (third angle puts it on the right).
  { id: "right", dir: [1, 0, 0], xAxis: [0, 1, 0] },
  { id: "iso", dir: [1, -1, 1], xAxis: [1, 1, 0] },
];

export const VIEW_NAMES: Record<string, string> = { front: "Front view", top: "Top view", left: "Side view", right: "Side view", iso: "Isometric view" };

/** The options, with their defaults. */
export function drawingOptions(doc: ProjectDoc) {
  const o: DrawingOptions = doc.drawing ?? {};
  const appUnits = units();
  return {
    title: o.title ?? (doc.name || "Untitled"),
    size: (o.size ?? "A3") as SheetSize,
    portrait: o.portrait ?? false,
    angle: o.angle ?? "first",
    scale: o.scale,
    hidden: o.hidden ?? true,
    views: { front: o.views?.front ?? true, top: o.views?.top ?? true, side: o.views?.side ?? true, iso: o.views?.iso ?? o.iso ?? true },
    bodies: o.bodies,
    titleBlock: o.titleBlock ?? "table",
    dateFormat: o.dateFormat ?? "iso",
    units: o.units ?? (appUnits === "ft" ? "in" : appUnits),
    precision: o.precision ?? 2,
    anglePrecision: o.anglePrecision ?? 1,
    comma: o.comma ?? false,
    lines: { visible: o.lines?.visible ?? 0.5, hidden: o.lines?.hidden ?? 0.25, dims: o.lines?.dims ?? 0.25, center: o.lines?.center ?? 0.25, section: o.lines?.section ?? 0.18 },
    balloons: o.balloons ?? true,
    overall: o.overall ?? true,
    overallDims: o.overallDims ?? {},
    moved: o.moved ?? {},
    dims: o.dims ?? [],
    notes: o.notes ?? [],
    sections: o.sections ?? [],
    details: o.details ?? [],
    marks: o.marks ?? [],
    extra: o.extra ?? [],
    isoScale: o.isoScale,
    images: o.images ?? [],
  };
}
export type Opts = ReturnType<typeof drawingOptions>;

/** The paper, as it lies (portrait: turned). */
export function sheetSize(o: Opts): [number, number] {
  const [w, h] = SHEETS[o.size];
  return o.portrait ? [h, w] : [w, h];
}

/** A length (mm) as the drawing writes it: its units, its decimals (no trailing zeros), its decimal mark. */
export function lengthText(mm: number, o: Opts): string {
  const v = mm / UNIT_MM[o.units];
  let t = v.toFixed(o.precision);
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  if (t === "-0") t = "0";
  return o.comma ? t.replace(".", ",") : t;
}

/** An angle (radians) as the drawing writes it: degrees, its decimals, its decimal mark. */
export function angleText(rad: number, o: Opts): string {
  let t = ((Math.abs(rad) * 180) / Math.PI).toFixed(o.anglePrecision);
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  return `${o.comma ? t.replace(".", ",") : t}°`;
}

// ---- Section and detail views

type V3 = [number, number, number];
const v3 = {
  mul: (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k],
  sub: (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit: (a: V3): V3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

/** The way a section view sits from its view, on the paper: where its arrows point (first angle), the other way (third angle). */
export const placeDir = (sec: DrawingSection, o: Opts): [number, number] => (o.angle === "first" ? sec.look : [-sec.look[0], -sec.look[1]]);

/** What a view is (a base view, a section of one, a view added by hand); null for one it can't say, or an isometric one (nothing is cut or projected square from those). */
export function specOf(id: string, o: Opts, depth = 0): ViewSpec | null {
  const base = VIEW_SPECS.find((v) => v.id === id);
  if (base) return id === "iso" ? null : base;
  if (depth >= 8) return null;
  const sec = o.sections.find((x) => x.id === id);
  if (sec) return sectionSpec(sec, o, depth + 1);
  const ex = o.extra.find((x) => x.id === id);
  return ex && !isIsoView(ex) ? extraSpec(ex, o, depth + 1) : null;
}

/** The ways a base view can look: towards the eye from the model (Z up), and the paper's x. */
export const ORIENTS: Record<ViewOrient, { dir: V3; xAxis: V3; name: string }> = {
  front: { dir: [0, -1, 0], xAxis: [1, 0, 0], name: "Front" },
  back: { dir: [0, 1, 0], xAxis: [-1, 0, 0], name: "Back" },
  top: { dir: [0, 0, 1], xAxis: [1, 0, 0], name: "Top" },
  bottom: { dir: [0, 0, -1], xAxis: [1, 0, 0], name: "Bottom" },
  left: { dir: [-1, 0, 0], xAxis: [0, -1, 0], name: "Left" },
  right: { dir: [1, 0, 0], xAxis: [0, 1, 0], name: "Right" },
  "iso-fr": { dir: [1, -1, 1], xAxis: [1, 1, 0], name: "Isometric – Front Right" },
  "iso-fl": { dir: [-1, -1, 1], xAxis: [1, -1, 0], name: "Isometric – Front Left" },
  "iso-br": { dir: [1, 1, 1], xAxis: [-1, 1, 0], name: "Isometric – Back Right" },
  "iso-bl": { dir: [-1, 1, 1], xAxis: [-1, -1, 0], name: "Isometric – Back Left" },
};

/** An added view seen from a corner: a base view of an isometric corner, or one projected to a corner of its view. */
export const isIsoView = (v: DrawingView) => (v.orient ? v.orient.startsWith("iso") : !!(v.dir && v.dir[0] && v.dir[1]));

/**
 * An added view's direction. A base view: its own. A projection square on (a
 * side of its view): first angle puts the view from the other side there,
 * third angle the view from that side, lined up with its view the way the
 * standard views are. A projection to a corner: the isometric view from that
 * corner of its view (front view, up and right: from the front, right, top).
 */
export function extraSpec(v: DrawingView, o: Opts, depth = 0): ViewSpec | null {
  if (v.orient) {
    const r = ORIENTS[v.orient];
    return r ? { id: v.id, dir: r.dir, xAxis: r.xAxis } : null;
  }
  if (!v.view || !v.dir || (!v.dir[0] && !v.dir[1])) return null;
  const parent = specOf(v.view, o, depth);
  if (!parent) return null;
  const d = v3.unit(parent.dir as V3);
  const X = v3.unit(parent.xAxis as V3);
  const Y = v3.cross(d, X);
  const [p0, p1] = [Math.sign(v.dir[0]), Math.sign(v.dir[1])];
  const P3 = v3.sub(v3.mul(X, p0), v3.mul(Y, p1));
  if (p0 && p1) {
    const dir = v3.unit([d[0] + P3[0], d[1] + P3[1], d[2] + P3[2]]);
    return { id: v.id, dir, xAxis: v3.unit(v3.cross(Y, dir)) };
  }
  const dir = o.angle === "first" ? v3.mul(P3, -1) : P3;
  return { id: v.id, dir, xAxis: p1 ? X : v3.cross(Y, dir) };
}

/** What an added view is called on the sheet: the side it shows ("Back view"), or isometric. */
export function extraName(v: DrawingView, o: Opts): string {
  if (isIsoView(v)) return "Isometric view";
  const sp = extraSpec(v, o);
  if (!sp) return "View";
  const d = v3.unit(sp.dir as V3);
  for (const k of ["front", "back", "top", "bottom", "left", "right"] as ViewOrient[]) {
    const r = ORIENTS[k].dir;
    if (d[0] * r[0] + d[1] * r[1] + d[2] * r[2] > 0.9999) return `${ORIENTS[k].name} view`;
  }
  return "View";
}

/** Every view the sheet asks the kernel for, past the standard ones: sections, then the added views. */
export function extraSpecs(o: Opts): ViewSpec[] {
  return [...o.sections.map((s) => sectionSpec(s, o)), ...o.extra.map((v) => extraSpec(v, o))].filter((v): v is ViewSpec => !!v);
}

/**
 * A section view's direction and cut: looking along its arrows, square to the
 * cut line, turned so that it lines up with the view it is cut from (along
 * the line) - the way a projected view lines up.
 */
export function sectionSpec(sec: DrawingSection, o: Opts, depth = 0): ViewSpec | null {
  const parent = specOf(sec.view, o, depth);
  if (!parent) return null;
  const d = v3.unit(parent.dir as V3);
  const X = v3.unit(parent.xAxis as V3);
  const Y = v3.cross(d, X);
  const to3 = (q: [number, number]): V3 => v3.sub(v3.mul(X, q[0]), v3.mul(Y, q[1]));
  const L = Math.hypot(sec.b[0] - sec.a[0], sec.b[1] - sec.a[1]);
  if (L < 1e-9) return null;
  const u: [number, number] = [(sec.b[0] - sec.a[0]) / L, (sec.b[1] - sec.a[1]) / L];
  const dir = v3.mul(to3(sec.look), -1);
  const pl = placeDir(sec, o);
  let xAxis: V3;
  if (Math.abs(pl[1]) >= Math.abs(pl[0])) xAxis = to3(u[0] < 0 ? [-u[0], -u[1]] : u);
  else xAxis = v3.cross(v3.mul(to3(u[1] < 0 ? [-u[0], -u[1]] : u), -1), dir);
  return { id: sec.id, dir, xAxis, cut: to3(sec.a) };
}

/** The next free letter for a section or a detail (I, O and Q are left out: they read as numbers). */
export function nextLetter(o: Opts): string {
  const used = new Set([...o.sections.map((x) => x.letter), ...o.details.map((x) => x.letter)]);
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ".split("");
  for (let n = 1; ; n++) for (const l of letters) if (!used.has(l.repeat(n))) return l.repeat(n);
}

export function dateText(d: Date, f: Opts["dateFormat"]): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  if (f === "dmy") return `${dd}/${mm}/${yy}`;
  if (f === "mdy") return `${mm}/${dd}/${yy}`;
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---- Layout (all in mm on the paper)

const FRAME_L = 20;
const FRAME = 10;
/** Title block: ISO 7200 width. */
export const TB_W = 180;
const TB_H = 36;
const ROW = 6;
/** Room for dimensions around the orthographic views, and between them. */
const DIM = 14;
const GAP = 22;
/** Room for balloons around the isometric view. */
const ISO_PAD = 16;

type Box = [[number, number], [number, number]];
const bw = (b: Box | null) => (b ? b[1][0] - b[0][0] : 0);
const bh = (b: Box | null) => (b ? b[1][1] - b[0][1] : 0);

export interface Placed {
  id: string;
  /** An isometric view (no hidden lines, nothing measured on it). */
  iso?: boolean;
  /** The drawn view its lines come from (a detail's: its view's), if not its own. */
  src?: string;
  /** A detail: the circle it is cut to, on the paper. */
  clip?: { c: [number, number]; r: number };
  /** Where the view's box corner (lowest x, lowest y) goes on the paper. */
  x: number;
  y: number;
  s: number;
  box: Box;
}

export interface Layout {
  W: number;
  H: number;
  scale: number;
  /** Scale of the isometric view (it may be smaller than the others). */
  isoScale?: number;
  views: Placed[];
  /** The side view used: "left" (first angle) or "right" (third angle). */
  side: "left" | "right";
  /** Every view inside the frame, off the title block (a scale too big, or moved off it, doesn't). */
  fits: boolean;
}

/** Where a view's point (its own mm) is on the paper, and back. */
export const toPaper = (p: Placed, q: [number, number]): [number, number] => [p.x + (q[0] - p.box[0][0]) * p.s, p.y + (q[1] - p.box[0][1]) * p.s];
export const fromPaper = (p: Placed, q: [number, number]): [number, number] => [p.box[0][0] + (q[0] - p.x) / p.s, p.box[0][1] + (q[1] - p.y) / p.s];

/** The paper a placed view takes: its box, or a detail's circle. */
export function extent(p: Placed): { x0: number; y0: number; x1: number; y1: number } {
  if (p.clip) return { x0: p.clip.c[0] - p.clip.r, y0: p.clip.c[1] - p.clip.r, x1: p.clip.c[0] + p.clip.r, y1: p.clip.c[1] + p.clip.r };
  return { x0: p.x, y0: p.y, x1: p.x + bw(p.box) * p.s, y1: p.y + bh(p.box) * p.s };
}

/** Where each view goes, and at which scale: the largest standard scale at which they fit. Views moved by hand stay moved. */
export function layoutSheet(views: Map<string, ProjectedView>, o: Opts, parts: number): Layout {
  const [W, H] = sheetSize(o);
  const R = W - FRAME;
  const B = H - FRAME;
  const T = FRAME;
  const blockH = o.titleBlock === "table" ? TB_H + (parts ? ROW * (listRows(parts, H) + 1) : 0) + 2 : o.titleBlock === "simple" ? TB_H + 2 : 0;
  const corner = { x0: R - TB_W, y0: B - blockH };
  const side = o.angle === "first" ? "left" : "right";
  const first = o.angle === "first";
  const box = (id: string) => views.get(id)?.box ?? null;
  const front = o.views.front ? box("front") : null;
  const top = o.views.top ? box("top") : null;
  const sideBox = o.views.side ? box(side) : null;
  const iso = o.views.iso ? box("iso") : null;
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const cornerRect: Rect = { x0: corner.x0, y0: corner.y0, x1: R, y1: B };
  // The orthographic views share their sizes: width with the top view, height with the side view.
  const W_ = bw(front ?? top ?? box("front"));
  const H_ = bh(front ?? sideBox ?? box("front"));
  const D_ = bh(top) || bw(sideBox);

  /** The orthographic views at scale s: each placed, and the room it takes (with its dimensions). */
  const ortho = (s: number) => {
    const x0 = FRAME_L + DIM;
    const y0 = T + (first ? DIM : 3);
    const fw = W_ * s;
    const fh = H_ * s;
    const th = D_ * s;
    const fy = top && !first ? y0 + th + GAP : y0;
    const ty = first ? y0 + (front || sideBox ? fh + GAP : 0) : y0;
    const sx = x0 + (front || top ? fw + GAP : 0);
    const out: { id: string; box: Box; x: number; y: number; room: Rect }[] = [];
    const dimTop = first ? DIM : 3;
    const dimBottom = first ? 3 : DIM;
    if (front) out.push({ id: "front", box: front, x: x0, y: fy, room: { x0: x0 - DIM, y0: fy - dimTop, x1: x0 + fw + 3, y1: fy + fh + dimBottom } });
    if (sideBox) out.push({ id: side, box: sideBox, x: sx, y: fy, room: { x0: sx - 3, y0: fy - dimTop, x1: sx + bw(sideBox) * s + 3, y1: fy + bh(sideBox) * s + dimBottom } });
    if (top) out.push({ id: "top", box: top, x: x0, y: ty, room: { x0: x0 - 3, y0: ty - 3, x1: x0 + fw + 3, y1: ty + th + 3 } });
    return out;
  };
  const orthoFits = (s: number) => ortho(s).every((v) => v.room.x1 <= R && v.room.y1 <= B && !overlaps(v.room, cornerRect));

  /** Free places for the isometric view, beside the orthographic ones. */
  const isoRooms = (s: number): Rect[] => {
    const vs = ortho(s);
    if (!vs.length) return [{ x0: FRAME_L, y0: T, x1: R, y1: corner.y0 }];
    const right = Math.max(...vs.map((v) => v.room.x1));
    const bottom = Math.max(...vs.map((v) => v.room.y1));
    const f = vs.find((v) => v.id === "front")?.room;
    const sd = vs.find((v) => v.id === side)?.room;
    const rooms: Rect[] = [{ x0: right, y0: T, x1: R, y1: corner.y0 }];
    // The quadrant the projection leaves empty: below the side view (first angle), above it (third angle).
    if (f && sd) rooms.push(first ? { x0: sd.x0, y0: f.y1, x1: R, y1: corner.y0 } : { x0: sd.x0, y0: T, x1: R, y1: f.y0 });
    // Below them all, left of the title block.
    rooms.push({ x0: FRAME_L, y0: bottom, x1: blockH ? corner.x0 : R, y1: B });
    return rooms.filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  };
  const isoFor = (s: number, least: number): { si: number; room: Rect } | undefined => {
    if (!iso) return undefined;
    const rooms = isoRooms(s);
    for (const si of AUTO_SCALES) {
      if (si > s || si < s * least) continue;
      const room = rooms.find((r) => bw(iso) * si + 2 * ISO_PAD <= r.x1 - r.x0 && bh(iso) * si + 2 * ISO_PAD + 5 <= r.y1 - r.y0);
      if (room) return { si, room };
    }
    return undefined;
  };
  let scale = o.scale;
  if (!scale) {
    // The largest scale the views fit at, with the isometric one no smaller than a fifth of it if it can be.
    // A standard one, unless the next standard one down is far smaller than one
    // in between (1:5 where 1:3 fits leaves most of the sheet empty).
    const ok = (s: number) => (front || top || sideBox ? orthoFits(s) : !!isoFor(s, 1));
    const best = (list: number[]) => list.find((s) => ok(s) && (!iso || o.isoScale || isoFor(s, 1 / 5)));
    const std = best(AUTO_SCALES);
    const any = best(SCALES);
    scale = (std && (!any || std >= any * 0.7) ? std : any) ?? AUTO_SCALES.find(ok) ?? AUTO_SCALES[AUTO_SCALES.length - 1];
  }
  const s = scale;
  const placed: Placed[] = ortho(s).map((v) => ({ id: v.id, x: v.x, y: v.y, s, box: v.box }));
  // The isometric view at the scale it was given (where it fits, if it does), or the largest that fits.
  const given = o.isoScale;
  const isoAt =
    iso && given
      ? { si: given, room: isoRooms(s).find((r) => bw(iso) * given + 2 * ISO_PAD <= r.x1 - r.x0 && bh(iso) * given + 2 * ISO_PAD + 5 <= r.y1 - r.y0) ?? isoRooms(s)[0] ?? { x0: FRAME_L, y0: T, x1: R, y1: B } }
      : (isoFor(s, 1 / 20) ?? (iso ? { si: s, room: { x0: FRAME_L, y0: T, x1: R, y1: B } } : undefined));
  if (iso && isoAt) {
    const { si, room } = isoAt;
    placed.push({ id: "iso", iso: true, x: (room.x0 + room.x1 - bw(iso) * si) / 2, y: (room.y0 + room.y1 - bh(iso) * si - 5) / 2, s: si, box: iso });
  }
  // Moved by hand: the front view takes the projected ones along; they move only along their line with it.
  const m = (k: string) => o.moved[k] ?? [0, 0];
  for (const p of placed) {
    const [gx, gy] = p.id === "iso" ? [0, 0] : m("front");
    const [ox, oy] = p.id === "iso" ? m("iso") : p.id === "top" ? [0, m("top")[1]] : p.id === side ? [m("side")[0], 0] : [0, 0];
    p.x += gx + ox;
    p.y += gy + oy;
  }
  // Base views added by hand: where they were put, at their own scale.
  const centred = (id: string, box: Box, at: [number, number], sc: number, isoView: boolean): Placed => ({ id, iso: isoView || undefined, x: at[0] - (bw(box) * sc) / 2, y: at[1] - (bh(box) * sc) / 2, s: sc, box });
  for (const v of o.extra) {
    const box = views.get(v.id)?.box;
    if (v.orient && box) placed.push(centred(v.id, box, v.at ?? [(FRAME_L + R) / 2, (T + B) / 2], v.scale ?? s, isIsoView(v)));
  }
  // Sections and projections, each lined up with its view, as far off it as it
  // was put (`gap`: from its view's edge to its middle - never so little that it
  // would lie on its view, or a section on its arrows); a projection to a
  // corner where it was put.
  const aligned = (p: Placed, box: Box, pl: [number, number], gap: number, least: number): [number, number] => {
    const w = bw(box) * p.s;
    const h = bh(box) * p.s;
    const pr = extent(p);
    if (Math.abs(pl[1]) >= Math.abs(pl[0])) {
      const g = Math.max(gap, h / 2 + least);
      return [p.x + (box[0][0] - p.box[0][0]) * p.s, pl[1] > 0 ? pr.y1 + g - h / 2 : pr.y0 - g - h / 2];
    }
    const g = Math.max(gap, w / 2 + least);
    return [pl[0] > 0 ? pr.x1 + g - w / 2 : pr.x0 - g - w / 2, p.y + (box[0][1] - p.box[0][1]) * p.s];
  };
  type Waiting = { id: string; view: string; place: (p: Placed, box: Box) => Placed };
  const waiting: Waiting[] = [
    ...o.sections.map((sec) => ({ id: sec.id, view: sec.view, place: (p: Placed, box: Box) => ({ id: sec.id, ...xy(aligned(p, box, placeDir(sec, o), sec.gap, 16)), s: p.s, box }) })),
    ...o.extra
      .filter((v) => !v.orient && v.view && v.dir)
      .map((v) => ({
        id: v.id,
        view: v.view!,
        place: (p: Placed, box: Box): Placed => {
          if (isIsoView(v)) {
            const pr = extent(p);
            const sc = v.scale ?? p.s;
            const at = v.at ?? [(pr.x0 + pr.x1) / 2 + Math.sign(v.dir![0]) * ((pr.x1 - pr.x0) / 2 + (bw(box) * sc) / 2 + 20), (pr.y0 + pr.y1) / 2 + Math.sign(v.dir![1]) * ((pr.y1 - pr.y0) / 2 + (bh(box) * sc) / 2 + 20)];
            return centred(v.id, box, at, sc, true);
          }
          return { id: v.id, ...xy(aligned(p, box, v.dir!, v.gap ?? 0, 8)), s: p.s, box };
        },
      })),
  ];
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < waiting.length; i++) {
      const w = waiting[i];
      const p = placed.find((x) => x.id === w.view);
      const box = views.get(w.id)?.box;
      if (!p || !box || p.clip) continue;
      waiting.splice(i--, 1);
      grew = true;
      placed.push(w.place(p, box));
    }
  }
  // Details: a circle of their view, bigger, where they were put.
  for (const det of o.details) {
    const p = placed.find((x) => x.id === det.view);
    if (!p || p.clip) continue;
    const sd = det.scale ?? p.s * 2;
    placed.push({ id: det.id, src: p.src ?? p.id, x: det.at[0] - (det.c[0] - p.box[0][0]) * sd, y: det.at[1] - (det.c[1] - p.box[0][1]) * sd, s: sd, box: p.box, clip: { c: det.at, r: det.r * sd } });
  }
  const e = 0.01;
  const fits = placed.every((p) => {
    const r = extent(p);
    return r.x0 >= FRAME_L - e && r.y0 >= T - e && r.x1 <= R + e && r.y1 <= B + e && !(blockH && overlaps(r, { x0: cornerRect.x0 + e, y0: cornerRect.y0 + e, x1: R, y1: B }));
  });
  return { W, H, scale: s, isoScale: isoAt?.si, views: placed, side, fits };
}

const xy = (q: [number, number]) => ({ x: q[0], y: q[1] });

/**
 * How many rows the parts list on the sheet has: all the parts, or - when
 * they would take more than half the sheet's height - as many as fit, the
 * last one saying how many more there are (the technical sheet lists them all).
 */
export function listRows(parts: number, H: number): number {
  const most = Math.max(2, Math.floor(((H - 2 * FRAME) * 0.5 - TB_H) / ROW) - 1);
  return Math.min(parts, most);
}

/** The key a view's hand move is kept under. */
export const moveKey = (id: string) => (id === "left" || id === "right" ? "side" : id);

// ---- Drawing the sheet (SVG, mm)

const f = (n: number) => String(Math.round(n * 100) / 100);
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = `font-family="Arial, Helvetica, sans-serif"`;
const SEL = "#1a73e8";

/**
 * A path from the kernel (mm, at 1:1) moved to its place on the paper. Kept
 * for the place it was last put at: dragging a note or a dimension redraws
 * the sheet each move, with the views where they were.
 */
const placedPaths = new Map<string, { at: string; d: string }>();
function placePath(d: string, p: Placed): string {
  const at = `${p.x} ${p.y} ${p.s} ${p.box[0][0]} ${p.box[0][1]}`;
  const had = placedPaths.get(d);
  if (had?.at === at) return had.d;
  const out = d.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, c: string, x: string, y: string) => `${c}${f(p.x + (Number(x) - p.box[0][0]) * p.s)} ${f(p.y + (Number(y) - p.box[0][1]) * p.s)}`);
  // (A few hundred paths at most on a sheet: dropped all at once past that.)
  if (placedPaths.size > 2000) placedPaths.clear();
  placedPaths.set(d, { at, d: out });
  return out;
}

function text(x: number, y: number, t: string, size: number, opts: { anchor?: string; angle?: number; weight?: string; fill?: string } = {}): string {
  const rot = opts.angle ? ` transform="rotate(${f(opts.angle)} ${f(x)} ${f(y)})"` : "";
  return `<text x="${f(x)}" y="${f(y)}" font-size="${size}" ${FONT} text-anchor="${opts.anchor ?? "start"}"${opts.weight ? ` font-weight="${opts.weight}"` : ""} fill="${opts.fill ?? "#000"}"${rot}>${esc(t)}</text>`;
}

/** A rough width of a text (Arial: about 0.55 of its size a letter). */
const textWidth = (t: string, size: number) => t.length * size * 0.55;

/** A dimension's text: its value (`main`); a tolerance stacked after it (`up` over `down`), then `tail`; `boxed`: a basic size. */
export interface DimLabel {
  main: string;
  up?: string;
  down?: string;
  tail?: string;
  boxed?: boolean;
}
const labelOf = (l: string | DimLabel): DimLabel => (typeof l === "string" ? { main: l } : l);
const labelWidth = (l: DimLabel, size: number) =>
  textWidth(l.main, size) + (l.up || l.down ? Math.max(textWidth(l.up ?? "", size * 0.7), textWidth(l.down ?? "", size * 0.7)) + 0.8 : 0) + textWidth(l.tail ?? "", size);

/** A dimension's text, its middle at (x, y) (its baseline), turned `angle` degrees. */
function labelSVG(x: number, y: number, label: string | DimLabel, size: number, color: string, angle = 0): string {
  const l = labelOf(label);
  if (!l.up && !l.down && !l.boxed && !l.tail) return text(x, y, l.main, size, { anchor: "middle", angle, fill: color });
  const w = labelWidth(l, size);
  const x0 = x - w / 2;
  const wm = textWidth(l.main, size);
  let out = l.main ? text(x0, y, l.main, size, { fill: color }) : "";
  if (l.boxed) out += `<rect x="${f(x0 - 0.8)}" y="${f(y - size * 0.9)}" width="${f(wm + 1.6)}" height="${f(size * 1.2)}" stroke="${color}" stroke-width="0.25" fill="none"/>`;
  let xt = x0 + wm;
  if (l.up || l.down) {
    const s = size * 0.7;
    const xs = x0 + wm + 0.8;
    out += text(xs, y - size * 0.45, l.up ?? "", s, { fill: color }) + text(xs, y + size * 0.25, l.down ?? "", s, { fill: color });
    xt = xs + Math.max(textWidth(l.up ?? "", s), textWidth(l.down ?? "", s));
  }
  if (l.tail) out += text(xt, y, l.tail, size, { fill: color });
  return angle ? `<g transform="rotate(${f(angle)} ${f(x)} ${f(y)})">${out}</g>` : out;
}

/** A filled arrowhead, 3 mm long, its tip at (x, y), pointing along (dx, dy). */
function arrow(x: number, y: number, dx: number, dy: number, color: string): string {
  const l = 3;
  const w = 0.9;
  const bx = x - dx * l;
  const by = y - dy * l;
  return `<path d="M${f(x)} ${f(y)}L${f(bx - dy * w)} ${f(by + dx * w)}L${f(bx + dy * w)} ${f(by - dx * w)}Z" fill="${color}"/>`;
}

/**
 * A dimension between two points on the paper, its line `offset` mm off to
 * the left of a→b (negative: to the right), with extension lines and the
 * value written along it, readable from the bottom or the right (ISO 129).
 */
export function linearDim(A: [number, number], B: [number, number], offset: number, label: string | DimLabel, width: number, color = "#000", slide = 0): string {
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (L < 1e-9) return "";
  const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
  const n = [u[1], -u[0]];
  const sg = Math.sign(offset) || 1;
  const thin = `stroke="${color}" stroke-width="${width}" fill="none"`;
  const P = (p: [number, number], k: number) => [p[0] + n[0] * k, p[1] + n[1] * k];
  const [a1, a2, b1, b2, da, db] = [P(A, sg * 1), P(A, offset + sg * 2), P(B, sg * 1), P(B, offset + sg * 2), P(A, offset), P(B, offset)];
  let out = Math.abs(offset) > 1 ? `<path d="M${f(a1[0])} ${f(a1[1])}L${f(a2[0])} ${f(a2[1])}M${f(b1[0])} ${f(b1[1])}L${f(b2[0])} ${f(b2[1])}" ${thin}/>` : "";
  out += `<path d="M${f(da[0])} ${f(da[1])}L${f(db[0])} ${f(db[1])}" ${thin}/>`;
  out += arrow(da[0], da[1], -u[0], -u[1], color) + arrow(db[0], db[1], u[0], u[1], color);
  let ang = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  if (ang > 90.01) ang -= 180;
  if (ang <= -90.01) ang += 180;
  const t = (ang * Math.PI) / 180;
  // The value slid along: past an end, the dimension line runs on under it.
  const half = labelWidth(labelOf(label), 3.5) / 2 + 1;
  if (Math.abs(slide) > L / 2 - half) {
    const k = slide > 0 ? 1 : -1;
    const from = k > 0 ? db : da;
    const reach = Math.abs(slide) + half - L / 2;
    if (reach > 0) out += `<path d="M${f(from[0])} ${f(from[1])}L${f(from[0] + u[0] * k * reach)} ${f(from[1] + u[1] * k * reach)}" ${thin}/>`;
  }
  const mid = [(da[0] + db[0]) / 2 + u[0] * slide + Math.sin(t) * 1.2, (da[1] + db[1]) / 2 + u[1] * slide - Math.cos(t) * 1.2];
  return out + labelSVG(mid[0], mid[1], label, 3.5, color, ang);
}

/**
 * An angle: an arc round C from ray C→A to ray C→B (the smaller way), R mm
 * out, arrows at its ends, the value outside its middle; the rays drawn on
 * (thin) when the arc lies beyond the edges.
 */
export function angleDim(C: [number, number], A: [number, number], B: [number, number], R: number, label: string | DimLabel, width: number, color = "#000", sweep?: number): string {
  const a1 = Math.atan2(A[1] - C[1], A[0] - C[0]);
  const t = sweep ?? angleBetween(C, A, B);
  if (Math.abs(t) < 1e-6 || R < 1) return "";
  const a2 = a1 + t;
  const at = (a: number, r: number): [number, number] => [C[0] + Math.cos(a) * r, C[1] + Math.sin(a) * r];
  const thin = `stroke="${color}" stroke-width="${width}" fill="none"`;
  const P1 = at(a1, R);
  const P2 = at(a2, R);
  let out = `<path d="M${f(P1[0])} ${f(P1[1])}A${f(R)} ${f(R)} 0 ${Math.abs(t) > Math.PI ? 1 : 0} ${t > 0 ? 1 : 0} ${f(P2[0])} ${f(P2[1])}" ${thin}/>`;
  for (const [a, Q] of [
    [a1, A],
    [a2, B],
  ] as [number, [number, number]][]) {
    const len = Math.hypot(Q[0] - C[0], Q[1] - C[1]);
    if (R > len + 1) {
      const s = at(a, len + 1);
      const e = at(a, R + 2);
      out += `<path d="M${f(s[0])} ${f(s[1])}L${f(e[0])} ${f(e[1])}" ${thin}/>`;
    }
  }
  const sg = Math.sign(t);
  out += arrow(P1[0], P1[1], sg * Math.sin(a1), -sg * Math.cos(a1), color);
  out += arrow(P2[0], P2[1], -sg * Math.sin(a2), sg * Math.cos(a2), color);
  const m = at(a1 + t / 2, R + 3);
  return out + labelSVG(m[0], m[1] + 1.2, label, 3.5, color);
}

/** A radius or diameter: a leader through the centre to the circle, the value on a shoulder outside it. */
export function circleDim(c: [number, number], r: number, angle: number, offset: number, label: string | DimLabel, diameter: boolean, width: number, color = "#000"): string {
  const d = [Math.cos(angle), Math.sin(angle)];
  const at = (k: number): [number, number] => [c[0] + d[0] * k, c[1] + d[1] * k];
  const tip = at(r);
  const end = at(r + Math.max(2, offset));
  const start = diameter ? at(-r) : c;
  const thin = `stroke="${color}" stroke-width="${width}" fill="none"`;
  const w = labelWidth(labelOf(label), 3.5) + 2;
  const right = d[0] >= 0;
  const sh = [end[0] + (right ? w : -w), end[1]];
  let out = `<path d="M${f(start[0])} ${f(start[1])}L${f(end[0])} ${f(end[1])}L${f(sh[0])} ${f(sh[1])}" ${thin}/>`;
  out += arrow(tip[0], tip[1], d[0], d[1], color);
  if (diameter) out += arrow(start[0], start[1], -d[0], -d[1], color);
  return out + labelSVG((end[0] + sh[0]) / 2, end[1] - 1.2, label, 3.5, color);
}

/** The projection method symbol (ISO 5456-2): a truncated cone, then its end view. */
function projectionSymbol(cx: number, cy: number, angle: "first" | "third", width: number): string {
  const line = `stroke="#000" stroke-width="${width}" fill="none"`;
  const R = 2.4;
  const r = 1.2;
  const L = 5.5;
  // First angle: the cone's wide end faces its end view; third angle: its narrow end.
  const [a, b] = angle === "first" ? [r, R] : [R, r];
  const x = cx - 7;
  const cone = `<path d="M${f(x)} ${f(cy - a)}L${f(x + L)} ${f(cy - b)}L${f(x + L)} ${f(cy + b)}L${f(x)} ${f(cy + a)}Z" ${line}/>`;
  const ex = cx + 4;
  return cone + `<circle cx="${f(ex)}" cy="${f(cy)}" r="${R}" ${line}/><circle cx="${f(ex)}" cy="${f(cy)}" r="${r}" ${line}/>`;
}

export interface SheetData {
  doc: ProjectDoc;
  views: Map<string, ProjectedView>;
  parts: PartRow[];
  date: Date;
  /** On screen: views and annotations marked for picking, one shown picked. */
  interactive?: boolean;
  selected?: string | null;
}

/** The whole sheet as an SVG document (mm). */
export function drawingSVG(data: SheetData): { svg: string; layout: Layout } {
  const { doc, views, parts } = data;
  const o = drawingOptions(doc);
  const L = layoutSheet(views, o, parts.length);
  const { W, H } = L;
  const lw = o.lines;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">`);
  out.push(`<rect x="0" y="0" width="${f(W)}" height="${f(H)}" fill="#fff"/>`);
  // Hatching for the faces a section cuts (ISO 128-50): thin lines at 45°, the other way for every other body.
  const hatch = (id: string, angle: number) =>
    `<pattern id="${id}" width="2.5" height="2.5" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})"><path d="M0 0V2.5" stroke="#000" stroke-width="${o.lines.section}"/></pattern>`;
  if (o.sections.length) out.push(`<defs>${hatch("hatch-a", 45)}${hatch("hatch-b", -45)}</defs>`);
  const color = (id: string) => (data.interactive && data.selected === id ? SEL : "#000");

  // ---- Frame (ISO 5457): border, centring marks, grid zones.
  if (o.titleBlock !== "none") {
    const R = W - FRAME;
    const B = H - FRAME;
    out.push(`<rect x="${FRAME_L}" y="${FRAME}" width="${f(R - FRAME_L)}" height="${f(B - FRAME)}" stroke="#000" stroke-width="0.7" fill="none"/>`);
    const cols = Math.max(2, 2 * Math.round(W / 100));
    const rows = Math.max(2, 2 * Math.round(H / 100));
    const thin = `stroke="#000" stroke-width="0.35"`;
    let ticks = "";
    for (let i = 0; i <= cols; i++) {
      const x = FRAME_L + ((R - FRAME_L) * i) / cols;
      if (i > 0 && i < cols) ticks += `M${f(x)} ${FRAME}L${f(x)} ${FRAME - 5}M${f(x)} ${f(B)}L${f(x)} ${f(B + 5)}`;
      if (i < cols) {
        const cx = FRAME_L + ((R - FRAME_L) * (i + 0.5)) / cols;
        out.push(text(cx, FRAME - 3.2, String(i + 1), 3, { anchor: "middle" }), text(cx, B + 6.8, String(i + 1), 3, { anchor: "middle" }));
      }
    }
    for (let j = 0; j <= rows; j++) {
      const y = FRAME + ((B - FRAME) * j) / rows;
      if (j > 0 && j < rows) ticks += `M${FRAME_L} ${f(y)}L${FRAME_L - 5} ${f(y)}M${f(R)} ${f(y)}L${f(R + 5)} ${f(y)}`;
      if (j < rows) {
        const cy = FRAME + ((B - FRAME) * (j + 0.5)) / rows + 1;
        const letter = String.fromCharCode(65 + j);
        out.push(text(FRAME_L - 5, cy, letter, 3, { anchor: "middle" }), text(R + 5, cy, letter, 3, { anchor: "middle" }));
      }
    }
    out.push(`<path d="${ticks}" ${thin}/>`);
    // Centring marks, across the border.
    out.push(
      `<path d="M${f(W / 2)} ${FRAME - 5}L${f(W / 2)} ${FRAME + 5}M${f(W / 2)} ${f(B + 5)}L${f(W / 2)} ${f(B - 5)}M${FRAME_L - 5} ${f(H / 2)}L${FRAME_L + 5} ${f(H / 2)}M${f(R + 5)} ${f(H / 2)}L${f(R - 5)} ${f(H / 2)}" stroke="#000" stroke-width="0.7"/>`,
    );
  }

  // ---- Views (and their dimensions and balloons): inside the frame, off the
  // title block - at a scale too big for the sheet they're cut there, not
  // drawn over them.
  const placed = new Map(L.views.map((p) => [p.id, p]));
  if (!L.fits) {
    const R = W - FRAME;
    const B = H - FRAME;
    const blockH = o.titleBlock === "table" ? TB_H + (parts.length ? ROW * (listRows(parts.length, H) + 1) : 0) : o.titleBlock === "simple" ? TB_H : 0;
    const area = blockH
      ? `M${FRAME_L} ${FRAME}H${R}V${f(B - blockH)}H${R - TB_W}V${B}H${FRAME_L}Z`
      : `M${FRAME_L} ${FRAME}H${R}V${B}H${FRAME_L}Z`;
    out.push(`<clipPath id="sheet-area"><path d="${area}"/></clipPath><g clip-path="url(#sheet-area)">`);
  }
  // ---- Pictures (under the views).
  for (const im of o.images) {
    const sel = data.interactive && data.selected === im.id;
    const svg = `<image href="${esc(im.src)}" x="${f(im.x)}" y="${f(im.y)}" width="${f(im.w)}" height="${f(im.h)}" preserveAspectRatio="none"/>${sel ? `<rect x="${f(im.x)}" y="${f(im.y)}" width="${f(im.w)}" height="${f(im.h)}" fill="none" stroke="${SEL}" stroke-width="0.4" stroke-dasharray="2 1"/>` : ""}`;
    out.push(data.interactive ? `<g data-ann="${im.id}">${svg}</g>` : svg);
  }
  for (const p of L.views) {
    const v = views.get(p.src ?? p.id);
    if (!v) continue;
    const iso = !!p.iso;
    const ex = o.extra.find((x) => x.id === p.id);
    const c = color(`view:${p.id}`);
    const sec = o.sections.find((x) => x.id === p.id);
    const det = o.details.find((x) => x.id === p.id);
    const r = extent(p);
    const g: string[] = [];
    if (data.interactive) {
      g.push(
        p.clip
          ? `<circle cx="${f(p.clip.c[0])}" cy="${f(p.clip.c[1])}" r="${f(p.clip.r + 2)}" fill="transparent" stroke="${c === SEL ? SEL : "none"}" stroke-width="0.3" stroke-dasharray="2 1"/>`
          : `<rect x="${f(r.x0 - 2)}" y="${f(r.y0 - 2)}" width="${f(r.x1 - r.x0 + 4)}" height="${f(r.y1 - r.y0 + 4)}" fill="transparent" stroke="${c === SEL ? SEL : "none"}" stroke-width="0.3" stroke-dasharray="2 1"/>`,
      );
    }
    const lines: string[] = [];
    v.bodies.forEach((b, i) => {
      if (b.section) lines.push(`<path d="${placePath(b.section, p)}" fill="url(#hatch-${i % 2 ? "b" : "a"})" fill-rule="evenodd" stroke="none"/>`);
      if (o.hidden && !iso && b.hidden) lines.push(`<path d="${placePath(b.hidden, p)}" stroke="${c}" stroke-width="${lw.hidden}" stroke-dasharray="3 1" fill="none"/>`);
      if (b.tangent) lines.push(`<path d="${placePath(b.tangent, p)}" stroke="${c}" stroke-width="${lw.dims}" fill="none"/>`);
      if (b.visible) lines.push(`<path d="${placePath(b.visible, p)}" stroke="${c}" stroke-width="${lw.visible}" stroke-linecap="round" fill="none"/>`);
    });
    if (p.clip) {
      // A detail: cut to its circle (drawn thin round it).
      const cid = `clip-${p.id.replace(/[^\w-]/g, "")}`;
      g.push(`<clipPath id="${cid}"><circle cx="${f(p.clip.c[0])}" cy="${f(p.clip.c[1])}" r="${f(p.clip.r)}"/></clipPath><g clip-path="url(#${cid})">${lines.join("")}</g>`);
      g.push(`<circle cx="${f(p.clip.c[0])}" cy="${f(p.clip.c[1])}" r="${f(p.clip.r)}" stroke="${c}" stroke-width="${lw.dims}" fill="none"/>`);
    } else g.push(...lines);
    if (iso || ex) {
      const label = `${ex ? extraName(ex, o) : "Isometric view"}${p.s !== L.scale ? ` (${scaleLabel(p.s)})` : ""}`;
      g.push(text(p.x + (bw(p.box) * p.s) / 2, p.y + bh(p.box) * p.s + (iso ? ISO_PAD + 2 : 7), label, 3, { anchor: "middle", fill: c }));
    }
    if (sec) g.push(text((r.x0 + r.x1) / 2, r.y1 + 8, `${sec.letter}-${sec.letter}`, 5, { anchor: "middle", fill: c }));
    if (det) g.push(text((r.x0 + r.x1) / 2, r.y1 + 8, `${det.letter} (${scaleLabel(p.s)})`, 5, { anchor: "middle", fill: c }));
    out.push(data.interactive ? `<g data-view="${p.id}">${g.join("")}</g>` : g.join("\n"));
  }

  // ---- Where the sections are cut (ISO 128-40: a chain line, thick at its
  // ends, arrows the way it is looked at, its letter), and the circles the
  // details are drawn from (thin, with their letter).
  for (const sec of o.sections) {
    const p = placed.get(sec.view);
    if (!p || !placed.has(sec.id)) continue;
    const c = color(`view:${sec.id}`);
    out.push(`<g${data.interactive ? ` data-view="${sec.id}"` : ""}>${cutLine(toPaper(p, sec.a), toPaper(p, sec.b), sec.look, sec.letter, lw, c)}</g>`);
  }
  for (const det of o.details) {
    const p = placed.get(det.view);
    if (!p || !placed.has(det.id)) continue;
    const c = color(`view:${det.id}`);
    const C = toPaper(p, det.c);
    const R = det.r * p.s;
    const at: [number, number] = [C[0] + (R + 2.5) * Math.SQRT1_2, C[1] - (R + 2.5) * Math.SQRT1_2];
    out.push(
      `<g${data.interactive ? ` data-view="${det.id}"` : ""}><circle cx="${f(C[0])}" cy="${f(C[1])}" r="${f(R)}" stroke="${c}" stroke-width="${lw.dims}" fill="none"/>${text(at[0], at[1], det.letter, 5, { fill: c })}</g>`,
    );
  }

  // ---- Centre marks and centrelines (thin chain lines).
  for (const m of o.marks) {
    const p = placed.get(m.view);
    if (!p) continue;
    const svg = markSVG(m, p, lw.center, color(m.id));
    out.push(data.interactive ? `<g data-ann="${m.id}">${svg}</g>` : svg);
  }

  // ---- Overall dimensions (width and height on the front view, depth on the
  // side view), then the dimensions put on by hand: each picked, moved, given text alike.
  for (const d of [...overallDims(o, L), ...o.dims]) {
    const p = placed.get(d.view);
    if (!p) continue;
    const c = color(d.id);
    const svg = dimSVG(d, p, o, c);
    out.push(data.interactive ? `<g data-ann="${d.id}">${svg}</g>` : svg);
  }

  // ---- Notes (pointing at what they are about).
  for (const n of o.notes) {
    const svg = noteSVG(n, n.to ? placed.get(n.to.view) : undefined, lw.dims, color(n.id));
    out.push(data.interactive ? `<g data-ann="${n.id}">${svg}</g>` : svg);
  }

  // ---- Balloons: item numbers of the parts list, each on the isometric view - or,
  // for a part hidden there, the first view it shows in. A part inside a
  // housing, seen in no view, points at its hidden lines.
  const hosts = ["iso", "front", L.side, "top", ...o.extra.map((v) => v.id)].map((id) => placed.get(id)).filter((p): p is Placed => !!p);
  const byHost = new Map<Placed, { item: number; at: [number, number] }[]>();
  const spot = (r: PartRow) => {
    for (const p of hosts) {
      const b = views.get(p.id)?.bodies.find((x) => x.id === r.id);
      if (b?.anchor) return { p, at: b.anchor };
    }
    if (o.hidden)
      for (const p of hosts) {
        const b = views.get(p.id)?.bodies.find((x) => x.id === r.id);
        if (!p.iso && b?.under) return { p, at: b.under };
      }
    return null;
  };
  if (o.balloons)
    for (const r of parts) {
      const s = spot(r);
      if (s) byHost.set(s.p, [...(byHost.get(s.p) ?? []), { item: r.item, at: toPaper(s.p, s.at) }]);
    }
  // Where balloons can't go: off the frame, on the title block, on another view or balloon.
  const taken: [number, number][] = [];
  const block = o.titleBlock === "table" ? TB_H + (parts.length ? ROW * (listRows(parts.length, L.H) + 1) : 0) : o.titleBlock === "simple" ? TB_H : 0;
  const freeFor = (host: Placed) => (x: number, y: number) => {
    if (x < FRAME_L + 4.5 || y < FRAME + 4.5 || x > L.W - FRAME - 4.5 || y > L.H - FRAME - 4.5) return false;
    if (block && x > L.W - FRAME - TB_W - 4.5 && y > L.H - FRAME - block - 4.5) return false;
    for (const p of L.views) {
      if (p === host) continue;
      const r = extent(p);
      if (x > r.x0 - 4.5 && x < r.x1 + 4.5 && y > r.y0 - 4.5 && y < r.y1 + 4.5) return false;
    }
    return taken.every(([tx, ty]) => Math.hypot(x - tx, y - ty) >= 8.5);
  };
  for (const [host, items] of byHost) {
    // The sides the overall dimensions are on.
    const first = o.angle === "first";
    const avoid: ("top" | "right" | "bottom" | "left")[] = !o.overall ? [] : host.id === "front" ? ["left", first ? "top" : "bottom"] : host.id === L.side ? [first ? "top" : "bottom"] : [];
    // Round the view, 9 mm out - those with no room there, further out.
    const spots: ReturnType<typeof balloonSpots> = [];
    let left = items;
    for (let ring = 0; left.length; ring++) {
      const m = 9 + ring * 10;
      const rect = { x0: host.x - m, y0: host.y - m, x1: host.x + bw(host.box) * host.s + m, y1: host.y + bh(host.box) * host.s + m };
      const got = balloonSpots(rect, left, ring ? [] : avoid, freeFor(host));
      for (const b of got) if (b.clear) (spots.push(b), taken.push([b.x, b.y]));
      left = left.filter((it) => !got.find((b) => b.item === it.item && b.clear));
      if (ring === 4) break;
    }
    // No room round the view (a small sheet, many parts): the free place on the
    // sheet nearest each, or at last on the frame's edge.
    const hx1 = host.x + bw(host.box) * host.s;
    const hy1 = host.y + bh(host.box) * host.s;
    const open = freeFor(host);
    for (const it of left) {
      let best: [number, number] | null = null;
      let bd = Infinity;
      for (let x = FRAME_L + 5; x <= L.W - FRAME - 5; x += 2)
        for (let y = FRAME + 5; y <= L.H - FRAME - 5; y += 2) {
          if (x > host.x - 4.5 && x < hx1 + 4.5 && y > host.y - 4.5 && y < hy1 + 4.5) continue;
          const d = Math.hypot(x - it.at[0], y - it.at[1]);
          if (d < bd && open(x, y)) (best = [x, y]), (bd = d);
        }
      const [x, y] = best ?? [Math.min(L.W - FRAME - 4.5, Math.max(FRAME_L + 4.5, hx1 + 9)), Math.min(L.H - FRAME - 4.5, Math.max(FRAME + 4.5, host.y))];
      spots.push({ item: it.item, at: it.at, x, y, clear: !!best });
      taken.push([x, y]);
    }
    for (const b of spots) {
      const dx = b.at[0] - b.x;
      const dy = b.at[1] - b.y;
      const d = Math.hypot(dx, dy) || 1;
      out.push(`<path d="M${f(b.x + (dx / d) * 4)} ${f(b.y + (dy / d) * 4)}L${f(b.at[0])} ${f(b.at[1])}" stroke="#000" stroke-width="${lw.dims}"/>`);
      out.push(`<circle cx="${f(b.at[0])}" cy="${f(b.at[1])}" r="0.6" fill="#000"/>`);
      out.push(`<circle cx="${f(b.x)}" cy="${f(b.y)}" r="4" stroke="#000" stroke-width="0.35" fill="#fff"/>`);
      out.push(text(b.x, b.y + 1.4, String(b.item), 4, { anchor: "middle" }));
    }
  }

  if (!L.fits) out.push(`</g>`);

  // ---- Title block (ISO 7200), and the parts list above it.
  if (o.titleBlock === "simple" || o.titleBlock === "table") out.push(titleBlock(o, doc.info ?? {}, data.date, L, o.titleBlock === "table" ? parts : []));
  out.push(`</svg>`);
  return { svg: out.join("\n"), layout: L };
}

/** Dimension lines (ISO 129-1): the first this far out from the view (mm on the paper), each next one this much further. */
export const DIM_FIRST = 10;
export const DIM_STEP = 7;

/**
 * The dimensions laid out the way a technical drawing has them (ISO 129-1):
 * - outside the view, on the side nearest what they measure (above or below,
 *   left or right);
 * - in rows 10 mm out, then 7 mm apart; the shorter nearer the view, the
 *   longer further out, so no extension line crosses a dimension line;
 *   dimensions that don't overlap share a row (a chain);
 * - the value in the middle, or just past the end when it doesn't fit between
 *   the arrows; no two values on top of each other;
 * - a radius's or diameter's leader pointing away from the middle of its view,
 *   out past the view, no two the same way.
 * Slanted ones stand 10 mm off; angles stay as they are. The same order back.
 */
export function arrangeDims(dims: DrawingDim[], L: Pick<Layout, "views">, o: Opts): DrawingDim[] {
  const out = new Map<string, DrawingDim>();
  /** Its line from lo to hi (along the row), its value from tlo to thi. */
  type Row = { d: DrawingDim; A: [number, number]; n: [number, number]; horiz: boolean; lo: number; hi: number; tlo: number; thi: number; len: number; slide: number };
  const rows = new Map<string, { p: Placed; side: "top" | "bottom" | "left" | "right"; items: Row[] }>();
  const circles = new Map<string, DrawingDim[]>();
  for (const d of dims) {
    const p = L.views.find((v) => v.id === d.view);
    if (!p) continue;
    const r = extent(p);
    const mid: [number, number] = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
    if ((d.kind === "length" || d.kind === "distance") && d.b) {
      const A = toPaper(p, d.a);
      const B = toPaper(p, d.b);
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (len < 1e-6) continue;
      const u: [number, number] = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
      const n: [number, number] = [u[1], -u[0]];
      const horiz = Math.abs(u[1]) < 1e-3;
      const vert = Math.abs(u[0]) < 1e-3;
      if (!horiz && !vert) {
        out.set(d.id, { ...d, offset: (Math.sign(d.offset) || 1) * DIM_FIRST, slide: undefined });
        continue;
      }
      const tw = labelWidth(labelOf(dimLabel(d, Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), o)), 3.5);
      // Too short for its value between the arrows: the value just past b's end.
      const slide = len < tw + 8 ? len / 2 + tw / 2 + 4 : 0;
      const k = horiz ? 0 : 1;
      const across = horiz ? (A[1] + B[1]) / 2 : (A[0] + B[0]) / 2;
      const side = horiz ? (across < mid[1] ? "top" : "bottom") : across < mid[0] ? "left" : "right";
      const tc = (A[k] + B[k]) / 2 + u[k] * slide;
      const key = `${d.view}|${side}`;
      if (!rows.has(key)) rows.set(key, { p, side, items: [] });
      rows.get(key)!.items.push({ d, A, n, horiz, lo: Math.min(A[k], B[k]), hi: Math.max(A[k], B[k]), tlo: tc - tw / 2 - 1.5, thi: tc + tw / 2 + 1.5, len, slide });
    } else if ((d.kind === "radius" || d.kind === "diameter") && d.c && d.r !== undefined) {
      if (!circles.has(d.view)) circles.set(d.view, []);
      circles.get(d.view)!.push(d);
    }
  }
  for (const { p, side, items } of rows.values()) {
    const r = extent(p);
    const lanes: Row[][] = [];
    // Two in one row: their lines may meet end to end (a chain), not overlap; their values clear of each other (a value past an end: of the other's line too).
    const meet = (a0: number, a1: number, b0: number, b1: number, gap: number) => a0 < b1 - gap && b0 < a1 - gap;
    const clash = (a: Row, b: Row) => meet(a.lo, a.hi, b.lo, b.hi, 0.5) || meet(a.tlo, a.thi, b.tlo, b.thi, 0) || (!!a.slide && meet(a.tlo, a.thi, b.lo, b.hi, 0)) || (!!b.slide && meet(b.tlo, b.thi, a.lo, a.hi, 0));
    items.sort((a, b) => a.len - b.len || a.lo - b.lo);
    for (const it of items) {
      let k = 0;
      while (lanes[k]?.some((o) => clash(o, it))) k++;
      (lanes[k] ??= []).push(it);
      const out1 = DIM_FIRST + DIM_STEP * k;
      const line = side === "top" ? r.y0 - out1 : side === "bottom" ? r.y1 + out1 : side === "left" ? r.x0 - out1 : r.x1 + out1;
      const offset = it.horiz ? (line - it.A[1]) * it.n[1] : (line - it.A[0]) * it.n[0];
      out.set(it.d.id, { ...it.d, offset, slide: it.slide || undefined });
    }
  }
  for (const [view, list] of circles) {
    const p = L.views.find((v) => v.id === view)!;
    const r = extent(p);
    const mid: [number, number] = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
    const taken: number[] = [];
    const apart = (a: number, b: number) => Math.abs(((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    for (const d of list) {
      const C = toPaper(p, d.c!);
      const R = d.r! * p.s;
      const away = Math.hypot(C[0] - mid[0], C[1] - mid[1]) > 1 ? Math.atan2(C[1] - mid[1], C[0] - mid[0]) : -Math.PI / 4;
      let a = away;
      for (let i = 1; i < 12 && taken.some((t) => apart(t, a) < 0.4); i++) a = away + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.45;
      taken.push(a);
      // Out past the view along the leader: where it leaves the view's box.
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const ts = [dx > 1e-9 ? (r.x1 - C[0]) / dx : dx < -1e-9 ? (r.x0 - C[0]) / dx : Infinity, dy > 1e-9 ? (r.y1 - C[1]) / dy : dy < -1e-9 ? (r.y0 - C[1]) / dy : Infinity];
      const exit = Math.max(0, Math.min(...ts));
      out.set(d.id, { ...d, angle: a, offset: Math.max(4, exit - R + 5) });
    }
  }
  return dims.map((d) => out.get(d.id) ?? d);
}

/** The views a drawing's sheet shows (to be drawn by the kernel): the standard ones switched on, then those added. */
export function sheetViewSpecs(o: Opts): ViewSpec[] {
  const side = o.angle === "first" ? "left" : "right";
  const base = VIEW_SPECS.filter((v) => (v.id === "front" || v.id === "top" || v.id === "iso" ? o.views[v.id] : o.views.side && v.id === side));
  return [...base, ...extraSpecs(o)];
}

/** What a drawing for other bodies takes from one before it: the sheet and how it's drawn, not what's on it. */
export function sheetSettings(d: DrawingOptions): DrawingOptions {
  const keep: (keyof DrawingOptions)[] = ["size", "portrait", "angle", "hidden", "views", "titleBlock", "dateFormat", "units", "precision", "anglePrecision", "comma", "lines", "balloons", "overall"];
  const out: DrawingOptions = {};
  for (const k of keep) if (d[k] !== undefined) (out as Record<string, unknown>)[k] = structuredClone(d[k]);
  return out;
}

/** The project's drawings, each with its id (a project saved with one drawing: that one). */
export function drawingsOf(doc: ProjectDoc): (DrawingOptions & { id: string })[] {
  const list = doc.drawings ?? (doc.drawing ? [doc.drawing] : []);
  return list.map((d, i) => ({ ...d, id: d.id ?? `drawing-${i + 1}` }));
}

/** A drawing put into the project (added if new), or taken out (null); the project then keeps them as a list. */
export function putDrawing(doc: ProjectDoc, id: string, next: DrawingOptions | null): void {
  const list = drawingsOf(doc);
  const i = list.findIndex((d) => d.id === id);
  if (!next) {
    if (i >= 0) list.splice(i, 1);
  } else if (i >= 0) list[i] = { ...next, id };
  else list.push({ ...next, id });
  doc.drawings = list;
  delete doc.drawing;
}

/** Is this one of the overall sizes (made by the drawing, not put on by hand)? */
export const isOverall = (id: string) => id.startsWith("overall-");

/**
 * The overall sizes as dimensions: width and height on the front view, depth
 * on the side view, along the view's box (so they follow the model), with
 * what was changed on them by hand; none taken off.
 */
export function overallDims(o: Opts, L: Pick<Layout, "views" | "side">): DrawingDim[] {
  if (!o.overall) return [];
  const first = o.angle === "first";
  const out: DrawingDim[] = [];
  const add = (id: string, view: string, a: [number, number], b: [number, number], offset: number) => {
    const e = o.overallDims[id] ?? {};
    if (e.hidden) return;
    const { hidden: _h, ...edit } = e;
    out.push({ id, view, kind: "length", a, b, offset, ...edit });
  };
  const front = L.views.find((v) => v.id === "front");
  const side = L.views.find((v) => v.id === L.side);
  if (front) {
    const [[x0, y0], [x1, y1]] = front.box;
    add("overall-width", "front", [x0, first ? y0 : y1], [x1, first ? y0 : y1], first ? 9 : -9);
    add("overall-height", "front", [x0, y1], [x0, y0], 9);
  }
  if (side) {
    const [[x0, y0], [x1, y1]] = side.box;
    add("overall-depth", side.id, [x0, first ? y0 : y1], [x1, first ? y0 : y1], first ? 9 : -9);
  }
  return out;
}

/** One dimension put on by hand, on its view. */
export function dimSVG(d: DrawingDim, p: Placed, o: Opts, color = "#000"): string {
  if ((d.kind === "length" || d.kind === "distance") && d.b) {
    const A = toPaper(p, d.a);
    const B = toPaper(p, d.b);
    return linearDim(A, B, d.offset, dimLabel(d, Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), o), o.lines.dims, color, d.slide ?? 0);
  }
  if ((d.kind === "radius" || d.kind === "diameter") && d.c && d.r !== undefined) {
    const dia = d.kind === "diameter";
    const label = dimLabel(d, dia ? 2 * d.r : d.r, o, dia ? "Ø" : "R");
    return circleDim(toPaper(p, d.c), d.r * p.s, d.angle ?? -Math.PI / 4, d.offset, label, dia, o.lines.dims, color);
  }
  if (d.kind === "angle" && d.c && d.b) {
    const C = toPaper(p, d.c);
    const A = toPaper(p, d.a);
    const B = toPaper(p, d.b);
    const t = arcSweep(d.c, d.a, d.b, d.through);
    return angleDim(C, A, B, d.offset, dimLabel(d, t, o), o.lines.dims, color, t);
  }
  return "";
}

/**
 * The angle at c from a to b the way an arc goes from a through `through` to b
 * (past 180° when it is the long way round); without `through`, the smaller
 * way. Signed: positive turning clockwise on the paper.
 */
export function arcSweep(c: [number, number], a: [number, number], b: [number, number], through?: [number, number]): number {
  const t = angleBetween(c, a, b);
  if (!through) return t;
  const m = angleBetween(c, a, through);
  // `through` lies on the short way when it turns the same way, and less far.
  const onShort = Math.sign(m) === Math.sign(t) && Math.abs(m) <= Math.abs(t);
  if (onShort) return t;
  return t > 0 ? t - 2 * Math.PI : t + 2 * Math.PI;
}

/** Something a min-max distance is measured between, in its view's mm: a point, a straight edge, a circle or an arc (from a through m to b). */
export type Ent =
  | { kind: "point"; p: [number, number] }
  | { kind: "line"; a: [number, number]; b: [number, number] }
  | { kind: "circle"; c: [number, number]; r: number; a: [number, number]; m: [number, number]; b: [number, number] };

/** A point along an entity, t from 0 to 1. */
function entAt(e: Ent): (t: number) => [number, number] {
  if (e.kind === "point") return () => e.p;
  if (e.kind === "line") return (t) => [e.a[0] + (e.b[0] - e.a[0]) * t, e.a[1] + (e.b[1] - e.a[1]) * t];
  const a0 = Math.atan2(e.a[1] - e.c[1], e.a[0] - e.c[0]);
  const whole = Math.hypot(e.a[0] - e.b[0], e.a[1] - e.b[1]) < 1e-9 * Math.max(1, e.r);
  const sw = whole ? 2 * Math.PI : arcSweep(e.c, e.a, e.b, e.m);
  return (t) => [e.c[0] + e.r * Math.cos(a0 + sw * t), e.c[1] + e.r * Math.sin(a0 + sw * t)];
}

/**
 * The nearest and the farthest two points of two entities (a point, an edge,
 * a circle or an arc): searched over both on a grid, then closed in on to far
 * below a thousandth of a millimetre.
 */
export function minMax(e1: Ent, e2: Ent): { min: [[number, number], [number, number]]; max: [[number, number], [number, number]] } {
  const f1 = entAt(e1);
  const f2 = entAt(e2);
  const n1 = e1.kind === "point" ? 0 : 120;
  const n2 = e2.kind === "point" ? 0 : 120;
  const dist = (s: number, t: number) => {
    const p = f1(s);
    const q = f2(t);
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  };
  const solve = (sign: 1 | -1): [[number, number], [number, number]] => {
    // Every grid cell's best, then each of the few best closed in on (a min or max may sit anywhere along a straight pair).
    const cand: [number, number, number][] = [];
    for (let i = 0; i <= n1; i++) for (let j = 0; j <= n2; j++) cand.push([n1 ? i / n1 : 0, n2 ? j / n2 : 0, sign * dist(n1 ? i / n1 : 0, n2 ? j / n2 : 0)]);
    cand.sort((x, y) => x[2] - y[2]);
    let best = cand[0];
    for (const c0 of cand.slice(0, 6)) {
      let [s, t, v] = c0;
      for (let h = 1 / Math.max(n1, n2, 1); h > 1e-13; h /= 2) {
        for (let moved = true; moved; ) {
          moved = false;
          for (const [ds, dt] of [[h, 0], [-h, 0], [0, h], [0, -h], [h, h], [-h, -h], [h, -h], [-h, h]]) {
            const s2 = n1 ? Math.min(1, Math.max(0, s + ds)) : 0;
            const t2 = n2 ? Math.min(1, Math.max(0, t + dt)) : 0;
            const v2 = sign * dist(s2, t2);
            if (v2 < v - 1e-15) [s, t, v, moved] = [s2, t2, v2, true];
          }
        }
      }
      if (v < best[2]) best = [s, t, v];
    }
    return [f1(best[0]), f2(best[1])];
  };
  return { min: solve(1), max: solve(-1) };
}

/** The angle at c from a to b (radians, the smaller way round, signed: positive turning clockwise on the paper). */
export function angleBetween(c: [number, number], a: [number, number], b: [number, number]): number {
  let t = Math.atan2(b[1] - c[1], b[0] - c[0]) - Math.atan2(a[1] - c[1], a[0] - c[0]);
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t <= -Math.PI) t += 2 * Math.PI;
  return t;
}

/** A dimension's text: its value (a length in mm, or an angle), what goes before and after it, its tolerance. */
export function dimLabel(d: DrawingDim, value: number, o: Opts, sign = ""): DimLabel {
  const angle = d.kind === "angle";
  const fmt = (v: number) => (angle ? angleText(v, o) : lengthText(v, o));
  // Tolerances to a thousandth whatever the drawing's precision (no trailing zeros).
  const fine = (v: number) => (angle ? angleText(v, { ...o, anglePrecision: Math.max(o.anglePrecision, 2) }) : lengthText(v, { ...o, precision: Math.max(o.precision, 3) }));
  const pre = `${d.prefix ?? ""}${sign}`;
  const post = d.suffix ?? "";
  const t = d.tol;
  const up = t?.up ?? 0;
  const down = t?.down ?? up;
  if (t?.kind === "sym") return { main: `${pre}${fmt(value)} ±${fine(up)}${post}` };
  if (t?.kind === "dev") return { main: `${pre}${fmt(value)}`, up: `+${fine(up)}`, down: `-${fine(down)}`, tail: post };
  if (t?.kind === "limits") return { main: pre, up: fmt(value + up), down: fmt(value - down), tail: post };
  if (t?.kind === "basic") return { main: `${pre}${fmt(value)}${post}`, boxed: true };
  return { main: `${pre}${fmt(value)}${post}` };
}

/** A section's cut line on its view: A and B on the paper, `look` the way its arrows point. */
function cutLine(A: [number, number], B: [number, number], look: [number, number], letter: string, lw: Opts["lines"], color: string): string {
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
  const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
  const a = [A[0] - u[0] * 3, A[1] - u[1] * 3];
  const b = [B[0] + u[0] * 3, B[1] + u[1] * 3];
  const thin = `stroke="${color}" stroke-width="${lw.center}" fill="none"`;
  let out = `<path d="M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}" ${thin} stroke-dasharray="8 1.5 1.5 1.5"/>`;
  out += `<path d="M${f(a[0])} ${f(a[1])}l${f(u[0] * 6)} ${f(u[1] * 6)}M${f(b[0])} ${f(b[1])}l${f(-u[0] * 6)} ${f(-u[1] * 6)}" stroke="${color}" stroke-width="${lw.visible}" fill="none"/>`;
  for (const e of [a, b]) {
    const tip: [number, number] = [e[0] + look[0] * 8, e[1] + look[1] * 8];
    out += `<path d="M${f(e[0])} ${f(e[1])}L${f(tip[0])} ${f(tip[1])}" stroke="${color}" stroke-width="${lw.dims}"/>`;
    out += arrow(tip[0], tip[1], look[0], look[1], color);
    out += text(tip[0] + look[0] * 3.5, tip[1] + look[1] * 3.5 + 1.8, letter, 5, { anchor: "middle", fill: color });
  }
  return out;
}

/** A centre mark (a cross a little past its circle) or a centreline (a little past its ends): thin chain lines. */
export function markSVG(m: DrawingMark, p: Placed, width: number, color = "#000"): string {
  const line = (a: [number, number], b: [number, number]) => `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}`;
  const style = `stroke="${color}" stroke-width="${width}" fill="none"`;
  if (m.kind === "center" && m.c && m.r !== undefined) {
    const C = toPaper(p, m.c);
    const e = m.r * p.s + 2.5;
    // Each arm from the middle out: the dashes cross at the centre.
    const arms = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].map(([x, y]) => line(C, [C[0] + x * e, C[1] + y * e]));
    return `<path d="${arms.join("")}" ${style}${m.r * p.s > 4 ? ` stroke-dasharray="1.5 1 6 1"` : ""}/>`;
  }
  if (m.kind === "line" && m.a && m.b) {
    const A = toPaper(p, m.a);
    const B = toPaper(p, m.b);
    const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
    const M: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    // From the middle out both ways: it looks the same at either end.
    const half = L / 2 + 2.5;
    return `<path d="${line(M, [M[0] + u[0] * half, M[1] + u[1] * half])}${line(M, [M[0] - u[0] * half, M[1] - u[1] * half])}" ${style} stroke-dasharray="1.5 1 6 1"/>`;
  }
  return "";
}

/** A note: its text; pointing at something, a leader from the near end of its text with an arrow there. */
export function noteSVG(n: DrawingNote, p: Placed | undefined, width: number, color = "#000"): string {
  let out = text(n.x, n.y, n.text, 3.5, { fill: color });
  if (n.to && p) {
    const P = toPaper(p, n.to.p);
    const w = textWidth(n.text, 3.5);
    const toLeft = P[0] < n.x + w / 2;
    const E: [number, number] = [toLeft ? n.x - 1 : n.x + w + 1, n.y - 1.2];
    const S: [number, number] = [E[0] + (toLeft ? -2.5 : 2.5), E[1]];
    const d = Math.hypot(P[0] - S[0], P[1] - S[1]) || 1;
    out += `<path d="M${f(E[0])} ${f(E[1])}L${f(S[0])} ${f(S[1])}L${f(P[0])} ${f(P[1])}" stroke="${color}" stroke-width="${width}" fill="none"/>`;
    out += arrow(P[0], P[1], (P[0] - S[0]) / d, (P[1] - S[1]) / d, color);
  }
  return out;
}

function titleBlock(o: Opts, info: ProjectInfo, date: Date, L: Layout, parts: PartRow[]): string {
  const out: string[] = [];
  const { W, H } = L;
  const tbx = W - FRAME - TB_W;
  const tby = H - FRAME - TB_H;
  const line = `stroke="#000" stroke-width="0.35" fill="none"`;
  if (parts.length) {
    const cols: [string, number, string][] = [
      ["Item", 12, "middle"],
      ["Qty", 10, "middle"],
      ["Name", 60, "start"],
      ["Material", 68, "start"],
      ["Mass", 30, "end"],
    ];
    const n = listRows(parts.length, H);
    const more = parts.length - (n - 1);
    const shown: (PartRow | null)[] = n < parts.length ? [...parts.slice(0, n - 1), null] : parts;
    const rowsOf = [...shown].reverse();
    const top = tby - ROW * (n + 1);
    out.push(`<rect x="${f(tbx)}" y="${f(top)}" width="${TB_W}" height="${ROW * (n + 1)}" fill="#fff" stroke="#000" stroke-width="0.35"/>`);
    const cellText = (x: number, w: number, a: string, y: number, t: string, size: number, weight?: string) =>
      text(a === "middle" ? x + w / 2 : a === "end" ? x + w - 1.5 : x + 1.5, y + ROW - 1.8, fit(t, w - 3, size), size, { anchor: a, weight });
    rowsOf.forEach((r, i) => {
      const y = top + i * ROW;
      out.push(`<path d="M${f(tbx)} ${f(y + ROW)}L${f(tbx + TB_W)} ${f(y + ROW)}" stroke="#000" stroke-width="0.18"/>`);
      let x = tbx;
      if (!r) return void out.push(text(tbx + 1.5, y + ROW - 1.8, `+ ${more} more parts: see the technical sheet`, 2.6));
      const values = [String(r.item), "1", r.name, r.material || "-", r.mass === undefined ? "-" : fmtMass(r.mass)];
      cols.forEach(([, w, a], c) => {
        out.push(cellText(x, w, a, y, values[c], 2.6));
        x += w;
      });
    });
    const hy = tby - ROW;
    let x = tbx;
    for (const [label, w, a] of cols) {
      out.push(cellText(x, w, a, hy, label, 2.6, "bold"));
      x += w;
      if (x < tbx + TB_W - 0.01) out.push(`<path d="M${f(x)} ${f(top + (more > 0 && n < parts.length ? ROW : 0))}L${f(x)} ${f(tby)}" stroke="#000" stroke-width="0.18"/>`);
    }
    out.push(`<path d="M${f(tbx)} ${f(hy)}L${f(tbx + TB_W)} ${f(hy)}" ${line}/>`);
  }
  out.push(`<rect x="${f(tbx)}" y="${f(tby)}" width="${TB_W}" height="${TB_H}" fill="#fff" stroke="#000" stroke-width="0.7"/>`);
  const cell = (x: number, y: number, w: number, h: number, label: string, value: string, size = 3) => {
    out.push(`<rect x="${f(tbx + x)}" y="${f(tby + y)}" width="${w}" height="${h}" ${line}/>`);
    out.push(text(tbx + x + 1.2, tby + y + 2.6, label, 1.8, { fill: "#444" }));
    if (value) out.push(text(tbx + x + 1.2, tby + y + h - 2, fit(value, w - 2.4, size), size));
  };
  cell(0, 0, 60, 18, "Owner", info.company ?? "");
  cell(60, 0, 120, 18, "Title", o.title, 5);
  let x = 0;
  const row: [string, string, number, number?][] = [
    ["Created by", info.author ?? "", 30],
    ["Date of issue", dateText(date, o.dateFormat), 25, 2.6],
    ["Units", o.units, 12],
    ["Scale", scaleLabel(L.scale), 18],
    ["Projection", "", 22],
    ["Size", o.size, 15, o.size.length > 3 ? 2.2 : 3],
    ["Drawing number", info.number ?? "", 33],
    ["Rev.", info.revision ?? "", 13],
    ["Sheet", "1/1", 12, 2.6],
  ];
  for (const [label, value, w, size] of row) {
    cell(x, 18, w, 18, label, value, size);
    if (label === "Projection") out.push(projectionSymbol(tbx + x + w / 2, tby + 28.5, o.angle, 0.35));
    x += w;
  }
  return out.join("\n");
}

/** Text cut to fit a width (a rough width per letter for a sans-serif). */
function fit(t: string, w: number, size: number): string {
  const max = Math.max(1, Math.floor(w / (size * 0.55)));
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Balloons around a view: each on the rectangle around it, where a line from
 * the view's middle through the part it names meets it, spread at least 10 mm
 * apart - on the sides left free (a side with the overall dimensions on it is
 * left to them).
 */
export function balloonSpots(
  rect: { x0: number; y0: number; x1: number; y1: number },
  items: { item: number; at: [number, number] }[],
  avoid: ("top" | "right" | "bottom" | "left")[] = [],
  free: (x: number, y: number) => boolean = () => true,
): { item: number; at: [number, number]; x: number; y: number; clear: boolean }[] {
  const { x0, y0, x1, y1 } = rect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // The free sides, clockwise from the top left corner, one after another.
  const all = [
    { side: "top", a: [x0, y0], b: [x1, y0] },
    { side: "right", a: [x1, y0], b: [x1, y1] },
    { side: "bottom", a: [x1, y1], b: [x0, y1] },
    { side: "left", a: [x0, y1], b: [x0, y0] },
  ] as const;
  const open = all.filter((s) => !avoid.includes(s.side));
  const sides = open.length ? open : all;
  const lens = sides.map((s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]));
  const per = lens.reduce((a, b) => a + b, 0);
  const round = sides.length === 4;
  const pointAt = (t: number): [number, number] => {
    t = round ? ((t % per) + per) % per : Math.max(0, Math.min(per, t));
    for (let i = 0; i < sides.length; i++) {
      if (t <= lens[i] || i === sides.length - 1) {
        const f = lens[i] ? Math.min(1, t / lens[i]) : 0;
        const { a, b } = sides[i];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      }
      t -= lens[i];
    }
    return [x0, y0];
  };
  const spots = items.map((it) => {
    let dx = it.at[0] - cx;
    let dy = it.at[1] - cy;
    if (Math.hypot(dx, dy) < 1e-6) (dx = 1), (dy = -1);
    const k = Math.min(dx ? Math.abs((x1 - x0) / 2 / dx) : Infinity, dy ? Math.abs((y1 - y0) / 2 / dy) : Infinity);
    const p = [Math.min(x1, Math.max(x0, cx + dx * k)), Math.min(y1, Math.max(y0, cy + dy * k))];
    // The nearest place on a free side.
    let best = { t: 0, d: Infinity };
    let off = 0;
    sides.forEach((s, i) => {
      const ab = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
      const f = lens[i] ? Math.max(0, Math.min(1, ((p[0] - s.a[0]) * ab[0] + (p[1] - s.a[1]) * ab[1]) / (lens[i] * lens[i]))) : 0;
      const d = Math.hypot(s.a[0] + ab[0] * f - p[0], s.a[1] + ab[1] * f - p[1]);
      if (d < best.d) best = { t: off + f * lens[i], d };
      off += lens[i];
    });
    return { ...it, t: best.t };
  });
  spots.sort((a, b) => a.t - b.t);
  // Spread: each at least 10 mm along from the one before (a few passes both ways).
  const gap = Math.min(10, per / Math.max(1, spots.length));
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < spots.length; i++) if (spots[i].t - spots[i - 1].t < gap) spots[i].t = spots[i - 1].t + gap;
    if (!round && spots.length && spots[spots.length - 1].t > per) spots[spots.length - 1].t = per;
    for (let i = spots.length - 2; i >= 0; i--) if (spots[i + 1].t - spots[i].t < gap) spots[i].t = spots[i + 1].t - gap;
    if (!round && spots.length && spots[0].t < 0) spots[0].t = 0;
  }
  // Each where nothing else is (another view, another balloon, the title
  // block): moved along until it is, the nearest way.
  const put: [number, number][] = [];
  const clear = (x: number, y: number) => free(x, y) && put.every(([px, py]) => Math.hypot(x - px, y - py) >= 8.5);
  return spots.map((s) => {
    let [x, y] = pointAt(s.t);
    let ok = clear(x, y);
    if (!ok)
      for (let d = 1; d <= per; d += 1) {
        const tries = [s.t + d, s.t - d].filter((t) => round || (t >= 0 && t <= per));
        const at = tries.map(pointAt).find(([a, b]) => clear(a, b));
        if (at) {
          [x, y] = at;
          ok = true;
          break;
        }
        if (!tries.length) break;
      }
    if (ok) put.push([x, y]);
    return { item: s.item, at: s.at, x, y, clear: ok };
  });
}

// ---- Picking on the sheet (for the dimension tools)

export interface EdgeHit {
  view: string;
  kind: "line" | "circle";
  a: [number, number];
  b: [number, number];
  c?: [number, number];
  r?: number;
  /** A circle or arc: a point on it between a and b. */
  m?: [number, number];
  /** How far from the pointer, mm on the paper. */
  d: number;
}

/** The seen edge nearest a point on the paper (within `tol` mm), over every view but the isometric one. */
export function edgeAt(views: Map<string, ProjectedView>, L: Layout, q: [number, number], tol: number, want?: "line" | "circle"): EdgeHit | null {
  let best: EdgeHit | null = null;
  for (const p of L.views) {
    if (p.iso || (p.clip && Math.hypot(q[0] - p.clip.c[0], q[1] - p.clip.c[1]) > p.clip.r)) continue;
    const v = views.get(p.src ?? p.id);
    if (!v) continue;
    for (const b of v.bodies)
      for (const e of b.edges) {
        if ("c" in e) {
          if (want === "line") continue;
          const c = toPaper(p, e.c);
          const r = e.r * p.s;
          const dc = Math.hypot(q[0] - c[0], q[1] - c[1]);
          const d = Math.abs(dc - r);
          if (d <= tol && (!best || d < best.d) && onArc(e, fromPaper(p, q))) best = { view: p.id, kind: "circle", a: e.a, b: e.b, c: e.c, r: e.r, m: e.m, d };
        } else {
          if (want === "circle") continue;
          const A = toPaper(p, e.a);
          const B = toPaper(p, e.b);
          const d = segDist(q, A, B);
          if (d <= tol && (!best || d < best.d)) best = { view: p.id, kind: "line", a: e.a, b: e.b, d };
        }
      }
  }
  return best;
}

/** The end of an edge (a corner), the middle of a straight one or a circle's centre nearest a point on the paper, within `tol` mm. */
export function pointAt(views: Map<string, ProjectedView>, L: Layout, q: [number, number], tol: number, view?: string): { view: string; p: [number, number] } | null {
  let best: { view: string; p: [number, number]; d: number } | null = null;
  for (const pl of L.views) {
    if (pl.iso || (view && pl.id !== view)) continue;
    if (pl.clip && Math.hypot(q[0] - pl.clip.c[0], q[1] - pl.clip.c[1]) > pl.clip.r) continue;
    const v = views.get(pl.src ?? pl.id);
    if (!v) continue;
    const consider = (pt: [number, number]) => {
      const P = toPaper(pl, pt);
      const d = Math.hypot(P[0] - q[0], P[1] - q[1]);
      if (d <= tol && (!best || d < best.d)) best = { view: pl.id, p: pt, d };
    };
    for (const b of v.bodies)
      for (const e of b.edges) {
        consider(e.a);
        consider(e.b);
        if ("c" in e) consider(e.c);
        else consider([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2]);
      }
  }
  return best ? { view: (best as { view: string }).view, p: (best as { p: [number, number] }).p } : null;
}

function segDist(q: [number, number], A: [number, number], B: [number, number]): number {
  const ab = [B[0] - A[0], B[1] - A[1]];
  const n = ab[0] * ab[0] + ab[1] * ab[1];
  const t = n ? Math.max(0, Math.min(1, ((q[0] - A[0]) * ab[0] + (q[1] - A[1]) * ab[1]) / n)) : 0;
  return Math.hypot(q[0] - (A[0] + t * ab[0]), q[1] - (A[1] + t * ab[1]));
}

/** Is point q (view mm) at an angle the arc a→m→b covers? A whole circle covers all. */
function onArc(e: { a: [number, number]; m: [number, number]; b: [number, number]; c: [number, number] }, q: [number, number]): boolean {
  if (e.a[0] === e.b[0] && e.a[1] === e.b[1]) return true;
  const ang = (p: [number, number]) => Math.atan2(p[1] - e.c[1], p[0] - e.c[0]);
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a = ang(e.a);
  const span = norm(ang(e.b) - a);
  const mid = norm(ang(e.m) - a);
  const t = norm(ang(q) - a);
  // The arc goes the way its middle point lies.
  return mid <= span ? t <= span + 0.05 : t >= span - 0.05;
}

/** A new id for a dimension or a note. */
export const annId = (kind: string) => `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Where a new length dimension goes: off its edge, away from the middle of its view. */
export function outward(p: Placed, a: [number, number], b: [number, number]): number {
  const A = toPaper(p, a);
  const B = toPaper(p, b);
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
  const n = [(B[1] - A[1]) / L, -(B[0] - A[0]) / L];
  const c = [p.x + (bw(p.box) * p.s) / 2, p.y + (bh(p.box) * p.s) / 2];
  const m = [(A[0] + B[0]) / 2 - c[0], (A[1] + B[1]) / 2 - c[1]];
  return n[0] * m[0] + n[1] * m[1] >= 0 ? 8 : -8;
}

export type { DrawingDetail, DrawingDim, DrawingImage, DrawingMark, DrawingNote, DrawingSection, DrawingView };
