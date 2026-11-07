// Run: npx tsx tests/engine.test.ts - every feature type through the real engine.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import type { Feature, PlaneDef } from "../src/doc/types";
import { exportBodies, regenerate } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import { primitiveCage } from "../src/freeform/cage";

setOC(await (opencascade as unknown as () => Promise<any>)());

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const sketch = (id: string, plane: PlaneDef, entities: any[]): Feature => ({ id, name: id, type: "sketch", plane, entities });
const regions = (entities: any[]) => arrangement(entities).regions.map(regionRef);

const rect = [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 20, rotation: 0 }];
const circle = [{ id: "c", kind: "circle", center: [30, 10], radius: 5 }];
const base: Feature[] = [
  sketch("s1", XY, rect),
  { id: "e1", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "s1", regions: regions(rect) }, distance: 10, mode: "auto" },
];

const tests: [string, Feature[], (r: Awaited<ReturnType<typeof regenerate>>) => string][] = [
  ["extrude", base, (r) => `${r.bodies.length} body, ${r.bodies[0].faces.length} faces`],
  ["revolve 360 around Z offset", [sketch("s2", XZ, circle), { id: "rv", name: "Revolve", type: "revolve", source: { kind: "profile", sketch: "s2", regions: regions(circle) }, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: 360, mode: "new" }], (r) => `${r.bodies.length} body, ${r.bodies[0]?.faces.length} faces`],
  ["sweep circle along line", [
    sketch("s3", XY, [{ id: "c", kind: "circle", center: [0, 0], radius: 2 }]),
    sketch("s4", XZ, [{ id: "p", kind: "line", a: [0, 0], b: [0, 30] }]),
    { id: "sw", name: "Sweep", type: "sweep", source: { kind: "profile", sketch: "s3", regions: regions([{ id: "c", kind: "circle", center: [0, 0], radius: 2 }]) }, path: { kind: "sketch", sketch: "s4", entities: ["p"] }, mode: "new" },
  ], (r) => `${r.bodies.length} body, ${r.bodies[0]?.faces.length} faces`],
  ["loft rect → circle", [
    sketch("l1", XY, rect),
    sketch("l2", { ...XY, origin: [0, 0, 30] }, [{ id: "c", kind: "circle", center: [0, 0], radius: 8 }]),
    { id: "lo", name: "Loft", type: "loft", sections: [{ kind: "profile", sketch: "l1", regions: regions(rect) }, { kind: "profile", sketch: "l2", regions: regions([{ id: "c", kind: "circle", center: [0, 0], radius: 8 }]) }], ruled: false, mode: "new" },
  ], (r) => `${r.bodies.length} body, ${r.bodies[0]?.faces.length} faces`],
  ["shell open top", [...base, { id: "sh", name: "Shell", type: "shell", body: "e1", faces: [{ body: "e1", center: [0, 0, 10], normal: [0, 0, 1], area: 800 }], thickness: 2 }], (r) => `${r.bodies[0].faces.length} faces`],
  ["split by plane x=0", [...base, { id: "sp", name: "Split", type: "split", body: "e1", plane: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } }], (r) => `${r.bodies.length} bodies`],
  ["mirror copy", [...base, { id: "mi", name: "Mirror", type: "transform", bodies: ["e1"], copy: true, op: { kind: "mirror", plane: { origin: [30, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] } } }], (r) => `${r.bodies.length} bodies`],
  ["linear pattern x3", [...base, { id: "lp", name: "Pattern", type: "transform", bodies: ["e1"], copy: true, op: { kind: "linear", dir: [0, 1, 0], spacing: 30, count: 3 } }], (r) => `${r.bodies.length} bodies`],
  ["circular pattern x4", [...base, { id: "cp", name: "Pattern", type: "transform", bodies: ["e1"], copy: true, op: { kind: "circular", axis: { origin: [60, 0, 0], dir: [0, 0, 1] }, count: 4, angle: 360 } }], (r) => `${r.bodies.length} bodies`],
  ["move + rotate", [...base, { id: "mv", name: "Move", type: "transform", bodies: ["e1"], copy: false, op: { kind: "move", translate: [0, 0, 5], rotate: { origin: [0, 0, 0], axis: [0, 0, 1], angle: 45 } } }], (r) => `${r.bodies.length} body, zmin=${Math.min(...Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 2)).toFixed(1)}`],
  ["scale x2", [...base, { id: "sc", name: "Scale", type: "transform", bodies: ["e1"], copy: false, op: { kind: "scale", center: [0, 0, 0], factor: 2 } }], (r) => `zmax=${Math.max(...Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 2)).toFixed(1)}`],
  ["offset top face of its own body (+5 → 6 faces)", [...base, { id: "of", name: "Offset", type: "extrude", source: { kind: "face", face: { body: "e1", center: [0, 0, 10], normal: [0, 0, 1], area: 800 } }, distance: 5, mode: "auto", target: "e1" }], (r) => {
    const zmax = Math.max(...Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 2));
    if (r.bodies[0].faces.length !== 6 || Math.abs(zmax - 15) > 1e-6) throw new Error(`${r.bodies[0].faces.length} faces, zmax ${zmax}`);
    return `zmax=${zmax}`;
  }],
  ["move face: tilt top 10°", [...base, { id: "mf", name: "Move face", type: "moveFace", face: { body: "e1", center: [0, 0, 10], normal: [0, 0, 1], area: 800 }, translate: [0, 0, 0], rotate: { origin: [0, 0, 10], axis: [0, 1, 0], angle: 10 } }], (r) => {
    const zmax = Math.max(...Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 2));
    if (Math.abs(zmax - (10 + 20 * Math.tan(Math.PI / 18))) > 1e-3) throw new Error(`zmax ${zmax}`);
    return `zmax=${zmax.toFixed(2)}`;
  }],
  ["move edge up 5 (faces tilt)", [...base, { id: "me", name: "Move edge", type: "moveFace", edge: { body: "e1", mid: [20, 0, 10], dir: [0, 1, 0], length: 20 }, translate: [0, 0, 5] }], (r) => {
    const b = r.bodies[0];
    const zmax = Math.max(...Array.from(b.positions).filter((_, i) => i % 3 === 2));
    if (b.faces.length !== 6 || Math.abs(zmax - 15) > 1e-3) throw new Error(`${b.faces.length} faces, zmax ${zmax}`);
    return `zmax=${zmax.toFixed(2)}`;
  }],
  ["move one corner of the box up 5 (only that corner rises)", [...base, { id: "mvv", name: "Move vertex", type: "moveFace", vertex: { body: "e1", at: [20, 10, 10] }, translate: [0, 0, 5] }], (r) => {
    const b = r.bodies[0];
    const pos = b.positions;
    let corner = -Infinity, other = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.hypot(pos[i] - 20, pos[i + 1] - 10) < 1e-6) corner = Math.max(corner, pos[i + 2]);
      if (Math.hypot(pos[i] + 20, pos[i + 1] + 10) < 1e-6) other = Math.max(other, pos[i + 2]);
    }
    if (Math.abs(corner - 15) > 1e-6 || Math.abs(other - 10) > 1e-6 || b.openEdges.length) throw new Error(`corner ${corner}, opposite ${other}, open ${b.openEdges.length}`);
    return `corner z=${corner.toFixed(2)}, opposite corner z=${other.toFixed(2)}`;
  }],
  ["move one corner along X: only the point moves, its edge neighbours stay", [...base, { id: "mvx", name: "Move vertex", type: "moveFace", vertex: { body: "e1", at: [20, 10, 10] }, translate: [5, 0, 0] }], (r) => {
    const b = r.bodies[0];
    const pos = b.positions;
    const has = (x: number, y: number, z: number) => { for (let i = 0; i < pos.length; i += 3) if (Math.hypot(pos[i] - x, pos[i + 1] - y, pos[i + 2] - z) < 1e-6) return true; return false; };
    // The corners next to it along the edges (below it and beside it) haven't moved.
    if (!has(25, 10, 10) || !has(20, 10, 0) || !has(20, -10, 10) || has(25, 10, 0) || b.openEdges.length) throw new Error(`moved ${has(25, 10, 10)}, below ${has(20, 10, 0)}, open ${b.openEdges.length}`);
    return `${b.faces.length} faces`;
  }],
  ["extrude (auto) through another body cuts a hole in it, no new body", [...base,
    sketch("hole", { ...XY, origin: [0, 0, -5] }, [{ id: "hc", kind: "circle", center: [5, 0], radius: 3 }]),
    { id: "he", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "hole", regions: regions([{ id: "hc", kind: "circle", center: [5, 0], radius: 3 }]) }, distance: 30, mode: "auto" }], (r) => {
    if (r.bodies.length !== 1 || r.bodies[0].faces.length !== 7) throw new Error(`${r.bodies.length} bodies, ${r.bodies[0]?.faces.length} faces`);
    return "1 body, 7 faces (hole through)";
  }],
  ["extrude (new) through another body keeps both", [...base,
    sketch("hole", { ...XY, origin: [0, 0, -5] }, [{ id: "hc", kind: "circle", center: [5, 0], radius: 3 }]),
    { id: "he", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "hole", regions: regions([{ id: "hc", kind: "circle", center: [5, 0], radius: 3 }]) }, distance: 30, mode: "new" }], (r) => {
    if (r.bodies.length !== 2) throw new Error(`${r.bodies.length} bodies`);
    return "2 bodies";
  }],
  ["union of bodies that touch is one body", [...base, sketch("near", XY, [{ id: "nr", kind: "rect", center: [25, 0], w: 10, h: 10, rotation: 0 }]),
    { id: "ne", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "near", regions: regions([{ id: "nr", kind: "rect", center: [25, 0], w: 10, h: 10, rotation: 0 }]) }, distance: 10, mode: "new" },
    { id: "un", name: "Union", type: "boolean", op: "union", target: "e1", tools: ["ne"] }], (r) => {
    if (r.errors.length || r.bodies.length !== 1) throw new Error(`${r.bodies.length} bodies, ${r.errors.map((e) => e.message)}`);
    return "1 body";
  }],
  ["delete fillet edge's face", [...base,
    { id: "fi", name: "Fillet", type: "fillet", edges: [{ body: "e1", mid: [20, 0, 10], dir: [0, 1, 0], length: 20 }], radius: 2 },
    { id: "dg", name: "Delete", type: "deleteGeom", body: "e1", faces: [], edges: [{ body: "e1", mid: [20, 0, 8], dir: [0, 1, 0], length: 20 }], vertices: [] }], (r) => {
    if (r.bodies[0].faces.length !== 6) throw new Error(`${r.bodies[0].faces.length} faces`);
    return "6 faces";
  }],
  ["freeform sphere → one closed body", [{ id: "ff", name: "Freeform", type: "freeform", cage: primitiveCage("sphere") }], (r) => {
    if (r.bodies.length !== 1 || r.bodies[0].openEdges.length) throw new Error(`${r.bodies.length} bodies, ${r.bodies[0]?.openEdges.length} open edges`);
    return `${r.bodies[0].faces.length} faces`;
  }],
  ["scale the top face ×0.5 in its plane → tapered (sides tilt)", [...base, { id: "sf", name: "Scale Face", type: "scaleFace", face: { body: "e1", center: [0, 0, 10], normal: [0, 0, 1], area: 800 }, u: [1, 0, 0], factors: [0.5, 0.5] }], (r) => {
    const b = r.bodies[0];
    const top = b.faces.find((f) => f.normal[2] > 0.999)!;
    if (Math.abs(top.area - 200) > 1e-3 || b.faces.length !== 6) throw new Error(`top area ${top.area}, ${b.faces.length} faces`);
    return `top area ${top.area.toFixed(1)}`;
  }],
  ["replace the top face with a plane 5 higher", [...base, { id: "rf", name: "Replace", type: "replaceFace", face: { body: "e1", center: [0, 0, 10], normal: [0, 0, 1], area: 800 }, plane: { origin: [0, 0, 15], normal: [0, 0, -1], xDir: [1, 0, 0] } }], (r) => {
    const zmax = Math.max(...Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 2));
    if (Math.abs(zmax - 15) > 1e-6 || r.bodies[0].faces.length !== 6) throw new Error(`zmax ${zmax}`);
    return `zmax=${zmax}`;
  }],
  ["freeform: move, then stretch ×2 along X (rebuilt from the cage)", [
    { id: "ffx", name: "Freeform", type: "freeform", cage: primitiveCage("sphere") },
    { id: "mvx", name: "Move", type: "transform", bodies: ["ffx"], copy: false, op: { kind: "move", translate: [100, 0, 0] } },
    { id: "sx", name: "Scale XYZ", type: "transform", bodies: ["ffx"], copy: false, op: { kind: "scaleXYZ", center: [100, 0, 20], factors: [2, 1, 1] } },
  ], (r) => {
    const xs = Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 0);
    const ys = Array.from(r.bodies[0].positions).filter((_, i) => i % 3 === 1);
    const w = Math.max(...xs) - Math.min(...xs);
    const d = Math.max(...ys) - Math.min(...ys);
    if (Math.abs(w / d - 2) > 0.02 || Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - 100) > 0.1) throw new Error(`w ${w} d ${d}`);
    return `width ${w.toFixed(1)} vs depth ${d.toFixed(1)}`;
  }],
  ["construction plane offset from face", [...base, { id: "pl", name: "Plane", type: "plane", plane: XY, face: { body: "e1", center: [0, 0, 10], normal: [0, 0, 1], area: 800 }, offset: 5 }], (r) => `plane z=${r.planes[0]?.plane.origin[2]}`],
];

