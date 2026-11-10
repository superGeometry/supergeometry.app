// Drawings: the model on a sheet of paper, the way a workshop or a site reads
// it. Orthographic views (front, top, side) in first-angle (ISO, the default)
// or third-angle projection, an isometric view, overall dimensions, balloons
// with the item numbers of the technical sheet's parts list, that parts list,
// and an ISO 7200 title block inside an ISO 5457 frame. The views are the
// solids themselves, hidden lines found by the kernel - not a picture of the
// screen - so the sheet is at a true scale and prints as one.
//
// The drawing and the technical sheet are the two halves of one document: the
// balloons here and the rows there share their item numbers.

import type { DrawingOptions, ProjectDoc, ProjectInfo } from "../doc/types";
import type { ProjectedView, ViewSpec } from "../kernel/protocol";
import { trim, UNIT_LABEL, UNIT_MM, units } from "../units";
import { fmtMass } from "./materials";
import type { PartRow } from "./sheet";

/** Paper sizes, landscape, mm (ISO 216). */
export const SHEETS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] } as const;
export type SheetSize = keyof typeof SHEETS;

/** The standard scales (ISO 5455), largest first. */
export const SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000, 1 / 2000, 1 / 5000];

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

/** The options, with their defaults. */
export function drawingOptions(doc: ProjectDoc): Required<Omit<DrawingOptions, "scale">> & { scale?: number } {
  const o = doc.drawing ?? {};
  return { size: o.size ?? "A3", angle: o.angle ?? "first", hidden: o.hidden ?? true, iso: o.iso ?? true, scale: o.scale };
}

// ---- Layout (all in mm on the paper)

const FRAME_L = 20;
const FRAME = 10;
/** Title block: ISO 7200 width. */
const TB_W = 180;
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

/** Where each view goes, and at which scale: the largest standard scale at which they fit. */
export function layoutSheet(views: Map<string, ProjectedView>, opts: ReturnType<typeof drawingOptions>, parts: number): Layout {
  const [W, H] = SHEETS[opts.size];
  const R = W - FRAME;
  const B = H - FRAME;
  const T = FRAME;
  const corner = { x0: R - TB_W, y0: B - TB_H - (parts ? ROW * (parts + 1) : 0) - 2 };
  const side = opts.angle === "first" ? "left" : "right";
  const first = opts.angle === "first";
  const front = views.get("front")?.box ?? null;
  const top = views.get("top")?.box ?? null;
  const sideBox = views.get(side)?.box ?? null;
  const iso = opts.iso ? (views.get("iso")?.box ?? null) : null;
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const cornerRect: Rect = { x0: corner.x0, y0: corner.y0, x1: R, y1: B };

  /** The orthographic views at scale s: each placed, and the room it takes (with its dimensions). */
  const ortho = (s: number) => {
    const x0 = FRAME_L + DIM;
    const y0 = T + (first ? DIM : 3);
    const fw = bw(front) * s;
    const fh = bh(front) * s;
    const th = bh(top) * s;
    const sw = bw(sideBox) * s;
    // Dimensions: width and height on the front view, depth on the side view, on the side away from the top view.
    const fy = first ? y0 : y0 + th + GAP;
    const ty = first ? y0 + fh + GAP : y0;
    const sx = x0 + fw + GAP;
    const out: { id: string; box: Box; x: number; y: number; room: Rect }[] = [];
    const dimTop = first ? DIM : 3;
    const dimBottom = first ? 3 : DIM;
    if (front) out.push({ id: "front", box: front, x: x0, y: fy, room: { x0: x0 - DIM, y0: fy - dimTop, x1: x0 + fw + 3, y1: fy + fh + dimBottom } });
    if (sideBox) out.push({ id: side, box: sideBox, x: sx, y: fy, room: { x0: sx - 3, y0: fy - dimTop, x1: sx + sw + 3, y1: fy + bh(sideBox) * s + dimBottom } });
    if (top) out.push({ id: "top", box: top, x: x0, y: ty, room: { x0: x0 - 3, y0: ty - 3, x1: x0 + fw + 3, y1: ty + th + 3 } });
    return out;
  };
  const orthoFits = (s: number) => ortho(s).every((v) => v.room.x1 <= R && v.room.y1 <= B && !overlaps(v.room, cornerRect));

  /** Free places for the isometric view, beside the orthographic ones. */
  const isoRooms = (s: number): Rect[] => {
    const vs = ortho(s);
    const right = Math.max(...vs.map((v) => v.room.x1));
    const f = vs.find((v) => v.id === "front")?.room;
    const sd = vs.find((v) => v.id === side)?.room;
    const rooms: Rect[] = [{ x0: right, y0: T, x1: R, y1: corner.y0 }];
    // The quadrant the projection leaves empty: below the side view (first angle), above it (third angle).
    if (f && sd) rooms.push(first ? { x0: sd.x0, y0: f.y1, x1: R, y1: corner.y0 } : { x0: sd.x0, y0: T, x1: R, y1: f.y0 });
    return rooms.filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  };
  const isoFor = (s: number, least: number): { si: number; room: Rect } | undefined => {
    if (!iso) return undefined;
    const rooms = isoRooms(s);
    for (const si of SCALES) {
      if (si > s || si < s * least) continue;
      const room = rooms.find((r) => bw(iso) * si + 2 * ISO_PAD <= r.x1 - r.x0 && bh(iso) * si + 2 * ISO_PAD + 5 <= r.y1 - r.y0);
      if (room) return { si, room };
    }
    return undefined;
  };
  let scale = opts.scale;
  if (!scale) {
    // The largest scale the views fit at, with the isometric one no smaller than a fifth of it if it can be.
    scale = SCALES.find((s) => orthoFits(s) && (!iso || isoFor(s, 1 / 5))) ?? SCALES.find(orthoFits) ?? SCALES[SCALES.length - 1];
  }
  const s = scale;
  const placed: Placed[] = ortho(s).map((v) => ({ id: v.id, x: v.x, y: v.y, s, box: v.box }));
  const isoAt = isoFor(s, 1 / 20);
  if (iso && isoAt) {
    const { si, room } = isoAt;
    placed.push({ id: "iso", x: (room.x0 + room.x1 - bw(iso) * si) / 2, y: (room.y0 + room.y1 - bh(iso) * si - 5) / 2, s: si, box: iso });
  }
  return { W, H, scale: s, isoScale: isoAt?.si, views: placed, side };
}

