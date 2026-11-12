// Fill: a surface over a network of curves - a boundary loop and guides.
// Run: npx tsx tests/fill.test.ts
import { measureArea } from "replicad";
import { fillEdgeKey, type Feature, type Vec3 } from "../src/doc/types";
import { after, check, done, line, near, sketch, XY, XZ } from "./kit";

const area = (s: { faces: unknown[] } | undefined) => (s ? (s.faces as Parameters<typeof measureArea>[0][]).reduce((a, f) => a + measureArea(f), 0) : 0);
const bounds = (s: { boundingBox: { bounds: [Vec3, Vec3] } } | undefined) => s?.boundingBox.bounds;
const edgeRef = (body: string, e: { pointAt(t: number): { toTuple(): number[] }; tangentAt(t: number): { toTuple(): number[] }; length: number }) => ({ body, mid: e.pointAt(0.5).toTuple() as Vec3, dir: e.tangentAt(0.5).toTuple() as Vec3, length: e.length });

// A 20×20 square loop on XY: a flat patch of 400.
const loop = sketch("b", XY(), [line("l1", [0, 0], [20, 0]), line("l2", [20, 0], [20, 20]), line("l3", [20, 20], [0, 20]), line("l4", [0, 20], [0, 0])]);
const fill = (extra: Record<string, unknown> = {}): Feature => ({ id: "F", name: "Fill", type: "fill", boundary: [{ kind: "sketch", sketch: "b", entities: ["l1", "l2", "l3", "l4"] }], ...extra }) as Feature;
{
  const flat = await after([loop, fill()], "F");
  check("a square loop fills flat", !flat.err && near(area(flat.body), 400, 0.5), { err: flat.err, a: area(flat.body) });
}

// A guide across it: a tent of two lines in XZ (y = 10), up to z = 6 in the middle - the surface rises to it.
{
  const guide = sketch("g", XZ(10), [line("g1", [0, 0], [10, 6]), line("g2", [10, 6], [20, 0])]);
  const r = await after([loop, guide, fill({ guides: [{ kind: "sketch", sketch: "g", entities: ["g1", "g2"] }] })], "F");
  const b = bounds(r.body);
  check("a guide lifts the surface (to about 6)", !r.err && !!b && b[1][2] > 5 && b[1][2] < 7, { err: r.err, b });
  check("so it's bigger than flat", !r.err && area(r.body) > 410, area(r.body));
}

// Bridging two flat patches: A on z = 0 (x 0…20), B on z = 10 (x 30…50).
// Touching them (G0) the bridge is a straight ramp (20 × √200 = 282.8);
// tangent to both (G1) it leaves and meets them level - an S, a little more.
{
  const sq = (id: string, z: number, x0: number) => sketch(id, XY(z), [line("e1", [x0, 0], [x0 + 20, 0]), line("e2", [x0 + 20, 0], [x0 + 20, 20]), line("e3", [x0 + 20, 20], [x0, 20]), line("e4", [x0, 20], [x0, 0])]);
  const A = sq("a", 0, 0);
  const B = sq("b2", 10, 30);
  const patch = (id: string, sk: string): Feature => ({ id, name: id, type: "fill", boundary: [{ kind: "sketch", sketch: sk, entities: ["e1", "e2", "e3", "e4"] }] }) as Feature;
  const base = [A, B, patch("PA", "a"), patch("PB", "b2")];
  const ra = (await after(base, "PA")).body!;
  const rb = (await after(base, "PB")).body!;
  const right = ra.edges.filter((e) => near(e.pointAt(0.5).toTuple()[0], 20, 1e-6)).map((e) => edgeRef("PA", e));
  const left = rb.edges.filter((e) => near(e.pointAt(0.5).toTuple()[0], 30, 1e-6)).map((e) => edgeRef("PB", e));
  const sides = sketch("s", XZ(0), [line("s1", [20, 0], [30, 10])]);
  const far = sketch("s2", XZ(20), [line("s1", [20, 0], [30, 10])]);
  const bridge = (continuity?: string): Feature =>
    ({ id: "W", name: "Bridge", type: "fill", boundary: [{ kind: "edges", edges: right }, { kind: "sketch", sketch: "s", entities: ["s1"] }, { kind: "edges", edges: left }, { kind: "sketch", sketch: "s2", entities: ["s1"] }], ...(continuity ? { continuity } : {}) }) as Feature;
  const g0 = await after([...base, sides, far, bridge()], "W");
  check("a bridge between two patches (G0): a straight ramp", !g0.err && near(area(g0.body), 20 * Math.sqrt(200), 0.5), { err: g0.err, a: area(g0.body) });
  const g1 = await after([...base, sides, far, bridge("g1")], "W");
  check("tangent to both (G1): an S, a little bigger", !g1.err && area(g1.body) > area(g0.body) + 0.5, { err: g1.err, a: area(g1.body) });
  const g2 = await after([...base, sides, far, bridge("g2")], "W");
  // (OpenCascade's filling can't hold curvature along flat faces: it says so, rather than a G1 passed off as G2.)
  // Tangent to one patch only (its edge set on its own): between the two.
  const half = await after([...base, sides, far, { ...bridge(), edgeContinuity: Object.fromEntries(left.map((r) => [fillEdgeKey(r), "g1"])) } as Feature], "W");
  check("one edge tangent, the other touching: in between", !half.err && area(half.body) > area(g0.body) + 0.1 && area(half.body) < area(g1.body) - 0.1, { err: half.err, a: [area(g0.body), area(half.body), area(g1.body)] });
  check("G2 builds, or says to try G1", (!g2.err && area(g2.body) > area(g0.body) + 0.5) || /G1/.test(g2.err ?? ""), { err: g2.err, a: area(g2.body) });
}

// An open boundary says so.
{
  const open = await after([loop, { ...fill(), boundary: [] } as Feature], "F");
  check("no boundary says why", !!open.err, open.err);
}

done();