let failed = 0;
for (const [name, features, describe] of tests) {
  try {
    const r = await regenerate(features);
    if (r.errors.length) throw new Error(r.errors.map((e) => `${e.featureId}: ${e.message}`).join("; "));
    console.log("ok  ", name, "-", describe(r));
  } catch (e) {
    failed++;
    console.log("FAIL", name, "-", e instanceof Error ? e.message : e);
  }
}
// A line across the top face splits it into two regions (with the face outline).
{
  const top = { body: "e1", center: [0, 0, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], area: 800 };
  const plane: PlaneDef = { origin: [0, 0, 10], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const line = [{ id: "l", kind: "line", a: [5, -15], b: [5, 15] }];
  const withSketch: Feature[] = [...base, { id: "sf", name: "sf", type: "sketch", plane, attachedTo: top, entities: line as any }];
  const r1 = await regenerate(withSketch);
  const curves = [...line, ...(r1.sketchBoundaries.sf ?? [])] as any[];
  const regs = arrangement(curves).regions;
  const small = regs.sort((a, b) => a.area - b.area)[0];
  const r2 = await regenerate([...withSketch, { id: "ex", name: "ex", type: "extrude", source: { kind: "profile", sketch: "sf", regions: [regionRef(small)] }, distance: 5, mode: "auto", target: "e1" }]);
  // Top face is 40 × 20 (x −20…20); the line at x = 5 leaves 15 × 20 = 300 and 25 × 20 = 500.
  const ok = regs.length === 2 && Math.round(small.area) === 300 && !r2.errors.length && r2.bodies[0].faces.length > 6;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "line across a face → 2 regions, extrude one:", regs.map((r) => Math.round(r.area)).join("/"), `${r2.bodies[0]?.faces.length} faces`, r2.errors.map((e) => e.message).join());
}

