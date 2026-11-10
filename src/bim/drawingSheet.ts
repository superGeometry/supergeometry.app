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

import type { DrawingDim, DrawingNote, DrawingOptions, ProjectDoc, ProjectInfo } from "../doc/types";
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
    comma: o.comma ?? false,
    lines: { visible: o.lines?.visible ?? 0.5, hidden: o.lines?.hidden ?? 0.25, dims: o.lines?.dims ?? 0.25 },
    balloons: o.balloons ?? true,
    overall: o.overall ?? true,
    moved: o.moved ?? {},
    dims: o.dims ?? [],
    notes: o.notes ?? [],
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
}

/** Where a view's point (its own mm) is on the paper, and back. */
export const toPaper = (p: Placed, q: [number, number]): [number, number] => [p.x + (q[0] - p.box[0][0]) * p.s, p.y + (q[1] - p.box[0][1]) * p.s];
export const fromPaper = (p: Placed, q: [number, number]): [number, number] => [p.box[0][0] + (q[0] - p.x) / p.s, p.box[0][1] + (q[1] - p.y) / p.s];

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
    const best = (list: number[]) => list.find((s) => ok(s) && (!iso || isoFor(s, 1 / 5)));
    const std = best(AUTO_SCALES);
    const any = best(SCALES);
    scale = (std && (!any || std >= any * 0.7) ? std : any) ?? AUTO_SCALES.find(ok) ?? AUTO_SCALES[AUTO_SCALES.length - 1];
  }
  const s = scale;
  const placed: Placed[] = ortho(s).map((v) => ({ id: v.id, x: v.x, y: v.y, s, box: v.box }));
  const isoAt = isoFor(s, 1 / 20) ?? (iso ? { si: s, room: { x0: FRAME_L, y0: T, x1: R, y1: B } } : undefined);
  if (iso && isoAt) {
    const { si, room } = isoAt;
    placed.push({ id: "iso", x: (room.x0 + room.x1 - bw(iso) * si) / 2, y: (room.y0 + room.y1 - bh(iso) * si - 5) / 2, s: si, box: iso });
  }
  // Moved by hand: the front view takes the projected ones along; they move only along their line with it.
  const m = (k: string) => o.moved[k] ?? [0, 0];
  for (const p of placed) {
    const [gx, gy] = p.id === "iso" ? [0, 0] : m("front");
    const [ox, oy] = p.id === "iso" ? m("iso") : p.id === "top" ? [0, m("top")[1]] : p.id === side ? [m("side")[0], 0] : [0, 0];
    p.x += gx + ox;
    p.y += gy + oy;
  }
  return { W, H, scale: s, isoScale: isoAt?.si, views: placed, side };
}

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

/** A path from the kernel (mm, at 1:1) moved to its place on the paper. */
function placePath(d: string, p: Placed): string {
  return d.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, c: string, x: string, y: string) => `${c}${f(p.x + (Number(x) - p.box[0][0]) * p.s)} ${f(p.y + (Number(y) - p.box[0][1]) * p.s)}`);
}