// ---- Drawing the sheet (SVG, mm)

const f = (n: number) => String(Math.round(n * 100) / 100);
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = `font-family="Arial, Helvetica, sans-serif"`;

/** A path from the kernel (mm, at 1:1) moved to its place on the paper. */
function placePath(d: string, p: Placed): string {
  return d.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, c: string, x: string, y: string) => `${c}${f(p.x + (Number(x) - p.box[0][0]) * p.s)} ${f(p.y + (Number(y) - p.box[0][1]) * p.s)}`);
}

const toPaper = (p: Placed, q: [number, number]): [number, number] => [p.x + (q[0] - p.box[0][0]) * p.s, p.y + (q[1] - p.box[0][1]) * p.s];

function text(x: number, y: number, t: string, size: number, opts: { anchor?: string; rotate?: boolean; weight?: string; fill?: string } = {}): string {
  const rot = opts.rotate ? ` transform="rotate(-90 ${f(x)} ${f(y)})"` : "";
  return `<text x="${f(x)}" y="${f(y)}" font-size="${size}" ${FONT} text-anchor="${opts.anchor ?? "start"}"${opts.weight ? ` font-weight="${opts.weight}"` : ""} fill="${opts.fill ?? "#000"}"${rot}>${esc(t)}</text>`;
}

function arrow(x: number, y: number, dx: number, dy: number): string {
  // A filled arrowhead, 3 mm long, its tip at (x, y), pointing along (dx, dy).
  const l = 3;
  const w = 0.9;
  const bx = x - dx * l;
  const by = y - dy * l;
  return `<path d="M${f(x)} ${f(y)}L${f(bx - dy * w)} ${f(by + dx * w)}L${f(bx + dy * w)} ${f(by - dx * w)}Z" fill="#000"/>`;
}

