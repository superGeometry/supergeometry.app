// Run: npx tsx tests/projectfuzz.test.ts [projects] [steps] [seed]
//
// Whole projects built at random from everything there is - sketches (with
// constraints) on the ground and on faces, extrudes joined / cut / new,
// revolves, freeforms, booleans, fillets, shells, face moves, moves, scales,
// patterns, mirrors, splits, repairs - and then abused like a user would:
// earlier History steps deleted or changed, the project saved and loaded,
// exported. After every step: every body a clean solid, a saved-and-loaded
// project rebuilding to exactly the same bodies, nothing thrown.
import opencascade from "replicad-opencascadejs";
import { measureArea, setOC, type Shape3D } from "replicad";
import { debugBodies, exportBodies, regenerate } from "../src/kernel/engine";
import { migrate } from "../src/doc/store";
import { emptyDoc, type Feature, type PlaneDef, type Vec3 } from "../src/doc/types";
import { arrangement, regionRef } from "../src/sketch/regions";
import { solve } from "../src/sketch/constraints";
import { boxCage, sphereCage, cylinderCage } from "../src/freeform/cage";
import { problems, r2, randomStep, rng, solids, XY } from "./fuzzkit";

setOC(await (opencascade as unknown as () => Promise<any>)());

const PROJECTS = Number(process.argv[2] ?? 6);
const STEPS = Number(process.argv[3] ?? 14);
const SEED = Number(process.argv[4] ?? 1);

