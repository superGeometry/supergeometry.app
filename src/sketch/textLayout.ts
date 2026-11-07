// Text laid out as closed outlines (each glyph contour; holes come out as
// regions) from a parsed font. No font loading here, so it runs anywhere.
//
// Each contour keeps the font's own shape with as few curves as it takes:
// straight sides are lines, and each smooth stretch between two corners is one
// arc or one fit spline (as Draw makes of a pencil stroke). Cut into short
// straight pieces, an "O" was 60-odd faces once extruded.

import type { Font } from "opentype.js";
import type { SketchEntity, Vec2 } from "../doc/types";
import { uid } from "./edit";
import { fitCircle, fitRun, fitSpline, type FreehandPiece } from "./freehand";

/** Where `at` sits along the baseline: the text's start, the middle of its ink, or the end of its ink. */
export type TextAlign = "left" | "center" | "right";

/** One piece of a glyph contour: a straight side, or a curve given by its control points (ends included). */
type Seg = { line: boolean; p: Vec2[] };

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A point along a Bézier curve (any degree). */
function bez(p: Vec2[], t: number): Vec2 {
  let q = p.slice();
  while (q.length > 1) q = q.slice(1).map((b, i) => [q[i][0] + (b[0] - q[i][0]) * t, q[i][1] + (b[1] - q[i][1]) * t] as Vec2);
  return q[0];
}

const start = (s: Seg) => s.p[0];
const end = (s: Seg) => s.p[s.p.length - 1];
/** Which way a piece leaves its start, or heads into its end (unit vectors). */
function dirAt(s: Seg, atEnd: boolean, tiny: number): Vec2 {
  const p = atEnd ? s.p.slice().reverse() : s.p;
  const q = p.find((x) => dist(x, p[0]) > tiny) ?? p[p.length - 1];
  const d = dist(p[0], q) || 1;
  const v: Vec2 = [(q[0] - p[0][0]) / d, (q[1] - p[0][1]) / d];
  return atEnd ? [-v[0], -v[1]] : v;
}
const turn = (a: Vec2, b: Vec2) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1])));

/** Points fitted to per font curve (a font curve is a simple bend: a dozen is plenty). */
const SAMPLES = 12;

/** Points along a run of curves, close enough together to fit to (none repeated: a spline can't pass one spot twice in a row). */
function sampleRun(run: Seg[], tiny: number): Vec2[] {
  const out: Vec2[] = [start(run[0])];
  for (const s of run) {
    for (let i = 1; i <= SAMPLES; i++) {
      const q = bez(s.p, i / SAMPLES);
      if (dist(q, out[out.length - 1]) > tiny * 0.1) out.push(q);
    }
  }
  // The run's end is the font's own point, exactly.
  out[out.length - 1] = end(run[run.length - 1]);
  return out;
}

/**
 * One contour as few pieces: lines kept, smooth stretches of curve fitted
 * within tol. Straight sides only: the polyline's corners instead.
 */
function simplifyContour(segs: Seg[], tol: number, tiny: number): FreehandPiece[] | Vec2[] {
  const n = segs.length;
  // A corner where the outline turns (a line always starts / ends one: it stays itself).
  const corner = segs.map((s, i) => {
    const prev = segs[(i - 1 + n) % n];
    const t = turn(dirAt(prev, true, tiny), dirAt(s, false, tiny));
    return prev.line && s.line ? t > 1e-3 : prev.line || s.line || t > (12 * Math.PI) / 180;
  });
  if (segs.every((s) => s.line)) {
    // One closed polyline, as before (a side the font splits in two is one side here).
    return segs.filter((_, i) => corner[i]).map(start);
  }
  if (!corner.some(Boolean)) {
    // A smooth loop (an "O"): a circle if it is one, else one closed spline.
    const pts = sampleRun(segs, tiny);
    pts.pop();
    const c = fitCircle(pts);
    if (c && pts.every((q) => Math.abs(dist(q, c.c) - c.r) <= tol)) return [{ kind: "circle", center: c.c, radius: c.r }];
    return [{ kind: "spline", points: fitSpline(pts, true, tol), closed: true }];
  }
  // Runs from corner to corner, starting at the first corner.
  const first = corner.indexOf(true);
  const runs: Seg[][] = [];
  for (let k = 0; k < n; k++) {
    const i = (first + k) % n;
    if (corner[i]) runs.push([]);
    runs[runs.length - 1].push(segs[i]);
  }
  const pieces: FreehandPiece[] = [];
  for (const run of runs) {
    if (run[0].line) {
      // Straight sides in a row along one line are one line (the run holds them all).
      const prev = pieces[pieces.length - 1];
      const a = start(run[0]);
      const b = end(run[run.length - 1]);
      if (prev?.kind === "line" && turn(dirAt({ line: true, p: [prev.a, prev.b] }, true, tiny), dirAt(run[0], false, tiny)) <= 1e-3) prev.b = b;
      else pieces.push({ kind: "line", a, b });
    } else {
      const piece = fitRun(sampleRun(run, tiny), tol, true);
      // Its ends are the font's own points (where it meets the next piece).
      if (piece.kind === "line" || piece.kind === "arc") (piece.a = start(run[0])), (piece.b = end(run[run.length - 1]));
      pieces.push(piece);
    }
  }
  return pieces;
}

