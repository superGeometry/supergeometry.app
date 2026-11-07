// Run: npx tsx tests/extendborder.test.ts
// Extending a freeform surface from points on its border: a face beyond each
// border edge with both ends picked, outwards in the surface, as long as the
// edges; and the result still builds as a clean sheet.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";
import { boundaryEdges, extendBorder, planeCage, boxCage } from "../src/freeform/cage";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const sheet = planeCage([60, 40], 4, [0, 0, 0]);
const right = sheet.verts.flatMap((v, i) => (Math.abs(v[0] - 30) < 1e-9 ? [i] : []));
const r = extendBorder(sheet, right)!;
check("five points along the right edge: four new faces, five new points", !!r && r.cage.faces.length === sheet.faces.length + 4 && r.verts.length === 5, `${r?.cage.faces.length} faces`);
check("…out to the right by an edge's length (10), flat", r.verts.every((i) => Math.abs(r.cage.verts[i][0] - 40) < 1e-9 && Math.abs(r.cage.verts[i][2]) < 1e-9), r.verts.map((i) => r.cage.verts[i].join(",")).join(" "));
check("…the right edge is no longer a border; the new one is", !boundaryEdges(r.cage).some(([a, b]) => right.includes(a) && right.includes(b)) && boundaryEdges(r.cage).filter(([a, b]) => r.verts.includes(a) && r.verts.includes(b)).length === 4);
const corner = sheet.verts.findIndex((v) => Math.abs(v[0] - 30) < 1e-9 && Math.abs(v[1] - 20) < 1e-9);
const nextTo = sheet.verts.findIndex((v) => Math.abs(v[0] - 15) < 1e-9 && Math.abs(v[1] - 20) < 1e-9);
const two = extendBorder(sheet, [corner, nextTo])!;
check("two points round a corner (one border edge between them): one face", !!two && two.cage.faces.length === sheet.faces.length + 1);
check("points not on a border: nothing to extend", extendBorder(boxCage([20, 20, 20], 1), [0, 1, 2]) === null);
check("one point: nothing to extend", extendBorder(sheet, [corner]) === null);
const res: any = await regenerate([{ id: "s", name: "s", type: "freeform", surface: true, cage: r.cage }] as any);
check("the extended surface builds, a valid sheet", !res.errors.length && shapeValid(debugBodies().get("s") as any), res.errors.map((e: any) => e.message).join("; "));
process.exit(failed ? 1 : 0);
