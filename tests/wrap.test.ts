// Run: npx tsx tests/wrap.test.ts - Project as Edge (a sketch drawn onto the
// faces seen from it, or edges onto a face: the faces split along them) and
// Wrap & Emboss (a sketch wrapped round a round face, raised or sunk).
import { after, check, done, profile, rect, sketch, XY } from "./kit";
import { measureVolume } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import { arrangement, regionRef } from "../src/sketch/regions";
import { projectRegions } from "../src/sketch/edit";
import type { Feature, PlaneDef } from "../src/doc/types";

// A 100 x 60 x 20 box.
const boxEs = [rect("b", 0, 0, 100, 60)];
const box: Feature[] = [sketch("bs", XY(0), boxEs), { id: "B", name: "Box", type: "extrude", source: profile("bs", boxEs), distance: 20, mode: "new" } as Feature];
const circle = [{ id: "c", kind: "circle", center: [50, 30], radius: 10 }];

async function bodyAfter(fs: Feature[], id: string): Promise<{ s: any; err?: string }> {
  const { body, err } = await after(fs, id);
  return { s: body, err };
}
const v0 = 100 * 60 * 20;

// ---- Project as Edge from a sketch: onto the faces seen from it only.
for (const [z, where] of [
  [40, "above the box: onto its top face, not the bottom"],
  [20, "on the top face itself"],
  [-15, "below the box: onto its bottom face"],
] as [number, string][]) {
  const { s, err } = await bodyAfter([...box, sketch("cs", XY(z), circle), { id: "P", name: "P", type: "imprint", body: "B", source: profile("cs", circle) } as Feature], "B");
  check(`a circle ${where}: the box has one face more, its size unchanged`, !err && s?.faces.length === 7 && Math.abs(measureVolume(s) - v0) < 1e-3 && isHealthy(healthOf(s)), err ?? `${s?.faces.length} faces`);
  if (s) {
    const split = s.faces.filter((f: any) => Math.abs(f.center.z - (z < 0 ? 0 : 20)) < 1e-6 && f.geomType === "PLANE");
    check(`  ...it is the ${z < 0 ? "bottom" : "top"} face that is split, a disc of the circle's size`, split.length === 2 && split.some((f: any) => Math.abs(f.center.x - 50) < 1e-6 && Math.abs(f.center.y - 30) < 1e-6), String(split.length));
  }
}
const off = [{ id: "c", kind: "circle", center: [300, 30], radius: 10 }];
const miss = await bodyAfter([...box, sketch("cs", XY(40), off), { id: "P", name: "P", type: "imprint", body: "B", source: profile("cs", off) } as Feature], "B");
check("a circle beside the box lands on nothing: said so", !!miss.err && /Nothing lands/.test(miss.err), miss.err);
// A sketch from the front, across the box's side: onto that side face.
const sideEs = [rect("r", 20, 5, 40, 15)];
const side = await bodyAfter([...box, sketch("ss", { origin: [0, -30, 0], xDir: [1, 0, 0], normal: [0, -1, 0] }, sideEs), { id: "P", name: "P", type: "imprint", body: "B", source: profile("ss", sideEs) } as Feature], "B");
check("a rectangle from the front: the front face split (not the back)", !side.err && side.s?.faces.length === 7 && side.s.faces.filter((f: any) => Math.abs(f.center.y) < 1e-6).length === 2, side.err ?? String(side.s?.faces.length));

// ---- Project as Edge from edges: a post's rim onto the box's top face.
const postEs = [{ id: "p", kind: "circle", center: [20, 20], radius: 5 }];
const post: Feature[] = [sketch("ps", XY(30), postEs), { id: "Q", name: "Post", type: "extrude", source: profile("ps", postEs), distance: 10, mode: "new" } as Feature];
const rim = { body: "Q", mid: [25, 20, 30], dir: [0, 1, 0], length: 2 * Math.PI * 5 } as any;
const top = { body: "B", center: [50, 30, 20], normal: [0, 0, 1], area: 6000 } as any;
const ed = await bodyAfter([...box, ...post, { id: "P", name: "P", type: "imprint", body: "B", edges: [rim], face: top } as Feature], "B");
check("a post's rim projected onto the top face: split there, a disc under the post", !ed.err && ed.s?.faces.length === 7 && ed.s.faces.some((f: any) => Math.abs(f.center.x - 20) < 1e-6 && Math.abs(f.center.y - 20) < 1e-6 && Math.abs(f.center.z - 20) < 1e-6), ed.err ?? String(ed.s?.faces.length));

