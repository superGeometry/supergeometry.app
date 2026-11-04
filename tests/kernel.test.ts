// Run: npx tsx tests/kernel.test.ts — checks sketch regions become valid solids.
import opencascade from "replicad-opencascadejs";
import { basicFaceExtrusion, measureArea, setOC, Vector } from "replicad";
import type { PlaneDef, SketchEntity } from "../src/doc/types";
import { regionFaces } from "../src/kernel/sketchGeom";
import { arrangement, regionRef } from "../src/sketch/regions";

setOC(await (opencascade as unknown as () => Promise<any>)());
const XY: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
const FRONT: PlaneDef = { origin: [0, 0, 5], xDir: [1, 0, 0], normal: [0, -1, 0] };

const cases: [string, SketchEntity[], PlaneDef][] = [
  ["rect", [{ id: "r", kind: "rect", center: [0, 0], w: 20, h: 10, rotation: 0 }], XY],
  ["ring", [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 20, rotation: 0 }, { id: "c", kind: "circle", center: [0, 0], radius: 5 }], XY],
  ["circles crossing", [{ id: "a", kind: "circle", center: [0, 0], radius: 10 }, { id: "b", kind: "circle", center: [10, 0], radius: 10 }], FRONT],
  ["D", [{ id: "l", kind: "line", a: [-10, 0], b: [10, 0] }, { id: "a", kind: "arc", a: [10, 0], m: [0, 10], b: [-10, 0] }], XY],
  ["ellipse", [{ id: "e", kind: "ellipse", center: [3, 2], rx: 10, ry: 5, rotation: 0.3 }], XY],
  ["ellipse cut by line", [{ id: "e", kind: "ellipse", center: [0, 0], rx: 10, ry: 5, rotation: 0 }, { id: "l", kind: "line", a: [0, -10], b: [0, 10] }], XY],
  ["spline", [{ id: "s", kind: "spline", points: [[0, 0], [10, 0], [12, 8], [0, 10]], closed: true, mode: "fit" }], XY],
  ["rotated rect + circle overlap", [{ id: "r", kind: "rect", center: [0, 0], w: 20, h: 20, rotation: 0.4 }, { id: "c", kind: "circle", center: [10, 0], radius: 6 }], XY],
];

let failed = 0;
for (const [name, entities, plane] of cases) {
  try {
    const arr = arrangement(entities);
    const faces = regionFaces(entities, plane, arr.regions.map(regionRef));
    const out = faces.map((f, i) => {
      const s = basicFaceExtrusion(f, new Vector(plane.normal).multiply(5));
      return `${measureArea(f).toFixed(2)}/${arr.regions[i].area.toFixed(2)}:${s.faces.length}f`;
    });
    console.log("ok  ", name, out.join(" "));
  } catch (e) {
    failed++;
    console.log("FAIL", name, e instanceof Error ? e.message : e);
  }
}
process.exit(failed ? 1 : 0);
