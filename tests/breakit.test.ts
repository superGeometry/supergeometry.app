// Run: npx tsx tests/breakit.test.ts [scenarios] [steps] [seed]
//
// Tries to break the geometry engine: random (but repeatable) sequences of
// edits on boxes, cylinders, L-shapes, plates with holes and revolved parts —
// offsets in and out (huge ones too), fillets and chamfers of any size, faces
// moved and tilted, corners and edges dragged, faces deleted, shells, booleans,
// face scaling, extrusions from faces. A step may fail with a message (that's
// fine: "can't do that"). A step that succeeds must leave every body a single,
// valid, closed solid with a sane volume and no hair-thin faces.
import opencascade from "replicad-opencascadejs";
import { getOC, measureArea, measureVolume, setOC, type Shape3D } from "replicad";
import { writeFileSync } from "node:fs";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import type { Feature, PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();

const SCENARIOS = Number(process.argv[2] ?? 10);
const STEPS = Number(process.argv[3] ?? 6);
const SEED = Number(process.argv[4] ?? 1);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
const r2 = (v: number) => Math.round(v * 100) / 100;

function solids(s: Shape3D): number {
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  for (; ex.More(); ex.Next()) n++;
  ex.delete();
  return n;
}

/** What's wrong with a body (empty: nothing). */
function problems(s: Shape3D, openEdges: number, mayPart: boolean, partsBefore: number): string[] {
  const out: string[] = [];
  if (openEdges) out.push(`${openEdges} open edges`);
  if (!shapeValid(s)) out.push("invalid solid");
  const n = solids(s);
  // Cuts, booleans and splits may leave a body in pieces (each piece still checked above/below).
  if (n === 0 || (n > Math.max(1, partsBefore) && !mayPart)) out.push(`${n} solids in one body`);
  const v = measureVolume(s);
  if (!(v > 1e-6) || !Number.isFinite(v)) out.push(`volume ${v}`);
  const areas = s.faces.map((f) => measureArea(f));
  const total = areas.reduce((a, b) => a + b, 0);
  const tiny = areas.filter((a) => a < total * 1e-7).length;
  if (tiny) out.push(`${tiny} hair-thin faces`);
  return out;
}

function base(R: () => number, kind: number): Feature[] {
  const sk = (entities: any[], plane = XY): Feature => ({ id: "sk", name: "Sketch", type: "sketch", plane, entities });
  const ext = (entities: any[], d: number, pick?: (rs: any[]) => any[]): Feature => {
    const regs = arrangement(entities).regions.map(regionRef);
    return { id: "b1", name: "Base", type: "extrude", source: { kind: "profile", sketch: "sk", regions: pick ? pick(regs) : regs }, distance: d, mode: "new" } as Feature;
  };
  const w = r2(20 + R() * 40);
  const h = r2(15 + R() * 30);
  const d = r2(5 + R() * 30);
  switch (kind % 7) {
    case 5: {
      // A plate with a round pocket cut into its top, then its edges rounded.
      const es = [{ id: "r", kind: "rect", center: [0, 0], w, h, rotation: 0 }];
      const top: PlaneDef = { origin: [0, 0, d], xDir: [1, 0, 0], normal: [0, 0, 1] };
      const hole = [{ id: "c", kind: "circle", center: [r2(w / 5), 0], radius: r2(Math.min(w, h) / 5) }];
      return [
        sk(es),
        ext(es, d),
        { id: "sk2", name: "Sketch 2", type: "sketch", plane: top, entities: hole } as Feature,
        { id: "pk", name: "Pocket", type: "extrude", source: { kind: "profile", sketch: "sk2", regions: arrangement(hole as any).regions.map(regionRef) }, distance: r2(-d * 0.6), mode: "cut", target: "b1" } as Feature,
      ];
    }
    case 6: {
      // A box and a cylinder standing through it, joined.
      const es = [{ id: "r", kind: "rect", center: [0, 0], w, h, rotation: 0 }];
      const cyl = [{ id: "c", kind: "circle", center: [r2(w / 3), 0], radius: r2(Math.min(w, h) / 4) }];
      return [
        sk(es),
        ext(es, d),
        { id: "sk2", name: "Sketch 2", type: "sketch", plane: XY, entities: cyl } as Feature,
        { id: "b2", name: "Boss", type: "extrude", source: { kind: "profile", sketch: "sk2", regions: arrangement(cyl as any).regions.map(regionRef) }, distance: r2(d * 1.8), mode: "new" } as Feature,
        { id: "u", name: "Union", type: "boolean", op: "union", target: "b1", tools: ["b2"] } as Feature,
      ];
    }
    case 0: {
      const es = [{ id: "r", kind: "rect", center: [0, 0], w, h, rotation: 0 }];
      return [sk(es), ext(es, d)];
    }
    case 1: {
      const es = [{ id: "c", kind: "circle", center: [0, 0], radius: r2(w / 3) }];
      return [sk(es), ext(es, d)];
    }
    case 2: {
      // An L.
      const p: [number, number][] = [[0, 0], [w, 0], [w, h / 2], [w / 2, h / 2], [w / 2, h], [0, h]];
      const es = p.map((a, i) => ({ id: `l${i}`, kind: "line", a, b: p[(i + 1) % p.length] }));
      return [sk(es), ext(es, d)];
    }
    case 3: {
      // A plate with a hole: the ring only.
      const es = [{ id: "r", kind: "rect", center: [0, 0], w, h, rotation: 0 }, { id: "c", kind: "circle", center: [r2(w / 6), 0], radius: r2(Math.min(w, h) / 5) }];
      return [sk(es), ext(es, r2(d / 2), (rs) => [rs.sort((a: any, b: any) => b.a - a.a)[0]])];
    }
    default: {
      // A revolved part (a ring with a square section, round the Z axis).
      const es = [{ id: "r", kind: "rect", center: [r2(w / 2), r2(h / 2)], w: r2(w / 3), h: r2(h / 2), rotation: 0 }];
      const regs = arrangement(es).regions.map(regionRef);
      return [
        sk(es, XZ),
        { id: "b1", name: "Base", type: "revolve", source: { kind: "profile", sketch: "sk", regions: regs }, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: R() < 0.5 ? 360 : r2(90 + R() * 200), mode: "new" } as Feature,
      ];
    }
  }
}

/** A random edit of what's there now (or null when nothing fits). */
function randomStep(R: () => number, i: number, result: any, size: number): Feature | null {
  const bodies = result.bodies as any[];
  if (!bodies.length) return null;
  const b = bodies[Math.floor(R() * bodies.length)];
  const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(R() * xs.length)];
  const faceRef = (f: any) => ({ body: b.id, center: f.center, normal: f.normal, area: f.area });
  const edgeRef = (e: any) => ({ body: b.id, mid: e.mid, dir: e.dir, length: e.length });
  const flat = b.faces.filter((f: any) => f.type === "PLANE");
  const id = `s${i}`;
  const big = () => (R() < 0.15 ? 3 : 1); // now and then something absurd
  switch (Math.floor(R() * 13)) {
    case 0:
    case 1: {
      const f = pick(b.faces.filter((x: any) => x.type === "PLANE" || x.type === "CYLINDRE"));
      if (!f) return null;
      return { id, name: "Offset", type: "extrude", source: { kind: "face", face: faceRef(f) }, distance: r2((R() * 1.4 - 0.6) * size * 0.4 * big()), mode: "auto", target: b.id } as Feature;
    }
    case 2: {
      const es = b.edges.filter((e: any) => e.length > 1e-3);
      const n = 1 + Math.floor(R() * 3);
      const edges = Array.from({ length: n }, () => pick(es)).filter(Boolean).map(edgeRef);
      return { id, name: "Fillet", type: "fillet", edges, radius: r2((0.3 + R() * 6) * big()) } as Feature;
    }
    case 3: {
      const e = pick(b.edges.filter((x: any) => x.length > 1e-3));
      if (!e) return null;
      return { id, name: "Chamfer", type: "chamfer", edges: [edgeRef(e)], radius: r2((0.3 + R() * 5) * big()) } as Feature;
    }
    case 4: {
      const f = pick(flat);
      if (!f) return null;
      const t = r2((R() * 2 - 1) * size * 0.3 * big());
      const tilt = R() < 0.4 ? { origin: f.center, axis: Math.abs(f.normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], angle: r2((R() * 2 - 1) * 35) } : undefined;
      return { id, name: "Move face", type: "moveFace", face: faceRef(f), translate: f.normal.map((v: number) => r2(v * t)), rotate: tilt } as Feature;
    }
    case 5: {
      const e = pick(b.edges);
      if (!e) return null;
      return { id, name: "Move corner", type: "moveFace", vertex: { body: b.id, at: e.start }, translate: [0, 1, 2].map(() => r2((R() * 2 - 1) * size * 0.25 * big())) as Vec3 } as Feature;
    }
    case 6: {
      const e = pick(b.edges.filter((x: any) => x.type === "LINE"));
      if (!e) return null;
      return { id, name: "Move edge", type: "moveFace", edge: edgeRef(e), translate: [0, 1, 2].map(() => r2((R() * 2 - 1) * size * 0.2)) as Vec3 } as Feature;
    }
    case 7: {
      const f = pick(b.faces);
      if (!f) return null;
      return { id, name: "Delete face", type: "deleteGeom", body: b.id, faces: [faceRef(f)], edges: [], vertices: [] } as Feature;
    }
    case 8: {
      const f = pick(flat);
      return { id, name: "Shell", type: "shell", body: b.id, faces: f && R() < 0.8 ? [faceRef(f)] : [], thickness: r2((0.3 + R() * 3) * big()) } as Feature;
    }
    case 9: {
      const f = pick(flat);
      if (!f) return null;
      const n = f.normal as Vec3;
      const u: Vec3 = Math.abs(n[2]) < 0.9 ? [n[1], -n[0], 0] : [1, 0, 0];
      const l = Math.hypot(...u) || 1;
      return { id, name: "Scale face", type: "scaleFace", face: faceRef(f), u: u.map((v) => v / l) as Vec3, factors: [r2(0.3 + R() * 1.4), r2(0.3 + R() * 1.4)] } as Feature;
    }
    case 10: {
      // Something sticking out of / cut into a face: a new body from it, joined or cut.
      const f = pick(flat);
      if (!f) return null;
      return { id, name: "Extrude face", type: "extrude", source: { kind: "face", face: faceRef(f) }, distance: r2((R() * 2 - 1) * size * 0.5), mode: R() < 0.5 ? "join" : "cut", target: R() < 0.5 ? b.id : undefined } as Feature;
    }
    default: {
      // Two bodies: union / subtract / intersect them. One: make a second from a
      // face (a new body sticking out or in), or slice it in two with a plane.
      if (bodies.length >= 2) {
        const [t, u] = R() < 0.5 ? [bodies[0], bodies[1]] : [bodies[1], bodies[0]];
        const op = (["union", "subtract", "intersect"] as const)[Math.floor(R() * 3)];
        return { id, name: `Boolean ${op}`, type: "boolean", op, target: t.id, tools: [u.id] } as Feature;
      }
      if (R() < 0.3) {
        const c = b.faces[0]?.center ?? [0, 0, 0];
        const n: Vec3 = R() < 0.5 ? [1, 0, 0] : [0.3, 0.4, 0.866];
        return { id, name: "Split", type: "split", body: b.id, plane: { origin: c, normal: n, xDir: [0, 0, 1] } } as Feature;
      }
      const f = pick(flat);
      if (!f) return null;
      return { id, name: "New body from face", type: "extrude", source: { kind: "face", face: faceRef(f) }, distance: r2((R() * 1.6 - 0.6) * size * 0.5), mode: "new" } as Feature;
    }
  }
}

