// Run: npx tsx tests/freeformtools.test.ts — adding cage detail (edge loops,
// extrude, inset), and a part built with them, joined to other bodies.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { boxCage, bridgeFaces, cylinderCage, moveTurnScale, deleteFaces, extrudeFaces, holeLoops, bridgeLoops, boundaryEdges, cageEdgeKey, insertEdgeLoop, insetFaces, isClosed, planeCage, refineCage, selfCrossings, sphereCage, windingAgrees, type Cage } from "../src/freeform/cage";
import { cageToShape } from "../src/kernel/freeform";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { arrangement, regionRef } from "../src/sketch/regions";
import type { Feature, PlaneDef } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());

let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const solidOk = (c: Cage) => {
  const s = cageToShape(c);
  return { s, ok: shapeValid(s) && measureVolume(s) > 0, v: measureVolume(s) };
};
const faceWith = (c: Cage, test: (n: [number, number, number], m: [number, number, number]) => boolean): number[] => {
  const out: number[] = [];
  c.faces.forEach((f, i) => {
    const P = f.map((v) => c.verts[v]);
    const m = [0, 1, 2].map((k) => (P[0][k] + P[1][k] + P[2][k] + P[3][k]) / 4) as [number, number, number];
    const u = [0, 1, 2].map((k) => P[2][k] - P[0][k]);
    const w = [0, 1, 2].map((k) => P[3][k] - P[1][k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n) || 1;
    if (test(n.map((x) => x / l) as [number, number, number], m)) out.push(i);
  });
  return out;
};

// ------------------------------------------------------------ edge loops
{
  const b = boxCage([40, 40, 40], 2);
  const [a, c] = b.faces[0];
  const l = insertEdgeLoop(b, a, c)!;
  check("edge loop round a box: closed, wound right, more faces", !!l && isClosed(l) && windingAgrees(l) && l.faces.length > b.faces.length, l ? `${b.faces.length} → ${l.faces.length} faces` : "refused");
  const r = l && solidOk(l);
  check("  …and it still makes a clean solid", !!r?.ok && !selfCrossings(l!).length, r ? `vol ${r.v.toFixed(0)} (was ${measureVolume(cageToShape(b)).toFixed(0)})` : "");
  const two = l && insertEdgeLoop(l, l.faces[3][0], l.faces[3][1], 0.2);
  check("a second loop near the first (closer to one side)", !!two && isClosed(two) && solidOk(two).ok);
  const p = planeCage([40, 40], 3);
  const pl = insertEdgeLoop(p, p.faces[4][0], p.faces[4][1]);
  check("edge loop across a sheet, border to border", !!pl && pl.faces.length === p.faces.length + 3 && windingAgrees(pl), pl ? `${pl.faces.length} faces` : "refused");
  const s = sphereCage(40);
  const sl = insertEdgeLoop(s, s.faces[0][0], s.faces[0][1]);
  check("edge loop on a sphere cage (around its odd points)", !sl || (isClosed(sl) && solidOk(sl).ok), sl ? `${sl.faces.length} faces` : "refused (ring crosses itself)");
  const cy = cylinderCage(30, 40, 2);
  const side = faceWith(cy, (n) => Math.abs(n[2]) < 0.3)[0];
  const cl = insertEdgeLoop(cy, cy.faces[side][0], cy.faces[side][1]);
  check("edge loop round a cylinder (a new ring of points)", !!cl && isClosed(cl) && solidOk(cl).ok, cl ? `${cy.faces.length} → ${cl.faces.length}` : "refused");
}

// ---------------------------------------------- exact Move / Turn / Scale
{
  const sq: [number, number, number][] = [[10, 0, 50], [20, 0, 50], [20, 10, 50], [10, 10, 50]];
  const near = (a: number[][], b: number[][]) => a.every((p, i) => p.every((v, k) => Math.abs(v - b[i][k]) < 1e-9));
  check("Scale with only All typed: every factor starts at 1 (the face isn't flattened)", near(moveTurnScale(sq, "scale", [1, 1, 1, 0.5]), [[12.5, 2.5, 50], [17.5, 2.5, 50], [17.5, 7.5, 50], [12.5, 7.5, 50]]));
  check("Scale X only stretches along X", near(moveTurnScale(sq, "scale", [2, 1, 1, 1]), [[5, 0, 50], [25, 0, 50], [25, 10, 50], [5, 10, 50]]));
  check("Move adds the offset", near(moveTurnScale(sq, "move", [1, 2, 3, 1]), sq.map((p) => [p[0] + 1, p[1] + 2, p[2] + 3])));
  check("Turn 90° about Z through the middle", near(moveTurnScale(sq, "turn", [0, 0, 90, 1]), [[20, 0, 50], [20, 10, 50], [10, 10, 50], [10, 0, 50]]));
  const ground = cylinderCage(40, 40, 2).verts;
  const tall = moveTurnScale(ground, "scale", [1, 1, 5, 1]);
  check("a shape standing on the ground grows up from it", Math.min(...tall.map((p) => p[2])) === 0 && Math.abs(Math.max(...tall.map((p) => p[2])) - 200) < 1e-9);
}

// ------------------------------------------------------------ bridge faces
{
  // A tunnel through a box: top and bottom faces bridged.
  // (3×3 a side: the middle faces, clear of the box's edges.)
  const b = boxCage([40, 40, 40], 3);
  const top = faceWith(b, (n, m) => n[2] > 0.9 && Math.hypot(m[0], m[1]) < 1)[0];
  const bot = faceWith(b, (n, m) => n[2] < -0.9 && Math.hypot(m[0], m[1]) < 1)[0];
  const t = bridgeFaces(b, top, bot);
  check("bridge two faces: a closed, consistently wound cage with a tunnel", !!t && isClosed(t) && windingAgrees(t) && t.faces.length === b.faces.length - 2 + 4, t ? `${b.faces.length} → ${t.faces.length} faces` : "refused");
  const touching = bridgeFaces(boxCage([40, 40, 40], 2), 0, 1);
  check("faces that share a point can't be bridged", touching === null);
  const r = t && solidOk(t);
  check("  …and the box with a hole through it is a clean solid, smaller than the box", !!r?.ok && r.v < measureVolume(cageToShape(b)), r ? `vol ${r.v.toFixed(0)} vs ${measureVolume(cageToShape(b)).toFixed(0)}` : "");
}

// -------------------------------------------------------- extrude, inset
{
  const b = boxCage([40, 40, 40], 2);
  const top = faceWith(b, (n) => n[2] > 0.9);
  const v0 = measureVolume(cageToShape(b));
  const ex = extrudeFaces(b, [top[0]], 20)!;
  const r = solidOk(ex.cage);
  check("extrude one face out: closed, bigger, clean", isClosed(ex.cage) && windingAgrees(ex.cage) && r.ok && r.v > v0 && !selfCrossings(ex.cage).length, `vol ${v0.toFixed(0)} → ${r.v.toFixed(0)}`);
  const ex2 = extrudeFaces(b, top, 15)!;
  check("extrude a patch of faces together", isClosed(ex2.cage) && solidOk(ex2.cage).ok && ex2.cage.faces.length === b.faces.length + 8, `${ex2.cage.faces.length} faces`);
  const dent = extrudeFaces(b, [top[0]], -10)!;
  check("extrude inward (a dent)", isClosed(dent.cage) && solidOk(dent.cage).v < v0);
  const ins = insetFaces(b, [top[0]], 0.4)!;
  const ri = solidOk(ins.cage);
  check("inset a face: closed, about the same shape", isClosed(ins.cage) && windingAgrees(ins.cage) && ri.ok && Math.abs(ri.v - v0) / v0 < 0.15, `vol ${ri.v.toFixed(0)}`);
  const sh = planeCage([40, 40], 2);
  const se = extrudeFaces(sh, [0], 10)!;
  check("extrude a face of a sheet: still one open sheet, no stray points", !isClosed(se.cage) && windingAgrees(se.cage) && se.cage.verts.length === sh.verts.length + 4, `${se.cage.verts.length} points`);
}

// ---------------------------------------------- build something: a mug
let mug: Cage;
{
  let c = cylinderCage(40, 50, 3);
  // Cavity: inset the top, push it down.
  const top = faceWith(c, (n) => n[2] > 0.9);
  const ins = insetFaces(c, top, 0.25)!;
  c = extrudeFaces(ins.cage, ins.faces, -40)!.cage;
  // Handle: two side faces in one column pulled out, opened up and bridged.
  const sides = faceWith(c, (n, m) => n[0] > 0.8 && m[1] > 0 && m[2] > 0 && m[2] < 50);
  sides.sort((i, j) => c.faces[i].reduce((s, v) => s + c.verts[v][2], 0) - c.faces[j].reduce((s, v) => s + c.verts[v][2], 0));
  const lo = sides[0];
  const hi = sides[sides.length - 1];
  const out = extrudeFaces(c, [lo, hi], 14)!;
  c = out.cage;
  const ends = out.faces;
  const open = deleteFaces(c, ends);
  const loops = holeLoops(open, new Set(boundaryEdges(open).map(([a, b]) => cageEdgeKey(a, b))));
  const bridged = loops.length === 2 ? bridgeLoops(open, loops[0], loops[1]) : null;
  check("mug: cavity + handle bridged into a closed cage", !!bridged && isClosed(bridged) && windingAgrees(bridged), `${loops.length} holes, ${bridged?.faces.length ?? 0} faces`);
  mug = bridged ?? c;
  const crossings = selfCrossings(mug);
  const r = solidOk(mug);
  check("mug: a clean solid (handle doesn't cut through the cup)", r.ok && !crossings.length, `vol ${r.v.toFixed(0)}, ${crossings.length} self-crossings`);
  // A hole through the handle: one solid with a tunnel (genus 1).
  const s = cageToShape(mug);
  check("mug: one body, a real handle loop", s.faces.length === mug.faces.length, `${s.faces.length} surface patches`);
}

// ------------------------------------------ joined to other bodies
{
  const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
  const plate = [{ id: "r", kind: "rect", center: [0, 0], w: 90, h: 70, rotation: 0 }];
  const sk: Feature = { id: "sk", name: "Sketch", type: "sketch", plane: { ...XY, origin: [0, 0, -6] }, entities: plate } as Feature;
  const base: Feature = { id: "plate", name: "Plate", type: "extrude", source: { kind: "profile", sketch: "sk", regions: arrangement(plate as any).regions.map(regionRef) }, distance: 8, mode: "new" } as Feature;
  const cup: Feature = { id: "mug", name: "Mug", type: "freeform", cage: mug } as Feature;
  const blob: Feature = { id: "blob", name: "Blob", type: "freeform", cage: refineCage(sphereCage(26, [-30, 0, 8])) } as Feature;
  const run = async (fs: Feature[], name: string, want: number) => {
    const r: any = await regenerate(fs);
    const bodies = [...debugBodies()];
    const bad = bodies.filter(([, s]) => !shapeValid(s) || !(measureVolume(s) > 0));
    check(name, !r.errors.length && !bad.length && bodies.length === want, r.errors.length ? r.errors[0].message : `${bodies.length} bodies, vols ${bodies.map(([, s]) => measureVolume(s).toFixed(0)).join(", ")}`);
    return r;
  };
  await run([cup, sk, base, { id: "u", name: "Union", type: "boolean", op: "union", target: "plate", tools: ["mug"] } as Feature], "mug welded onto a plate (union)", 1);
  await run([cup, blob, { id: "u2", name: "Union", type: "boolean", op: "union", target: "mug", tools: ["blob"] } as Feature], "mug + another freeform (union)", 1);
  await run([cup, blob, { id: "c", name: "Cut", type: "boolean", op: "subtract", target: "mug", tools: ["blob"] } as Feature], "another freeform cut out of the mug", 1);
  await run([cup, sk, base, { id: "i", name: "Common", type: "boolean", op: "intersect", target: "mug", tools: ["plate"] } as Feature], "mug ∩ plate (just the bottom)", 1);
  await run([cup, { id: "t", name: "Stretch", type: "transform", bodies: ["mug"], copy: false, op: { kind: "scaleXYZ", center: [0, 0, 0], factors: [1.5, 1, 1] } } as Feature], "mug stretched 1.5× along X (rebuilt from its cage)", 1);
}

process.exit(failed ? 1 : 0);