// ---- Wrap & Emboss: a 20 x 10 rectangle on a plane touching a 20 mm radius cylinder.
const cylEs = [{ id: "c", kind: "circle", center: [0, 0], radius: 20 }];
const cyl: Feature[] = [sketch("cy", XY(0), cylEs), { id: "C", name: "Cylinder", type: "extrude", source: profile("cy", cylEs), distance: 60, mode: "new" } as Feature];
const vc = Math.PI * 400 * 60;
const tangent: PlaneDef = { origin: [20, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] };
await regenerate(cyl);
const cylSide = [...debugBodies()].find(([k]) => k === "C")![1].faces.find((f: any) => f.geomType === "CYLINDRE");
const round = { body: "C", center: [0, 0, 30], normal: cylSide.normalAt().toTuple(), area: 2 * Math.PI * 20 * 60 } as any;
const wrapOf = (es: any[], h: number, plane = tangent) => [...cyl, sketch("ws", plane, es), { id: "W", name: "W", type: "wrap", source: profile("ws", es), face: round, height: h } as Feature];
const lbl = [rect("l", -10, 20, 10, 30)];
const up = await bodyAfter(wrapOf(lbl, 2), "C");
// Raised 2 mm: the rectangle's area times 2, a little more for being further out (mean radius 21 over 20).
const added = up.s ? measureVolume(up.s) - vc : 0;
check("raised 2 mm: 20 x 10 x 2, out at 21 mm on average: 420 mm³ more", !up.err && Math.abs(added - 420) < 1, up.err ?? added.toFixed(3));
const bb = up.s?.boundingBox;
check("  ...standing 2 mm off the face where the plane touches it, one body, sound", !!bb && Math.abs(bb.bounds[1][0] - 22) < 1e-3 && isHealthy(healthOf(up.s)), JSON.stringify(bb?.bounds));
// 20 mm round the face is 20/20 rad: its ends at ±0.5 rad from the touching line.
const reach = up.s ? Math.max(...up.s.faces.flatMap((f: any) => f.edges.map((e: any) => Math.abs(Math.atan2(e.startPoint.y, e.startPoint.x))))) : 0;
check("  ...wrapped, not projected: it goes 20 mm round (0.5 rad each way)", Math.abs(reach - 0.5) < 1e-3, reach.toFixed(5));
const thin = await bodyAfter(wrapOf(lbl, 1), "C");
const added1 = thin.s ? measureVolume(thin.s) - vc : 0;
check("raised 1 mm (a slab bent round so far its centre of mass is inside the face): 205 mm³ more", !thin.err && Math.abs(added1 - 205) < 1, thin.err ?? added1.toFixed(3));
const down = await bodyAfter(wrapOf(lbl, -1), "C");
const taken = down.s ? vc - measureVolume(down.s) : 0;
check("sunk 1 mm: 20 x 10 x 1 at 19.5 mm on average: 195 mm³ less", !down.err && Math.abs(taken - 195) < 1, down.err ?? taken.toFixed(3));
const withHole = [rect("l", -10, 20, 10, 30), { id: "h", kind: "circle", center: [0, 25], radius: 3 }];
const holed = await bodyAfter([...cyl, sketch("ws", tangent, withHole), { id: "W", name: "W", type: "wrap", source: { kind: "profile", sketch: "ws", regions: [arrangement(withHole as any).regions.map(regionRef).find((_, i, all) => all.length === 2 && i === 0)!] }, face: round, height: 2 } as Feature], "C");
const hv = holed.s ? measureVolume(holed.s) - vc : 0;
check("a shape with a hole wraps with its hole (the ring, or the disc in it)", !holed.err && [(200 - 9 * Math.PI) * 2.1, 9 * Math.PI * 2.1].some((v) => Math.abs(hv - v) < 1), holed.err ?? hv.toFixed(3));
const far = await bodyAfter(wrapOf(lbl, 2, { origin: [50, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] }), "C");
check("a sketch on a plane further off wraps the same (from where it is nearest)", !far.err && Math.abs(measureVolume(far.s) - vc - 420) < 1, far.err);
const long = await bodyAfter(wrapOf([rect("l", -70, 20, 70, 30)], 2), "C");
check("longer than the way round: said so", /longer than the way round/.test(long.err ?? ""), long.err);
const tilted = await bodyAfter(wrapOf(lbl, 2, { origin: [20, 0, 0], xDir: [0, 1, 0], normal: [Math.SQRT1_2, 0, Math.SQRT1_2] }), "C");
check("a plane across the axis: asked for one along it", /along the round face's axis/.test(tilted.err ?? ""), tilted.err);

// ---- Project as Sketch (a sketch's shapes onto another plane, square to it).
{
  const es: any[] = [rect("r", 0, 0, 40, 20), { id: "h", kind: "circle", center: [20, 10], radius: 5 }];
  const arr = arrangement(es);
  const ring = arr.regions.find((r) => r.holes.length === 1)!;
  const flat = projectRegions(arr, [ring], XY(0), XY(10));
  const kinds = flat.map((e) => e.kind).sort().join(",");
  check("a plate with a hole onto a parallel plane: its four sides and its circle", kinds === "circle,line,line,line,line", kinds);
  const c = flat.find((e) => e.kind === "circle") as any;
  check("  ...the circle where it was, its size", !!c && Math.abs(c.center[0] - 20) < 1e-6 && Math.abs(c.center[1] - 10) < 1e-6 && Math.abs(c.radius - 5) < 1e-3, JSON.stringify(c));
  // Onto a plane tilted 60° about X: lengths across the tilt halve, the circle is squashed to an ellipse-like spline.
  const tilt = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -Math.sin(Math.PI / 3), Math.cos(Math.PI / 3)] } as PlaneDef;
  const t = projectRegions(arr, [ring], XY(0), tilt);
  const ys = t.filter((e: any) => e.kind === "line").flatMap((e: any) => [e.a[1], e.b[1]]);
  check("onto a plane tilted 60°: the 20 mm sides come out 10 mm, the circle a spline", Math.abs(Math.max(...ys) - Math.min(...ys) - 10) < 1e-6 && t.some((e) => e.kind === "spline") && !t.some((e) => e.kind === "circle"), JSON.stringify(ys));
  const two = arrangement([rect("a", 0, 0, 10, 10), rect("b", 10, 0, 20, 10)] as any);
  const both = projectRegions(two, two.regions, XY(0), XY(5));
  check("two shapes side by side: the side they share drawn once (7 lines)", both.length === 7 && both.every((e) => e.kind === "line"), String(both.length));
}

done();
