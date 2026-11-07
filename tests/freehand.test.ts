// Run: npx tsx tests/freehand.test.ts - freehand strokes become a few clean curves.
import assert from "node:assert/strict";
import type { Vec2 } from "../src/doc/types";
import { simplifyStroke, type FreehandPiece } from "../src/sketch/freehand";
import { splinePoints } from "../src/sketch/curves";
import { arrangement } from "../src/sketch/regions";

// A pointer reports every ~3 units (tol = 1 is about 2.5 px), with a little hand jitter.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
function stroke(path: (t: number) => Vec2, len: number, jitter = 0.4): Vec2[] {
  const n = Math.ceil(len / 3);
  return Array.from({ length: n + 1 }, (_, i) => {
    const [x, y] = path(i / n);
    return [x + rnd() * jitter, y + rnd() * jitter] as Vec2;
  });
}
const poly = (corners: Vec2[]) => (t: number): Vec2 => {
  const segs = corners.length - 1;
  const s = Math.min(segs - 1, Math.floor(t * segs));
  const u = t * segs - s;
  const [a, b] = [corners[s], corners[s + 1]];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
};
const kinds = (p: FreehandPiece[]) => p.map((x) => x.kind).join(",");
const sample = (p: FreehandPiece): Vec2[] =>
  p.kind === "line" ? [p.a, p.b] : p.kind === "spline" ? splinePoints(p.points, p.closed, "fit", 16) : p.kind === "circle" ? Array.from({ length: 129 }, (_, i) => [p.center[0] + p.radius * Math.cos((i / 128) * 2 * Math.PI), p.center[1] + p.radius * Math.sin((i / 128) * 2 * Math.PI)] as Vec2) : arcPts(p);
function arcPts(p: Extract<FreehandPiece, { kind: "arc" }>): Vec2[] {
  // Through a, m, b: a fine polyline is enough for distances.
  const [ax, ay] = p.a, [bx, by] = p.b, [cx, cy] = p.m;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const ang = (q: Vec2) => Math.atan2(q[1] - uy, q[0] - ux);
  const T = 2 * Math.PI, ccw = (x: number) => ((x % T) + T) % T;
  const toM = ccw(ang(p.m) - ang(p.a)), toB = ccw(ang(p.b) - ang(p.a));
  const sweep = toM < toB ? toB : toB - T;
  return Array.from({ length: 129 }, (_, i) => [ux + r * Math.cos(ang(p.a) + (sweep * i) / 128), uy + r * Math.sin(ang(p.a) + (sweep * i) / 128)] as Vec2);
}
const segD = (q: Vec2, a: Vec2, b: Vec2) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t);
};
/** How far the stroke gets from the result (the worst point). */
function deviation(raw: Vec2[], pieces: FreehandPiece[]): number {
  const all = pieces.map(sample);
  let worst = 0;
  for (const q of raw) {
    let d = Infinity;
    for (const s of all) for (let i = 1; i < s.length; i++) d = Math.min(d, segD(q, s[i - 1], s[i]));
    worst = Math.max(worst, d);
  }
  return worst;
}
const fitPoints = (p: FreehandPiece[]) => p.reduce((n, x) => n + (x.kind === "spline" ? x.points.length : 0), 0);
const joined = (p: FreehandPiece[], closed: boolean) => {
  const end = (x: FreehandPiece) => (x.kind === "spline" ? x.points[x.points.length - 1] : (x as any).b);
  const start = (x: FreehandPiece) => (x.kind === "spline" ? x.points[0] : (x as any).a);
  for (let i = 1; i < p.length; i++) assert.deepEqual(start(p[i]), end(p[i - 1]), `piece ${i} not joined`);
  if (closed) assert.deepEqual(start(p[0]), end(p[p.length - 1]), "loop not closed");
};
const toEntities = (p: FreehandPiece[]) =>
  p.map((x, i) => (x.kind === "spline" ? { id: `e${i}`, kind: "spline" as const, points: x.points, closed: x.closed, mode: "fit" as const } : { id: `e${i}`, ...x })) as any[];