function text(x: number, y: number, t: string, size: number, opts: { anchor?: string; angle?: number; weight?: string; fill?: string } = {}): string {
  const rot = opts.angle ? ` transform="rotate(${f(opts.angle)} ${f(x)} ${f(y)})"` : "";
  return `<text x="${f(x)}" y="${f(y)}" font-size="${size}" ${FONT} text-anchor="${opts.anchor ?? "start"}"${opts.weight ? ` font-weight="${opts.weight}"` : ""} fill="${opts.fill ?? "#000"}"${rot}>${esc(t)}</text>`;
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
export function linearDim(A: [number, number], B: [number, number], offset: number, label: string, width: number, color = "#000"): string {
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
  const mid = [(da[0] + db[0]) / 2 + Math.sin(t) * 1.2, (da[1] + db[1]) / 2 - Math.cos(t) * 1.2];
  return out + text(mid[0], mid[1], label, 3.5, { anchor: "middle", angle: ang, fill: color });
}

/** A radius or diameter: a leader through the centre to the circle, the value on a shoulder outside it. */
export function circleDim(c: [number, number], r: number, angle: number, offset: number, label: string, diameter: boolean, width: number, color = "#000"): string {
  const d = [Math.cos(angle), Math.sin(angle)];
  const at = (k: number): [number, number] => [c[0] + d[0] * k, c[1] + d[1] * k];
  const tip = at(r);
  const end = at(r + Math.max(2, offset));
  const start = diameter ? at(-r) : c;
  const thin = `stroke="${color}" stroke-width="${width}" fill="none"`;
  const w = label.length * 3.5 * 0.6 + 2;
  const right = d[0] >= 0;
  const sh = [end[0] + (right ? w : -w), end[1]];
  let out = `<path d="M${f(start[0])} ${f(start[1])}L${f(end[0])} ${f(end[1])}L${f(sh[0])} ${f(sh[1])}" ${thin}/>`;
  out += arrow(tip[0], tip[1], d[0], d[1], color);
  if (diameter) out += arrow(start[0], start[1], -d[0], -d[1], color);
  return out + text((end[0] + sh[0]) / 2, end[1] - 1.2, label, 3.5, { anchor: "middle", fill: color });
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

  // ---- Views
  const placed = new Map(L.views.map((p) => [p.id, p]));
  for (const p of L.views) {
    const v = views.get(p.id)!;
    const iso = p.id === "iso";
    const c = color(`view:${p.id}`);
    const g: string[] = [];
    if (data.interactive)
      g.push(`<rect x="${f(p.x - 2)}" y="${f(p.y - 2)}" width="${f(bw(p.box) * p.s + 4)}" height="${f(bh(p.box) * p.s + 4)}" fill="transparent" stroke="${c === SEL ? SEL : "none"}" stroke-width="0.3" stroke-dasharray="2 1"/>`);
    for (const b of v.bodies) {
      if (o.hidden && !iso && b.hidden) g.push(`<path d="${placePath(b.hidden, p)}" stroke="${c}" stroke-width="${lw.hidden}" stroke-dasharray="3 1" fill="none"/>`);
      if (b.tangent) g.push(`<path d="${placePath(b.tangent, p)}" stroke="${c}" stroke-width="${lw.dims}" fill="none"/>`);
      if (b.visible) g.push(`<path d="${placePath(b.visible, p)}" stroke="${c}" stroke-width="${lw.visible}" stroke-linecap="round" fill="none"/>`);
    }
    if (iso) {
      const label = `Isometric view${L.isoScale !== L.scale ? ` (${scaleLabel(p.s)})` : ""}`;
      g.push(text(p.x + (bw(p.box) * p.s) / 2, p.y + bh(p.box) * p.s + ISO_PAD + 2, label, 3, { anchor: "middle", fill: c }));
    }
    out.push(data.interactive ? `<g data-view="${p.id}">${g.join("")}</g>` : g.join("\n"));
  }

  // ---- Overall dimensions: width and height on the front view, depth on the side view.
  const front = placed.get("front");
  const side = placed.get(L.side);
  if (o.overall) {
    const first = o.angle === "first";
    if (front) {
      const w = bw(front.box) * front.s;
      const h = bh(front.box) * front.s;
      const y = first ? front.y : front.y + h;
      out.push(linearDim([front.x, y], [front.x + w, y], first ? 9 : -9, lengthText(bw(front.box), o), lw.dims));
      out.push(linearDim([front.x, front.y + h], [front.x, front.y], 9, lengthText(bh(front.box), o), lw.dims));
    }
    if (side) {
      const w = bw(side.box) * side.s;
      const y = first ? side.y : side.y + bh(side.box) * side.s;
      out.push(linearDim([side.x, y], [side.x + w, y], first ? 9 : -9, lengthText(bw(side.box), o), lw.dims));
    }
  }

  // ---- Dimensions put on by hand.
  for (const d of o.dims) {
    const p = placed.get(d.view);
    if (!p) continue;
    const c = color(d.id);
    const svg = dimSVG(d, p, o, c);
    out.push(data.interactive ? `<g data-ann="${d.id}">${svg}</g>` : svg);
  }

  // ---- Notes.
  for (const n of o.notes) {
    const svg = text(n.x, n.y, n.text, 3.5, { fill: color(n.id) });
    out.push(data.interactive ? `<g data-ann="${n.id}">${svg}</g>` : svg);
  }

  // ---- Balloons: item numbers of the parts list, each on the isometric view - or,
  // for a part hidden there, the first view it shows in. A part inside a
  // housing, seen in no view, points at its hidden lines.
  const hosts = ["iso", "front", L.side, "top"].map((id) => placed.get(id)).filter((p): p is Placed => !!p);
  const byHost = new Map<Placed, { item: number; at: [number, number] }[]>();
  const spot = (r: PartRow) => {
    for (const p of hosts) {
      const b = views.get(p.id)?.bodies.find((x) => x.id === r.id);
      if (b?.anchor) return { p, at: b.anchor };
    }
    if (o.hidden)
      for (const p of hosts) {
        const b = views.get(p.id)?.bodies.find((x) => x.id === r.id);
        if (p.id !== "iso" && b?.under) return { p, at: b.under };
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
      if (x > p.x - 4.5 && x < p.x + bw(p.box) * p.s + 4.5 && y > p.y - 4.5 && y < p.y + bh(p.box) * p.s + 4.5) return false;
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
      const last = ring === 4;
      for (const b of got) if (b.clear || last) (spots.push(b), taken.push([b.x, b.y]));
      left = last ? [] : left.filter((it) => !got.find((b) => b.item === it.item && b.clear));
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

  // ---- Title block (ISO 7200), and the parts list above it.
  if (o.titleBlock === "simple" || o.titleBlock === "table") out.push(titleBlock(o, doc.info ?? {}, data.date, L, o.titleBlock === "table" ? parts : []));
  out.push(`</svg>`);
  return { svg: out.join("\n"), layout: L };
}

/** One dimension put on by hand, on its view. */
export function dimSVG(d: DrawingDim, p: Placed, o: Opts, color = "#000"): string {
  if ((d.kind === "length" || d.kind === "distance") && d.b) {
    const A = toPaper(p, d.a);
    const B = toPaper(p, d.b);
    return linearDim(A, B, d.offset, lengthText(Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), o), o.lines.dims, color);
  }
  if ((d.kind === "radius" || d.kind === "diameter") && d.c && d.r !== undefined) {
    const dia = d.kind === "diameter";
    const label = dia ? `Ø${lengthText(2 * d.r, o)}` : `R${lengthText(d.r, o)}`;
    return circleDim(toPaper(p, d.c), d.r * p.s, d.angle ?? -Math.PI / 4, d.offset, label, dia, o.lines.dims, color);
  }
  return "";
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
  /** How far from the pointer, mm on the paper. */
  d: number;
}

/** The seen edge nearest a point on the paper (within `tol` mm), over every view but the isometric one. */
export function edgeAt(views: Map<string, ProjectedView>, L: Layout, q: [number, number], tol: number, want?: "line" | "circle"): EdgeHit | null {
  let best: EdgeHit | null = null;
  for (const p of L.views) {
    if (p.id === "iso") continue;
    const v = views.get(p.id);
    if (!v) continue;
    for (const b of v.bodies)
      for (const e of b.edges) {
        if ("c" in e) {
          if (want === "line") continue;
          const c = toPaper(p, e.c);
          const r = e.r * p.s;
          const dc = Math.hypot(q[0] - c[0], q[1] - c[1]);
          const d = Math.abs(dc - r);
          if (d <= tol && (!best || d < best.d) && onArc(e, fromPaper(p, q))) best = { view: p.id, kind: "circle", a: e.a, b: e.b, c: e.c, r: e.r, d };
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

/** The end of an edge (a corner) nearest a point on the paper, within `tol` mm. */
export function pointAt(views: Map<string, ProjectedView>, L: Layout, q: [number, number], tol: number, view?: string): { view: string; p: [number, number] } | null {
  let best: { view: string; p: [number, number]; d: number } | null = null;
  for (const pl of L.views) {
    if (pl.id === "iso" || (view && pl.id !== view)) continue;
    const v = views.get(pl.id);
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

export type { DrawingDim, DrawingNote };