const failures: { scenario: number; step: string; problems: string[]; features: Feature[] }[] = [];
let ok = 0;
let refused = 0;
const refusedBy: Record<string, number> = {};
const refusedWhy: Record<string, number> = {};
const ONLY = process.env.BREAKIT_ONLY ? Number(process.env.BREAKIT_ONLY) : null;
for (let sc = 0; sc < SCENARIOS; sc++) {
  if (ONLY !== null && sc !== ONLY) {
    // (Keep the random sequence the same: nothing else uses it across scenarios.)
    continue;
  }
  const R = rng(SEED * 1000 + sc);
  let features = base(R, sc);
  let res: any = await regenerate(features);
  if (res.errors.length) {
    console.log(`scenario ${sc}: base failed: ${res.errors[0].message}`);
    continue;
  }
  const size = Math.max(...res.bodies[0].faces.map((f: any) => Math.max(...f.center.map(Math.abs)))) * 2 || 20;
  for (let st = 0; st < STEPS; st++) {
    const step = randomStep(R, st, res, size);
    if (!step) continue;
    const prevSolids = new Map(debugBodies());
    // What every body looks like now (its faces' areas): a step must never change an earlier result.
    const sig = (m: Map<string, Shape3D>) => [...m].map(([k, v]) => `${k}:${v.faces.map((f) => measureArea(f).toFixed(4)).join(",")}`).join("|");
    const sigBefore = sig(prevSolids);
    const next = [...features, step];
    let r: any;
    try {
      r = await regenerate(next);
    } catch (err) {
      failures.push({ scenario: sc, step: step.name, problems: [`threw: ${(err as Error).message}`], features: next });
      break;
    }
    const err = r.errors.find((e: any) => e.featureId === step.id);
    if (sig(prevSolids) !== sigBefore) {
      failures.push({ scenario: sc, step: step.name, problems: ["changed an earlier step's result"], features: next });
      console.log(`FAIL scenario ${sc} step ${st} (${step.name}): changed an earlier step's result${err ? " (refused)" : ""}`);
      break;
    }
    if (ONLY !== null) console.log(`  step ${st} ${step.name}: ${err ? "refused: " + err.message : "ok"} | ${r.bodies.map((b: any) => b.id + ":" + b.faces.length + "f").join(" ")}`);
    if (ONLY !== null && process.env.BREAKIT_DUMP) writeFileSync(`${process.env.BREAKIT_DUMP}-${st}.json`, JSON.stringify(next));
    if (err) {
      refused++;
      refusedBy[step.name] = (refusedBy[step.name] ?? 0) + 1;
      const why = `${step.name}: ${String(err.message).slice(0, 90)}`;
      refusedWhy[why] = (refusedWhy[why] ?? 0) + 1;
      continue; // a clear "can't" — fine; try something else
    }
    const solidsNow = new Map(debugBodies());
    const bad: string[] = [];
    for (const b of r.bodies) {
      const s = solidsNow.get(b.id);
      if (!s) continue;
      const mayPart = step.type === "boolean" || step.type === "split" || (step.type === "extrude" && !(step.source.kind === "face" && step.target === step.source.face.body && step.mode !== "new"));
      const prev = prevSolids.get(b.id);
      const p = problems(s, b.openEdges.length, mayPart, prev ? solids(prev) : 1);
      if (p.length) bad.push(`${b.name}: ${p.join(", ")}`);
    }
    if (bad.length) {
      failures.push({ scenario: sc, step: step.name, problems: bad, features: next });
      console.log(`FAIL scenario ${sc} step ${st} (${step.name}): ${bad.join("; ")}`);
      break;
    }
    ok++;
    features = next;
    res = r;
  }
}
// Only when asked (BREAKIT_OUT=file), so a normal run leaves nothing behind.
if (process.env.BREAKIT_OUT) writeFileSync(process.env.BREAKIT_OUT, JSON.stringify(failures, null, 1));
console.log(`${ok} edits ok, ${refused} refused (${JSON.stringify(refusedBy)}), ${failures.length} broke the model`);
const byStep: Record<string, number> = {};
for (const f of failures) byStep[f.step] = (byStep[f.step] ?? 0) + 1;
console.log("broken by:", JSON.stringify(byStep));
if (process.env.BREAKIT_WHY)
  for (const [k, n] of Object.entries(refusedWhy).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}× ${k}`);
if (failures.length) process.exit(1);