const sig = (m: Map<string, Shape3D>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}:${v.faces.length}:${v.faces.map((f) => measureArea(f)).reduce((a, b) => a + b, 0).toFixed(3)}`).join("|");

function sketchOn(R: () => number, id: string, plane: PlaneDef, size: number): Feature[] {
  // A rectangle of lines with joins, H/V and a size - solved like the sketch tool does - or a circle.
  const w = r2(size * (0.2 + R() * 0.5));
  const h = r2(size * (0.2 + R() * 0.5));
  const cx = r2((R() - 0.5) * size * 0.3);
  const cy = r2((R() - 0.5) * size * 0.3);
  let entities: any[];
  let constraints: any[] | undefined;
  if (R() < 0.55) {
    const p: [number, number][] = [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
    entities = p.map((q, i) => ({ id: `${id}l${i}`, kind: "line", a: q, b: p[(i + 1) % 4] }));
    constraints = [
      ...entities.map((e, i) => ({ id: `${id}c${i}`, type: "coincident", pts: [{ e: e.id, p: "b" }, { e: entities[(i + 1) % 4].id, p: "a" }] })),
      { id: `${id}h`, type: "horizontal", curves: [entities[0].id] },
      { id: `${id}v`, type: "vertical", curves: [entities[1].id] },
      { id: `${id}w`, type: "dim", curves: [entities[0].id], prop: "length", value: w },
    ];
    entities = solve(entities, constraints).entities as any[];
  } else entities = [{ id: `${id}o`, kind: "circle", center: [cx, cy], radius: r2(Math.min(w, h) / 2) }];
  return [{ id, name: "Sketch", type: "sketch", plane, entities, ...(constraints ? { constraints } : {}) } as Feature];
}

/** A random step of any kind (null: nothing fits right now). */
function anyStep(R: () => number, i: number, res: any, features: Feature[], size: number): Feature[] | null {
  const bodies = res.bodies as any[];
  const id = `p${i}`;
  const roll = R();
  const b = bodies.length ? bodies[Math.floor(R() * bodies.length)] : null;
  if (roll < 0.35 && b) {
    const f = randomStep(R, i, res, size);
    return f ? [f] : null;
  }
  if (roll < 0.55) {
    // A sketch on the ground or on a flat face, extruded new / joined / cut.
    const flat = b?.faces.filter((x: any) => x.type === "PLANE") ?? [];
    const face = flat.length && R() < 0.7 ? flat[Math.floor(R() * flat.length)] : null;
    const n = face?.normal as Vec3 | undefined;
    const plane: PlaneDef = face ? { origin: face.center, normal: n!, xDir: Math.abs(n![2]) < 0.9 ? [n![1], -n![0], 0].map((v, _, a) => v / Math.hypot(...a)) as Vec3 : [1, 0, 0] } : XY;
    const sk = sketchOn(R, `${id}s`, plane, size);
    const regions = arrangement((sk[0] as any).entities).regions.map(regionRef);
    if (!regions.length) return null;
    const mode = face ? (["join", "cut", "new", "auto"] as const)[Math.floor(R() * 4)] : "new";
    const d = r2((R() < 0.8 ? 1 : -1) * size * (0.1 + R() * 0.5));
    return [...sk, { id, name: "Extrude", type: "extrude", source: { kind: "profile", sketch: `${id}s`, regions }, distance: d, mode, ...(face && mode !== "new" ? { target: b.id } : {}) } as Feature];
  }
  if (roll < 0.62) {
    // A revolved part beside the others.
    const XZ: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] };
    const x0 = r2(size * (0.6 + R()));
    const es = [{ id: `${id}r`, kind: "rect", center: [x0, size * 0.2], w: r2(size * 0.2), h: r2(size * 0.3), rotation: 0 }];
    return [
      { id: `${id}s`, name: "Sketch", type: "sketch", plane: XZ, entities: es } as Feature,
      { id, name: "Revolve", type: "revolve", source: { kind: "profile", sketch: `${id}s`, regions: arrangement(es as any).regions.map(regionRef) }, axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, angle: R() < 0.5 ? 360 : r2(60 + R() * 250), mode: "new" } as Feature,
    ];
  }
  if (roll < 0.7) {
    // A freeform, a little pulled, near the parts.
    const at: Vec3 = [r2((R() - 0.5) * size), r2((R() - 0.5) * size), r2(R() * size * 0.3)];
    const cage = [() => boxCage([size * 0.5, size * 0.4, size * 0.3], 2, at), () => sphereCage(size * 0.5, at), () => cylinderCage(size * 0.4, size * 0.5, 2, at)][Math.floor(R() * 3)]();
    for (let k = 0; k < 3; k++) {
      const v = Math.floor(R() * cage.verts.length);
      cage.verts[v] = cage.verts[v].map((x) => x + (R() - 0.5) * size * 0.15) as Vec3;
    }
    return [{ id, name: "Freeform", type: "freeform", cage } as Feature];
  }
  if (roll < 0.82 && b) {
    // Moves, scales, patterns, mirrors (copies now and then).
    const k = Math.floor(R() * 5);
    const op =
      k === 0 ? { kind: "move", translate: [r2((R() - 0.5) * size), r2((R() - 0.5) * size), 0] as Vec3, ...(R() < 0.4 ? { rotate: { origin: [0, 0, 0] as Vec3, axis: [0, 0, 1] as Vec3, angle: r2(R() * 90) } } : {}) }
      : k === 1 ? { kind: "scale", center: [0, 0, 0] as Vec3, factor: r2(0.5 + R()) }
      : k === 2 ? { kind: "linear", dir: [1, 0, 0] as Vec3, spacing: r2(size * (0.3 + R())), count: 2 + Math.floor(R() * 3) }
      : k === 3 ? { kind: "circular", axis: { origin: [0, 0, 0], dir: [0, 0, 1] }, count: 3 + Math.floor(R() * 3), angle: 360 }
      : { kind: "mirror", plane: { origin: [r2(size * 0.3), 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] } };
    return [{ id, name: "Transform", type: "transform", bodies: [b.id], copy: k >= 2 || R() < 0.3, op } as Feature];
  }
  if (roll < 0.86 && b) return [{ id, name: "Repair", type: "repair", bodies: [b.id] } as Feature];
  if (roll < 0.94 && bodies.length >= 2) {
    const [t, u] = R() < 0.5 ? [bodies[0], bodies[1]] : [bodies[1], bodies[0]];
    return [{ id, name: "Boolean", type: "boolean", op: (["union", "subtract", "intersect"] as const)[Math.floor(R() * 3)], target: t.id, tools: [u.id] } as Feature];
  }
  return null;
}

const fails: string[] = [];
let steps = 0;
let refused = 0;
let deletes = 0;
let edits = 0;
let roundTrips = 0;
let exports = 0;
const slow: string[] = [];
const times: number[] = [];

async function rebuild(features: Feature[], what: string, project: number): Promise<any> {
  const t = performance.now();
  let r: any;
  try {
    r = await regenerate(features);
  } catch (e) {
    fails.push(`project ${project}: ${what}: threw ${(e as Error).message}`);
    return null;
  }
  const dt = performance.now() - t;
  times.push(dt);
  if (dt > 15000) slow.push(`${what} ${(dt / 1000).toFixed(1)} s`);
  // Every body a clean solid (pieces allowed: cuts and splits can part a body).
  for (const [id, s] of debugBodies()) {
    if (!solids(s)) continue; // an open surface on purpose
    const info = r.bodies.find((x: any) => x.id === id);
    const bad = problems(s, info?.openEdges?.length ?? 0, true, 1);
    if (bad.length) {
      fails.push(`project ${project}: after ${what}: body ${id}: ${bad.join(", ")}`);
      return null;
    }
  }
  return r;
}

for (let p = 0; p < PROJECTS; p++) {
  const R = rng(SEED * 7919 + p);
  const size = 40;
  let features: Feature[] = [];
  // Start from a plain block.
  const es = [{ id: "r0", kind: "rect", center: [0, 0], w: 40, h: 30, rotation: 0 }];
  features.push({ id: "sk0", name: "Sketch", type: "sketch", plane: XY, entities: es } as Feature);
  features.push({ id: "b0", name: "Block", type: "extrude", source: { kind: "profile", sketch: "sk0", regions: arrangement(es as any).regions.map(regionRef) }, distance: 20, mode: "new" } as Feature);
  let res = await rebuild(features, "start", p);
  if (!res) continue;
  for (let i = 0; i < STEPS; i++) {
    const add = anyStep(R, i, res, features, size);
    if (!add) continue;
    const next = [...features, ...add];
    const r = await rebuild(next, `step ${i} (${add.map((f) => f.name).join(" + ")})`, p);
    if (!r) break;
    steps++;
    if (r.errors.some((e: any) => add.some((f) => f.id === e.featureId))) {
      refused++;
      continue;
    }
    features = next;
    res = r;
    // Saved and loaded: the same bodies, exactly.
    if (R() < 0.35) {
      const before = sig(debugBodies());
      const doc = { ...emptyDoc(), features };
      const loaded = migrate(JSON.parse(JSON.stringify(doc)));
      const r2b = await rebuild(loaded.features, `reload after step ${i}`, p);
      if (r2b && sig(debugBodies()) !== before) fails.push(`project ${p}: saved and loaded after step ${i}: different bodies`);
      roundTrips++;
    }
    // A user deleting an earlier History step: the rest rebuilds (some steps
    // may stop with a message), but nothing breaks.
    if (R() < 0.15 && features.length > 3) {
      const k = 2 + Math.floor(R() * (features.length - 2));
      const cut = features.filter((_, j) => j !== k);
      await rebuild(cut, `deleting step ${features[k].name} (${k}) after step ${i}`, p);
      deletes++;
      res = (await rebuild(features, `back after the delete test ${i}`, p)) ?? res;
    }
    // Or changing an earlier value (a distance, a radius, a thickness).
    if (R() < 0.15) {
      const k = features.findIndex((f) => (f as any).distance !== undefined || (f as any).radius !== undefined || (f as any).thickness !== undefined);
      if (k >= 0) {
        const f = structuredClone(features[k]) as any;
        for (const key of ["distance", "radius", "thickness"]) if (f[key] !== undefined) f[key] = r2(f[key] * (0.4 + R() * 1.4));
        await rebuild(features.map((x, j) => (j === k ? f : x)), `changing ${features[k].name} after step ${i}`, p);
        edits++;
        res = (await rebuild(features, `back after the edit test ${i}`, p)) ?? res;
      }
    }
  }
  // Exported: STEP and STL come out with something in them.
  try {
    const t = performance.now();
    const step = await exportBodies(features, "step");
    const stl = await exportBodies(features, "stl");
    exports++;
    if (!(step.size > 100) || !(stl.size > 100)) fails.push(`project ${p}: export came out empty (STEP ${step.size} B, STL ${stl.size} B)`);
    const dt = performance.now() - t;
    if (dt > 15000) slow.push(`export ${(dt / 1000).toFixed(1)} s`);
  } catch (e) {
    if (res.bodies.length) fails.push(`project ${p}: export threw ${(e as Error).message}`);
  }
}

times.sort((a, b) => a - b);
for (const f of fails) console.log("FAIL", f);
for (const s of slow) console.log("SLOW", s);
console.log(`${steps} steps (${refused} refused with a message), ${roundTrips} save/load checks, ${deletes} earlier steps deleted, ${edits} earlier values changed, ${exports} exports; rebuild median ${(times[times.length >> 1] ?? 0).toFixed(0)} ms, 95% ${(times[Math.floor(times.length * 0.95)] ?? 0).toFixed(0)} ms; ${fails.length} broke`);
process.exit(fails.length ? 1 : 0);