// A plain box edge can't be deleted: a readable error, the body stays.
{
  const r = await regenerate([...base, { id: "dg", name: "Delete", type: "deleteGeom", body: "e1", faces: [], edges: [{ body: "e1", mid: [20, 0, 10], dir: [0, 1, 0], length: 20 }], vertices: [] }]);
  const ok = r.errors.length === 1 && r.bodies.length === 1 && r.bodies[0].faces.length === 6;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "delete box edge refused:", r.errors.map((e) => e.message).join());
}

// Shell a freeform (open at its top patch): a closed, hollow body.
{
  const feats: Feature[] = [{ id: "ffs", name: "Freeform", type: "freeform", cage: primitiveCage("box") }];
  const b0 = (await regenerate(feats)).bodies[0];
  const top = b0.faces.reduce((bi, f, i) => (f.center[2] > b0.faces[bi].center[2] ? i : bi), 0);
  const f = b0.faces[top];
  const r = await regenerate([...feats, { id: "shf", name: "Shell", type: "shell", body: "ffs", faces: [{ body: "ffs", center: f.center, normal: f.normal, area: f.area }], thickness: 2 }]);
  const ok = !r.errors.length && r.bodies[0].faces.length > 40 && r.bodies[0].openEdges.length === 0;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "shell a freeform:", `${b0.faces.length} → ${r.bodies[0].faces.length} faces`, r.errors.map((e) => e.message).join());
}