const checks: [string, () => string][] = [
  ["a wobbly straight stroke is one line", () => {
    const raw = stroke((t) => [t * 200, Math.sin(t * 9) * 1.2], 200);
    const r = simplifyStroke(raw, 1);
    assert.equal(kinds(r.pieces), "line");
    assert.equal(r.closed, false);
    return `${raw.length} points → 1 line`;
  }],
  ["an L is two lines, joined at the corner", () => {
    const raw = stroke(poly([[0, 0], [150, 0], [150, 100]]), 250);
    const r = simplifyStroke(raw, 1);
    assert.equal(kinds(r.pieces), "line,line");
    joined(r.pieces, false);
    const corner = (r.pieces[0] as any).b as Vec2;
    assert.ok(Math.hypot(corner[0] - 150, corner[1]) < 4, `corner at ${corner}`);
    return `corner at ${corner.map((v) => v.toFixed(1))}`;
  }],
  ["a square drawn back to its start: four lines, closed, one region", () => {
    const raw = stroke(poly([[0, 0], [100, 0], [100, 100], [0, 100], [1.5, 2]]), 400);
    const r = simplifyStroke(raw, 1);
    assert.equal(r.closed, true);
    assert.equal(kinds(r.pieces), "line,line,line,line");
    joined(r.pieces, true);
    const reg = arrangement(toEntities(r.pieces)).regions;
    assert.equal(reg.length, 1);
    assert.ok(Math.abs(reg[0].area - 10000) < 400, `area ${reg[0].area}`);
    return `${raw.length} points → 4 lines, area ${reg[0].area.toFixed(0)}`;
  }],
  ["a round loop is a circle", () => {
    const raw = stroke((t) => [50 * Math.cos(t * 2 * Math.PI * 1.01), 50 * Math.sin(t * 2 * Math.PI * 1.01)], 320, 0.8);
    const r = simplifyStroke(raw, 1);
    assert.equal(kinds(r.pieces), "circle");
    const c = r.pieces[0] as Extract<FreehandPiece, { kind: "circle" }>;
    assert.ok(Math.abs(c.radius - 50) < 1.5 && Math.hypot(...c.center) < 1.5, JSON.stringify(c));
    return `r ${c.radius.toFixed(2)}`;
  }],
  ["a half circle is one arc", () => {
    const raw = stroke((t) => [60 * Math.cos(t * Math.PI), 60 * Math.sin(t * Math.PI)], 190);
    const r = simplifyStroke(raw, 1);
    assert.equal(kinds(r.pieces), "arc");
    assert.ok(deviation(raw, r.pieces) < 1.6);
    return `dev ${deviation(raw, r.pieces).toFixed(2)}`;
  }],
  ["a wave is one spline through few points, within the tolerance", () => {
    const raw = stroke((t) => [t * 300, 40 * Math.sin(t * 3 * Math.PI)], 450);
    const r = simplifyStroke(raw, 1);
    assert.equal(kinds(r.pieces), "spline");
    const n = fitPoints(r.pieces);
    const dev = deviation(raw, r.pieces);
    assert.ok(n <= 16, `${n} fit points`);
    assert.ok(dev < 1.6, `dev ${dev}`);
    return `${raw.length} points → ${n} fit points, dev ${dev.toFixed(2)}`;
  }],
  ["a blob loop is one closed spline with one region", () => {
    const raw = stroke((t) => { const a = t * 2 * Math.PI; const r = 60 + 18 * Math.sin(3 * a); return [r * Math.cos(a), r * Math.sin(a)]; }, 420);
    raw.push([...raw[0]] as Vec2);
    const r = simplifyStroke(raw, 1);
    assert.equal(kinds(r.pieces), "spline");
    assert.equal(r.closed, true);
    const n = fitPoints(r.pieces);
    assert.ok(n <= 20, `${n} fit points`);
    assert.ok(deviation(raw, r.pieces) < 1.6);
    assert.equal(arrangement(toEntities(r.pieces)).regions.length, 1);
    return `${raw.length} points → ${n} fit points`;
  }],
  ["a D (a line and a curve) closes into one region", () => {
    const raw = [...stroke((t) => [0, 100 - t * 100], 100), ...stroke((t) => [70 * Math.sin(t * Math.PI), 50 - 50 * Math.cos(t * Math.PI)], 220).slice(1)];
    const r = simplifyStroke(raw, 1);
    assert.equal(r.closed, true);
    assert.equal(r.pieces.length, 2, kinds(r.pieces));
    joined(r.pieces, true);
    assert.equal(arrangement(toEntities(r.pieces)).regions.length, 1);
    return kinds(r.pieces);
  }],
  ["a tap or a tiny scribble makes nothing", () => {
    assert.equal(simplifyStroke([[0, 0], [0.5, 0.2], [0.3, 0.1]], 1).pieces.length, 0);
    assert.equal(simplifyStroke([[0, 0]], 1).pieces.length, 0);
    return "ok";
  }],
  ["a long scribble stays cheap and within the tolerance", () => {
    const raw = stroke((t) => [t * 800 + 30 * Math.sin(t * 40), 80 * Math.sin(t * 7) + 20 * Math.cos(t * 23)], 2400, 0.6);
    const t0 = performance.now();
    const r = simplifyStroke(raw, 1);
    const ms = performance.now() - t0;
    const dev = deviation(raw, r.pieces);
    assert.ok(dev < 2, `dev ${dev}`);
    assert.ok(ms < 400, `${ms} ms`);
    return `${raw.length} points → ${r.pieces.length} pieces, ${fitPoints(r.pieces)} fit points, ${ms.toFixed(0)} ms`;
  }],
];
let failed = 0;
for (const [name, fn] of checks) {
  try {
    console.log("ok  ", name, "-", fn());
  } catch (e) {
    failed++;
    console.log("FAIL", name, "-", e instanceof Error ? e.message : e);
  }
}
process.exit(failed ? 1 : 0);