/** A dimension along x (from a to b, at height `at`, measured from edge `from`) or along y. */
function dimension(axis: "x" | "y", a: number, b: number, from: number, at: number, label: string): string {
  const thin = `stroke="#000" stroke-width="0.25" fill="none"`;
  const dir = Math.sign(at - from) || 1;
  const ext = (p: number) =>
    axis === "x" ? `<path d="M${f(p)} ${f(from + dir * 1)}L${f(p)} ${f(at + dir * 2)}" ${thin}/>` : `<path d="M${f(from + dir * 1)} ${f(p)}L${f(at + dir * 2)} ${f(p)}" ${thin}/>`;
  const mid = (a + b) / 2;
  if (axis === "x")
    return (
      ext(a) +
      ext(b) +
      `<path d="M${f(a)} ${f(at)}L${f(b)} ${f(at)}" ${thin}/>` +
      arrow(a, at, -1, 0) +
      arrow(b, at, 1, 0) +
      text(mid, at - 1, label, 3.5, { anchor: "middle" })
    );
  return (
    ext(a) +
    ext(b) +
    `<path d="M${f(at)} ${f(a)}L${f(at)} ${f(b)}" ${thin}/>` +
    arrow(at, a, 0, -1) +
    arrow(at, b, 0, 1) +
    text(at - 1, mid, label, 3.5, { anchor: "middle", rotate: true })
  );
}

/** The projection method symbol (ISO 5456-2): a truncated cone and its end view. */
function projectionSymbol(cx: number, cy: number, angle: "first" | "third"): string {
  const thick = `stroke="#000" stroke-width="0.35" fill="none"`;
  const R = 2.6;
  const r = 1.3;
  const L = 6;
  // First angle: the cone's wide end faces the circles; third angle: its narrow end.
  const circles = (x: number) => `<circle cx="${f(x)}" cy="${f(cy)}" r="${R}" ${thick}/><circle cx="${f(x)}" cy="${f(cy)}" r="${r}" ${thick}/>`;
  const cone = (x: number, wideLeft: boolean) => {
    const [a, b] = wideLeft ? [R, r] : [r, R];
    return `<path d="M${f(x)} ${f(cy - a)}L${f(x + L)} ${f(cy - b)}L${f(x + L)} ${f(cy + b)}L${f(x)} ${f(cy + a)}Z" ${thick}/>`;
  };
  return angle === "first" ? circles(cx - 5) + cone(cx - 1, true) : cone(cx - 6, false) + circles(cx + 4);
}

export interface SheetData {
  doc: ProjectDoc;
  views: Map<string, ProjectedView>;
  parts: PartRow[];
  date: string;
}