// XYZ scale of an ordinary body: a clear message, the body stays.
{
  const r = await regenerate([...base, { id: "sx2", name: "Scale XYZ", type: "transform", bodies: ["e1"], copy: false, op: { kind: "scaleXYZ", center: [0, 0, 0], factors: [2, 1, 1] } }]);
  const ok = r.errors.length === 1 && /freeform/.test(r.errors[0].message) && r.bodies.length === 1;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "XYZ scale on a regular body explains why not:", r.errors.map((e) => e.message).join());
}

// Union of bodies that don't touch: refused with a clear message.
{
  const r = await regenerate([...base, sketch("far", XY, [{ id: "fr", kind: "rect", center: [100, 0], w: 10, h: 10, rotation: 0 }]),
    { id: "fe", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "far", regions: regions([{ id: "fr", kind: "rect", center: [100, 0], w: 10, h: 10, rotation: 0 }]) }, distance: 10, mode: "new" },
    { id: "un", name: "Union", type: "boolean", op: "union", target: "e1", tools: ["fe"] }]);
  const ok = r.errors.some((e) => e.featureId === "un" && /don't touch/.test(e.message));
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "union of bodies that don't touch is refused");
}

// A profile with a spline starting on the revolve axis turns (no Travel needed).
{
  const prof = [
    { id: "ax", kind: "line", a: [0, 0], b: [60, 0] },
    { id: "sp", kind: "spline", points: [[60, 0], [30, 40], [50, 80], [60, 160]], closed: false, mode: "fit" },
    { id: "t", kind: "line", a: [60, 160], b: [-10, 160] },
    { id: "l1", kind: "line", a: [-10, 160], b: [-10, 80] },
    { id: "l2", kind: "line", a: [-10, 80], b: [20, 80] },
    { id: "l3", kind: "line", a: [20, 80], b: [20, 20] },
    { id: "l4", kind: "line", a: [20, 20], b: [0, 20] },
    { id: "l5", kind: "line", a: [0, 20], b: [0, 0] },
  ];
  const r = await regenerate([sketch("rv", XY, prof), { id: "rev", name: "Revolve", type: "revolve", source: { kind: "profile", sketch: "rv", regions: regions(prof) }, axis: { origin: [0, 0, 0], dir: [1, 0, 0], ref: { kind: "sketchLine", sketch: "rv", entity: "ax" } }, angle: 360, mode: "auto" } as Feature]);
  const ok = !r.errors.length && r.bodies.length === 1;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "revolve: spline leaving the axis", r.errors.map((e) => e.message).join());
}