/** `text` with its capitals `size` tall, its baseline through `at` (aligned there by `align`), turned `angle` radians. */
export function textOutlines(
  f: Font,
  text: string,
  at: Vec2,
  size: number,
  angle = 0,
  align: TextAlign = "left",
): SketchEntity[] {
  // opentype sizes are em: scale so capitals are `size` tall (the font says how tall its caps are).
  const os2 = (f.tables as { os2?: { sCapHeight?: number } }).os2;
  const cap = os2?.sCapHeight ? os2.sCapHeight / f.unitsPerEm : 0.711;
  const fontSize = size / cap;
  // Lay glyphs out ourselves: opentype's text shaper chokes on some of Roboto's
  // substitution tables ("substFormat 2 not supported").
  const scale = fontSize / f.unitsPerEm;
  type Cmd = { type: string; x: number; y: number; x1: number; y1: number; x2: number; y2: number };
  const commands: Cmd[] = [];
  let x = 0;
  let prev: ReturnType<Font["charToGlyph"]> | null = null;
  for (const ch of text) {
    const g = f.charToGlyph(ch);
    if (prev) x += f.getKerningValue(prev, g) * scale;
    commands.push(...(g.getPath(x, 0, fontSize).commands as Cmd[]));
    x += (g.advanceWidth ?? 0) * scale;
    prev = g;
  }
  // Points closer than this are one point: fonts repeat a point where a curve
  // meets a line (an "8" in Roboto), and a zero-length edge can't be made into
  // a face - the text then fails to extrude or cut.
  const tiny = size * 1e-3;
  const contours: Seg[][] = [];
  let cur: Seg[] = [];
  let from: Vec2 = [0, 0];
  let begin: Vec2 = [0, 0];
  const add = (s: Seg) => {
    if (s.p.every((q) => dist(q, from) <= tiny)) return; // a repeated point
    cur.push(s);
    from = end(s);
  };
  const close = () => {
    if (cur.length && dist(from, begin) > tiny) add({ line: true, p: [from, begin] });
    // The last piece ends exactly where the first starts.
    if (cur.length) {
      const last = cur[cur.length - 1];
      last.p[last.p.length - 1] = start(cur[0]);
      // A last piece shrunk to nothing by that goes.
      if (cur.length > 1 && last.p.every((q) => dist(q, start(cur[0])) <= tiny)) cur.pop();
    }
    if (cur.length >= 2 || (cur.length === 1 && !cur[0].line)) contours.push(cur);
    cur = [];
  };
  for (const c of commands) {
    if (c.type === "M") {
      close();
      from = begin = [c.x, -c.y];
    } else if (c.type === "L") add({ line: true, p: [from, [c.x, -c.y]] });
    else if (c.type === "Q") add({ line: false, p: [from, [c.x1, -c.y1], [c.x, -c.y]] });
    else if (c.type === "C") add({ line: false, p: [from, [c.x1, -c.y1], [c.x2, -c.y2], [c.x, -c.y]] });
    else if (c.type === "Z") close();
  }
  close();
  // Centred / right: by the ink, not the advance (a "1" is mostly side bearing).
  let dx = 0;
  if (align !== "left" && contours.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of contours.flat()) {
      for (let i = 0; i <= 16; i++) {
        const q = bez(s.p, i / 16);
        lo = Math.min(lo, q[0]);
        hi = Math.max(hi, q[0]);
      }
    }
    dx = align === "center" ? -(lo + hi) / 2 : -hi;
  }
  // Placed (moved to `at`, turned) before fitting: its points end up where they belong.
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  const place = ([px, py]: Vec2): Vec2 => [at[0] + (px + dx) * cs - py * sn, at[1] + (px + dx) * sn + py * cs];
  for (const segs of contours) for (const s of segs) s.p = s.p.map(place);
  // Within a few thousandths of the letter height: nothing to see, on screen or printed.
  const tol = size * 3e-3;
  const out: SketchEntity[] = [];
  for (const segs of contours) {
    const r = simplifyContour(segs, tol, tiny);
    if (!r.length) continue;
    if (Array.isArray(r[0])) {
      if (r.length >= 3) out.push({ id: uid(), kind: "polyline", closed: true, points: r as Vec2[] });
      continue;
    }
    for (const pc of r as FreehandPiece[]) {
      if (pc.kind === "spline") out.push({ id: uid(), kind: "spline", points: pc.points, closed: pc.closed, mode: "fit" });
      else out.push({ id: uid(), ...pc } as SketchEntity);
    }
  }
  return out;
}
