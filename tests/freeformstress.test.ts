// Run: npx tsx tests/freeformstress.test.ts [rounds] [seed]
//
// Pushes freeforms to the limit: random cage pulls (small, huge, through the
// body, onto each other), refined cages, holes filled, sheets thickened - and
// the results combined with boxes, cylinders and other freeforms. A step may
// be refused with a message; one that's accepted must leave valid, closed,
// single solids (or a clean sheet for an open surface).
import opencascade from "replicad-opencascadejs";
import { getOC, measureArea, measureVolume, setOC, type Shape3D } from "replicad";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import { boxCage, cylinderCage, isClosed, planeCage, refineCage, sphereCage, type Cage } from "../src/freeform/cage";
import type { Feature, PlaneDef, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();

const ROUNDS = Number(process.argv[2] ?? 12);
let seed = Number(process.argv[3] ?? 1);
const R = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(R() * a.length)];
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };

function count(s: Shape3D, kind: "SOLID" | "SHELL"): number {
  const ex = new oc.TopExp_Explorer(s.wrapped, oc.TopAbs_ShapeEnum[`TopAbs_${kind}`], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  let n = 0;
  for (; ex.More(); ex.Next()) n++;
  ex.delete();
  return n;
}

function problems(s: Shape3D, solid: boolean, oe: number, mayPart = false): string[] {
  const out: string[] = [];
  if (!shapeValid(s)) out.push("invalid");
  if (solid) {
    const n = count(s, "SOLID");
    if (n < 1 || (n > 1 && !mayPart)) out.push(`${n} solids`);
    if (oe) out.push(`${oe} open edges`);
    const v = measureVolume(s);
    if (!(v > 1e-6)) out.push(`volume ${v.toFixed(3)}`);
  } else if (count(s, "SHELL") < 1) out.push("no surface");
  const areas = s.faces.map((f) => measureArea(f));
  const total = areas.reduce((a, b) => a + b, 0);
  const tiny = areas.filter((a) => a < total * 1e-7).length;
  if (tiny) out.push(`${tiny} hair-thin faces`);
  return out;
}

// --------------------------------------------------------- cage mischief

const base = (): { cage: Cage; name: string } =>
  pick([
    () => ({ cage: boxCage([40, 30, 20], 2), name: "box" }),
    () => ({ cage: boxCage([30, 30, 30], 3), name: "box 3×3" }),
    () => ({ cage: sphereCage(40), name: "sphere" }),
    () => ({ cage: cylinderCage(30, 40, 3), name: "cylinder" }),
    () => ({ cage: refineCage(boxCage([40, 40, 20], 2)), name: "refined box" }),
    () => ({ cage: planeCage([40, 40], 4), name: "sheet" }),
  ])();

/** One random edit of the cage (returns a label). */
function mischief(c: Cage): string {
  const v = Math.floor(R() * c.verts.length);
  const kind = pick(["pull", "pull", "pull far", "through", "onto neighbour", "flatten face", "squash all", "twist"]);
  const P = c.verts;
  const centre = P.reduce((s, p) => [s[0] + p[0] / P.length, s[1] + p[1] / P.length, s[2] + p[2] / P.length] as Vec3, [0, 0, 0] as Vec3);
  switch (kind) {
    case "pull":
      P[v] = P[v].map((x) => x + (R() - 0.5) * 20) as Vec3;
      return `pull point ${v}`;
    case "pull far":
      P[v] = P[v].map((x) => x + (R() - 0.5) * 400) as Vec3;
      return `pull point ${v} far away`;
    case "through": {
      // Out the other side of the body.
      P[v] = P[v].map((x, k) => centre[k] - (x - centre[k]) * 1.5) as Vec3;
      return `push point ${v} through the body`;
    }
    case "onto neighbour": {
      const f = c.faces.find((q) => q.includes(v))!;
      const w = f[(f.indexOf(v) + 1) % 4];
      P[v] = [...P[w]] as Vec3;
      return `point ${v} onto its neighbour ${w}`;
    }
    case "flatten face": {
      const f = pick(c.faces);
      const m = f.reduce((s, i) => [s[0] + P[i][0] / 4, s[1] + P[i][1] / 4, s[2] + P[i][2] / 4] as Vec3, [0, 0, 0] as Vec3);
      for (const i of f) P[i] = [...m] as Vec3;
      return "a face squashed to a point";
    }
    case "squash all": {
      const k = Math.floor(R() * 3);
      for (const p of P) p[k] = centre[k] + (p[k] - centre[k]) * 0.01;
      return "whole cage squashed flat";
    }
    default: {
      // Top half turned 170° against the bottom.
      const a = (170 * Math.PI) / 180;
      for (const p of P)
        if (p[2] > centre[2]) {
          const x = p[0] - centre[0];
          const y = p[1] - centre[1];
          p[0] = centre[0] + x * Math.cos(a) - y * Math.sin(a);
          p[1] = centre[1] + x * Math.sin(a) + y * Math.cos(a);
        }
      return "top twisted 170°";
    }
  }
}

// ----------------------------------------------------------------- runs

const fails: string[] = [];
const refusedBy = new Map<string, number>();
let accepted = 0;
let slow = 0;
const XYrect = (w: number, h: number, cx = 0, cy = 0) => [{ id: "r", kind: "rect", center: [cx, cy], w, h, rotation: 0 }];

for (let k = 0; k < ROUNDS; k++) {
  const b = base();
  const cage = structuredClone(b.cage);
  const trail = [b.name];
  const edits = 1 + Math.floor(R() * 3);
  for (let i = 0; i < edits; i++) trail.push(mischief(cage));
  const solid = isClosed(cage);
  const ff: Feature = { id: "ff", name: "Freeform", type: "freeform", cage, ...(solid ? {} : { surface: true, ...(R() < 0.7 ? { thickness: 1 + R() * 4, thickSide: pick(["up", "down", "both"] as const) } : {}) }) } as Feature;
  const thick = solid || !!(ff as any).thickness;
  // Something to combine it with.
  const partner = pick(["none", "box", "cylinder", "freeform"]);
  const features: Feature[] = [ff];
  if (partner === "box" || partner === "cylinder") {
    const es = partner === "box" ? XYrect(20, 20, 10, 5) : [{ id: "c", kind: "circle", center: [5, 0], radius: 8 }];
    features.push({ id: "sk", name: "Sketch", type: "sketch", plane: XY, entities: es } as Feature);
    features.push({ id: "b2", name: "Other", type: "extrude", source: { kind: "profile", sketch: "sk", regions: arrangement(es as any).regions.map(regionRef) }, distance: 35, mode: "new" } as Feature);
  } else if (partner === "freeform") {
    const other = sphereCage(30, [12, 6, 4]);
    features.push({ id: "b2", name: "Blob", type: "freeform", cage: other } as Feature);
  }
  if (partner !== "none" && thick) {
    const op = pick(["union", "subtract", "intersect"] as const);
    trail.push(`${op} with a ${partner}`);
    features.push({ id: "bo", name: "Boolean", type: "boolean", op, target: R() < 0.5 ? "ff" : "b2", tools: [R() < 0.5 ? "b2" : "ff"].filter((x, _, a) => x !== "") } as Feature);
    const last = features[features.length - 1] as any;
    if (last.tools[0] === last.target) last.tools = [last.target === "ff" ? "b2" : "ff"];
  }
  const t0 = performance.now();
  let res: any;
  try {
    res = await regenerate(features);
  } catch (e) {
    fails.push(`round ${k}: threw ${(e as Error).message} - ${trail.join(", ")}`);
    continue;
  }
  const dt = performance.now() - t0;
  if (dt > 8000) slow++;
  const errs = (res?.errors ?? []) as { feature: string; message: string }[];
  for (const e of errs) refusedBy.set(e.message.slice(0, 70), (refusedBy.get(e.message.slice(0, 70)) ?? 0) + 1);
  if (errs.length) continue;
  accepted++;
  for (const [id, s] of debugBodies()) {
    const isSheet = id === "ff" && !thick && !features.some((f) => f.type === "boolean");
    const info = (res.bodies ?? []).find((x: any) => x.id === id);
    const bad = problems(s, !isSheet, info?.openEdges?.length ?? 0, features.some((f) => f.type === "boolean" && (f as any).op !== "union"));
    if (bad.length) {
      fails.push(`round ${k}: body ${id}: ${bad.join(", ")} - ${trail.join(", ")}`);
      if (process.env.FF_DUMP) (await import("node:fs")).writeFileSync(process.env.FF_DUMP, JSON.stringify(features));
      break;
    }
  }
}

for (const f of fails) console.log("FAIL", f);
console.log(`${accepted} accepted, ${ROUNDS - accepted - fails.filter((f) => f.includes("threw")).length} refused, ${fails.length} broke${slow ? `, ${slow} took over 8 s` : ""}`);
for (const [m, n] of [...refusedBy].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${m}`);
process.exit(fails.length ? 1 : 0);
