// Where curves of a sketch lie on one another (pure): two lines one over the other look like one line, and nothing
// on the drawing said there were two. Found here, so the sketch can show them: the stretch that straight pieces
// share, and circles that are the same circle.
//
// Straight pieces: lines, and the sides of rectangles, polygons and polylines. Helper (construction) lines are left
// out - they are drawn along edges on purpose - and so is fill pattern.

import type { SketchEntity, Vec2 } from "../doc/types";

export type Overlap =
  /** A stretch that `ids` all lie along (two or more of them). */
  | { kind: "line"; a: Vec2; b: Vec2; ids: string[] }
  /** The same circle, drawn more than once. */
  | { kind: "circle"; center: Vec2; radius: number; ids: string[] };

interface Piece {
  id: string;
  a: Vec2;
  b: Vec2;
}

function straightPieces(e: SketchEntity): Piece[] {
  const run = (pts: Vec2[], closed: boolean): Piece[] => {
    const out: Piece[] = [];
    for (let i = 0; i + 1 < pts.length; i++) out.push({ id: e.id, a: pts[i], b: pts[i + 1] });
    if (closed && pts.length > 2) out.push({ id: e.id, a: pts[pts.length - 1], b: pts[0] });
    return out;
  };
  if (e.kind === "line") return [{ id: e.id, a: e.a, b: e.b }];
  if (e.kind === "polyline") return run(e.points, !!e.closed);
  if (e.kind === "rect") {
    const [c, s] = [Math.cos(e.rotation), Math.sin(e.rotation)];
    const at = (x: number, y: number): Vec2 => [e.center[0] + x * c - y * s, e.center[1] + x * s + y * c];
    return run([at(-e.w / 2, -e.h / 2), at(e.w / 2, -e.h / 2), at(e.w / 2, e.h / 2), at(-e.w / 2, e.h / 2)], true);
  }
  if (e.kind === "polygon") {
    const pts: Vec2[] = Array.from({ length: e.sides }, (_, i) => {
      const t = e.angle + (i * 2 * Math.PI) / e.sides;
      return [e.center[0] + e.radius * Math.cos(t), e.center[1] + e.radius * Math.sin(t)] as Vec2;
    });
    return run(pts, true);
  }
  return [];
}

/** The overlaps among these curves. `tol`: how near counts as on one another (default: a ten-thousandth of the drawing's size). */
export function overlaps(entities: SketchEntity[], tol?: number): Overlap[] {
  const drawn = entities.filter((e) => !e.construction && !e.id.startsWith("fp-"));
  const pieces = drawn.flatMap(straightPieces).filter((p) => Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) > 1e-9);
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of pieces)
    for (const q of [p.a, p.b]) {
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
  const size = Number.isFinite(x1 - x0) ? Math.hypot(x1 - x0, y1 - y0) : 0;
  const near = tol ?? Math.max(1e-6, size * 1e-4);
  const out: Overlap[] = [];

  // Pieces along one line: sorted into those (by which way they run, and how far that line is from the origin),
  // then each such line swept from end to end for the stretches two or more of them cover.
  const lines = new Map<string, { d: Vec2; o: Vec2; on: { id: string; t0: number; t1: number }[] }>();
  for (const p of pieces) {
    let d: Vec2 = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
    const L = Math.hypot(d[0], d[1]);
    d = [d[0] / L, d[1] / L];
    // (One way round for both ways along it.)
    if (d[0] < -1e-12 || (Math.abs(d[0]) <= 1e-12 && d[1] < 0)) d = [-d[0], -d[1]];
    const off = p.a[0] * -d[1] + p.a[1] * d[0];
    // (Hashed coarsely, then checked truly below: pieces a hair apart must land in one bin or the next.)
    const angle = Math.round(Math.atan2(d[1], d[0]) * 2000);
    const dist = Math.round(off / (near * 4));
    let home: { d: Vec2; o: Vec2; on: { id: string; t0: number; t1: number }[] } | undefined;
    for (const da of [0, -1, 1]) {
      for (const dd of [0, -1, 1]) {
        const g = lines.get(`${angle + da}|${dist + dd}`);
        if (!g) continue;
        const cross = Math.abs(g.d[0] * d[1] - g.d[1] * d[0]);
        const apart = Math.abs((p.a[0] - g.o[0]) * -g.d[1] + (p.a[1] - g.o[1]) * g.d[0]);
        const apartB = Math.abs((p.b[0] - g.o[0]) * -g.d[1] + (p.b[1] - g.o[1]) * g.d[0]);
        if (cross * L < near && apart < near && apartB < near) home = g;
      }
    }
    if (!home) {
      home = { d, o: p.a, on: [] };
      lines.set(`${angle}|${dist}`, home);
    }
    const t = (q: Vec2) => (q[0] - home!.o[0]) * home!.d[0] + (q[1] - home!.o[1]) * home!.d[1];
    const [ta, tb] = [t(p.a), t(p.b)];
    home.on.push({ id: p.id, t0: Math.min(ta, tb), t1: Math.max(ta, tb) });
  }
  for (const g of lines.values()) {
    if (g.on.length < 2) continue;
    const cuts = [...new Set(g.on.flatMap((s) => [s.t0, s.t1]))].sort((a, b) => a - b);
    let open: { t0: number; t1: number; ids: Set<string> } | null = null;
    const close = () => {
      if (open && open.t1 - open.t0 > near) {
        const at = (t: number): Vec2 => [g.o[0] + g.d[0] * t, g.o[1] + g.d[1] * t];
        out.push({ kind: "line", a: at(open.t0), b: at(open.t1), ids: [...open.ids] });
      }
      open = null;
    };
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [t0, t1] = [cuts[i], cuts[i + 1]];
      if (t1 - t0 <= near * 0.5) continue;
      const m = (t0 + t1) / 2;
      const over = g.on.filter((s) => s.t0 < m && s.t1 > m);
      // (Two sides of one shape lying on each other - a polyline doubling back - count as two, as two lines do.)
      if (over.length < 2) {
        close();
        continue;
      }
      if (open && Math.abs(open.t1 - t0) < 1e-12) {
        open.t1 = t1;
        for (const s of over) open.ids.add(s.id);
      } else {
        close();
        open = { t0, t1, ids: new Set(over.map((s) => s.id)) };
      }
    }
    close();
  }

  // Circles that are one circle.
  const circles = drawn.filter((e): e is Extract<SketchEntity, { kind: "circle" }> => e.kind === "circle");
  const taken = new Set<string>();
  for (const c of circles) {
    if (taken.has(c.id)) continue;
    const same = circles.filter((o) => Math.hypot(o.center[0] - c.center[0], o.center[1] - c.center[1]) < Math.max(near, c.radius * 1e-4) && Math.abs(o.radius - c.radius) < Math.max(near, c.radius * 1e-4));
    if (same.length < 2) continue;
    for (const o of same) taken.add(o.id);
    out.push({ kind: "circle", center: c.center, radius: c.radius, ids: same.map((o) => o.id) });
  }
  return out;
}