/** The whole sheet as an SVG document (mm). */
export function drawingSVG(data: SheetData): { svg: string; layout: Layout } {
  const { doc, views, parts } = data;
  const opts = drawingOptions(doc);
  const L = layoutSheet(views, opts, parts.length);
  const { W, H } = L;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`);
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`);

  // ---- Frame (ISO 5457): border, centring marks.
  const thick = `stroke="#000" stroke-width="0.7" fill="none"`;
  out.push(`<rect x="${FRAME_L}" y="${FRAME}" width="${W - FRAME_L - FRAME}" height="${H - 2 * FRAME}" ${thick}/>`);
  const cm = `stroke="#000" stroke-width="0.7"`;
  out.push(
    `<path d="M${f(W / 2)} 5L${f(W / 2)} ${FRAME + 5}M${f(W / 2)} ${H - 5}L${f(W / 2)} ${H - FRAME - 5}M5 ${f(H / 2)}L${FRAME_L + 5} ${f(H / 2)}M${W - 5} ${f(H / 2)}L${W - FRAME - 5} ${f(H / 2)}" ${cm}/>`,
  );

  // ---- Views
  const k = UNIT_MM[units()];
  const num = (mm: number) => trim(mm / k, 2);
  const placed = new Map(L.views.map((p) => [p.id, p]));
  for (const p of L.views) {
    const v = views.get(p.id)!;
    const iso = p.id === "iso";
    for (const b of v.bodies) {
      if (opts.hidden && !iso && b.hidden) out.push(`<path d="${placePath(b.hidden, p)}" stroke="#000" stroke-width="0.25" stroke-dasharray="3 1" fill="none"/>`);
      if (b.tangent) out.push(`<path d="${placePath(b.tangent, p)}" stroke="#000" stroke-width="0.18" fill="none"/>`);
      if (b.visible) out.push(`<path d="${placePath(b.visible, p)}" stroke="#000" stroke-width="0.5" stroke-linecap="round" fill="none"/>`);
    }
    if (iso) {
      const label = `Isometric view${L.isoScale !== L.scale ? ` (${scaleLabel(p.s)})` : ""}`;
      out.push(text(p.x + (bw(p.box) * p.s) / 2, p.y + bh(p.box) * p.s + ISO_PAD + 2, label, 3, { anchor: "middle" }));
    }
  }

  // ---- Overall dimensions: width and height on the front view, depth on the side view.
  const front = placed.get("front");
  const side = placed.get(L.side);
  if (front) {
    const w = bw(front.box) * front.s;
    const h = bh(front.box) * front.s;
    // Width: on the side of the front view away from the top view.
    const yEdge = opts.angle === "first" ? front.y : front.y + h;
    const yDim = opts.angle === "first" ? front.y - 9 : front.y + h + 9;
    out.push(dimension("x", front.x, front.x + w, yEdge, yDim, num(bw(front.box))));
    out.push(dimension("y", front.y, front.y + h, front.x, front.x - 9, num(bh(front.box))));
  }
  if (side) {
    const w = bw(side.box) * side.s;
    const h = bh(side.box) * side.s;
    const yEdge = opts.angle === "first" ? side.y : side.y + h;
    const yDim = opts.angle === "first" ? side.y - 9 : side.y + h + 9;
    out.push(dimension("x", side.x, side.x + w, yEdge, yDim, num(bw(side.box))));
  }

  // ---- Balloons: on the isometric view (or the front one), item numbers of the parts list.
  const host = placed.get("iso") ?? front;
  if (host && parts.length) {
    const v = views.get(host.id)!;
    const items = new Map(parts.map((r) => [r.id, r.item]));
    const rect = { x0: host.x - 9, y0: host.y - 9, x1: host.x + bw(host.box) * host.s + 9, y1: host.y + bh(host.box) * host.s + 9 };
    const balloons = balloonSpots(
      rect,
      v.bodies.filter((b) => b.anchor && items.has(b.id)).map((b) => ({ item: items.get(b.id)!, at: toPaper(host, b.anchor!) })),
    );
    for (const b of balloons) {
      const dx = b.at[0] - b.x;
      const dy = b.at[1] - b.y;
      const d = Math.hypot(dx, dy) || 1;
      out.push(`<path d="M${f(b.x + (dx / d) * 4)} ${f(b.y + (dy / d) * 4)}L${f(b.at[0])} ${f(b.at[1])}" stroke="#000" stroke-width="0.25"/>`);
      out.push(`<circle cx="${f(b.at[0])}" cy="${f(b.at[1])}" r="0.6" fill="#000"/>`);
      out.push(`<circle cx="${f(b.x)}" cy="${f(b.y)}" r="4" stroke="#000" stroke-width="0.35" fill="#fff"/>`);
      out.push(text(b.x, b.y + 1.4, String(b.item), 4, { anchor: "middle" }));
    }
  }

  // ---- Parts list, just above the title block (header at the bottom, item 1 above it).
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
    const rowsOf = [...parts].reverse();
    const top = tby - ROW * (parts.length + 1);
    out.push(`<rect x="${tbx}" y="${f(top)}" width="${TB_W}" height="${ROW * (parts.length + 1)}" fill="#fff" stroke="#000" stroke-width="0.35"/>`);
    const cellText = (x: number, w: number, a: string, y: number, t: string, size: number, weight?: string) =>
      text(a === "middle" ? x + w / 2 : a === "end" ? x + w - 1.5 : x + 1.5, y + ROW - 1.8, fit(t, w - 3, size), size, { anchor: a, weight });
    rowsOf.forEach((r, i) => {
      const y = top + i * ROW;
      out.push(`<path d="M${tbx} ${f(y + ROW)}L${tbx + TB_W} ${f(y + ROW)}" stroke="#000" stroke-width="0.18"/>`);
      let x = tbx;
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
      if (x < tbx + TB_W) out.push(`<path d="M${x} ${f(top)}L${x} ${tby}" stroke="#000" stroke-width="0.18"/>`);
    }
    out.push(`<path d="M${tbx} ${f(hy)}L${tbx + TB_W} ${f(hy)}" ${line}/>`);
  }

  // ---- Title block (ISO 7200).
  const info: ProjectInfo = doc.info ?? {};
  out.push(`<rect x="${tbx}" y="${tby}" width="${TB_W}" height="${TB_H}" fill="#fff" stroke="#000" stroke-width="0.7"/>`);
  const cell = (x: number, y: number, w: number, h: number, label: string, value: string, size = 3) => {
    out.push(`<rect x="${f(tbx + x)}" y="${f(tby + y)}" width="${w}" height="${h}" ${line}/>`);
    out.push(text(tbx + x + 1.2, tby + y + 2.6, label, 1.8, { fill: "#444" }));
    if (value) out.push(text(tbx + x + 1.2, tby + y + h - 2, fit(value, w - 2.4, size), size));
  };
  cell(0, 0, 60, 18, "Owner", info.company ?? "");
  cell(60, 0, 120, 18, "Title", doc.name || "Untitled", 5);
  cell(0, 18, 35, 18, "Created by", info.author ?? "");
  cell(35, 18, 25, 18, "Date of issue", data.date, 2.6);
  cell(60, 18, 20, 18, "Scale", scaleLabel(L.scale));
  cell(80, 18, 25, 18, "Projection", "");
  out.push(projectionSymbol(tbx + 92.5, tby + 28.5, opts.angle));
  cell(105, 18, 15, 18, "Size", opts.size);
  cell(120, 18, 35, 18, "Drawing number", info.number ?? "");
  cell(155, 18, 15, 18, "Rev.", info.revision ?? "");
  cell(170, 18, 10, 18, "Sheet", "1/1", 2.6);
  out.push(text(tbx, tby + TB_H + 4, `Dimensions in ${UNIT_LABEL[units()]}`, 2.5));
  out.push(`</svg>`);
  return { svg: out.join("\n"), layout: L };
}