// Extruding a ring drawn from a body's own edge (a hair off its surface) still cuts through it.
{
  const ringBody = [{ id: "r1", kind: "rect", center: [60, 65], w: 60, h: 50, rotation: 0 }];
  const XZn: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
  const ring = [
    { id: "o", kind: "circle", center: [0.0000013696, -0.00000046], radius: 89.9999986303581 },
    { id: "i", kind: "circle", center: [0.0000013696, -0.00000046], radius: 79.9999986303581 },
  ];
  const ringRegion = arrangement(ring as any).regions.filter((g) => g.holes.length).map(regionRef);
  const r = await regenerate([
    sketch("b", XY, ringBody),
    { id: "rb", name: "Revolve", type: "revolve", source: { kind: "profile", sketch: "b", regions: regions(ringBody) }, axis: { origin: [0, 0, 0], dir: [0, 1, 0] }, angle: 360, mode: "auto" },
    sketch("c", XZn, ring),
    { id: "cut", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "c", regions: ringRegion }, distance: -61, mode: "auto" },
  ]);
  const ok = !r.errors.length && r.bodies.length === 1 && r.bodies[0].faces.length > 4;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "extrude through a body from its own (projected) edge cuts it", r.bodies.length, r.errors.map((e) => e.message).join());
}

// Closed solids report no open edges.
{
  const r = await regenerate(base);
  const ok = r.bodies[0].openEdges.length === 0;
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", "closed box has no open edges:", r.bodies[0].openEdges.length);
}

const stl = await exportBodies(base, "stl");
console.log("ok   export stl", stl.size, "bytes");
process.exit(failed ? 1 : 0);