/** Text cut to fit a width (a rough width per letter for a sans-serif). */
function fit(t: string, w: number, size: number): string {
  const max = Math.max(1, Math.floor(w / (size * 0.55)));
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Where the balloons go: out from the middle of the view through each part's
 * anchor to the rectangle around the view, then spread along it so no two
 * touch.
 */
export function balloonSpots(
  rect: { x0: number; y0: number; x1: number; y1: number },
  items: { item: number; at: [number, number] }[],
): { item: number; at: [number, number]; x: number; y: number }[] {
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const per = 2 * (w + h);
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  // Position along the rectangle, clockwise from the top left corner.
  const along = (x: number, y: number) => {
    if (Math.abs(y - rect.y0) < 1e-6) return x - rect.x0;
    if (Math.abs(x - rect.x1) < 1e-6) return w + (y - rect.y0);
    if (Math.abs(y - rect.y1) < 1e-6) return w + h + (rect.x1 - x);
    return 2 * w + h + (rect.y1 - y);
  };
  const pointAt = (t: number): [number, number] => {
    t = ((t % per) + per) % per;
    if (t < w) return [rect.x0 + t, rect.y0];
    if (t < w + h) return [rect.x1, rect.y0 + t - w];
    if (t < 2 * w + h) return [rect.x1 - (t - w - h), rect.y1];
    return [rect.x0, rect.y1 - (t - 2 * w - h)];
  };
  const spots = items.map((it) => {
    let dx = it.at[0] - cx;
    let dy = it.at[1] - cy;
    if (Math.hypot(dx, dy) < 1e-6) (dx = 1), (dy = -1);
    const k = Math.min(dx ? Math.abs(w / 2 / dx) : Infinity, dy ? Math.abs(h / 2 / dy) : Infinity);
    const x = Math.min(rect.x1, Math.max(rect.x0, cx + dx * k));
    const y = Math.min(rect.y1, Math.max(rect.y0, cy + dy * k));
    return { ...it, t: along(x, y) };
  });
  spots.sort((a, b) => a.t - b.t);
  // Spread: each at least 10 mm along from the one before (a few passes both ways).
  const gap = Math.min(10, per / Math.max(1, spots.length));
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < spots.length; i++) if (spots[i].t - spots[i - 1].t < gap) spots[i].t = spots[i - 1].t + gap;
    for (let i = spots.length - 2; i >= 0; i--) if (spots[i + 1].t - spots[i].t < gap) spots[i].t = spots[i + 1].t - gap;
  }
  return spots.map((s) => {
    const [x, y] = pointAt(s.t);
    return { item: s.item, at: s.at, x, y };
  });
}
