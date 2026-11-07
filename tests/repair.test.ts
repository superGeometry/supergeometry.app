// Run: npx tsx tests/repair.test.ts - the repair tool on shapes broken on purpose.
import opencascade from "replicad-opencascadejs";
import { cast, getOC, makeBaseBox, makeCompound, makeCylinder, makePolygon, measureVolume, setOC, type Shape3D } from "replicad";
import { healthOf, isHealthy, repairShape } from "../src/kernel/repair";

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();

let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const pile = (faces: unknown[]) => makeCompound(faces.map((f) => cast(f as never))) as unknown as Shape3D;
const vol = (s: Shape3D) => measureVolume(s);
const near = (a: number, b: number, rel = 5e-3) => Math.abs(a - b) <= Math.abs(b) * rel;

const box = makeBaseBox(40, 30, 20) as unknown as Shape3D;
const V = vol(box);

{
  const r = repairShape(box);
  check("a healthy body comes back as it is", !!r && r.shape === box && r.fixes.length === 0);
}
{
  // A face missing (an open box): the hole is flat, so it's filled.
  const r = repairShape(pile(box.faces.slice(1).map((f) => f.wrapped)), { volume: V });
  check("box with a face missing → closed solid, same volume", !!r && isHealthy(healthOf(r.shape)) && near(vol(r.shape), V), r ? `${r.fixes.join(", ")}; vol ${vol(r.shape).toFixed(1)} / ${V}` : "not repaired");
}
{
  // Faces pulled apart a little (as a STEP file from another program can be).
  const moved = box.faces.map((f, i) => {
    const c = f.center;
    const d = 0.02 * (i % 2 ? 1 : -1);
    return (f.translate([c.x * 0 + d, d * 0.5, -d * 0.3]) as any).wrapped;
  });
  const r = repairShape(pile(moved), { volume: V });
  check("faces 0.02 apart (gaps) → sewn into a solid", !!r && isHealthy(healthOf(r.shape)) && near(vol(r.shape), V, 0.02), r ? `${r.fixes.join(", ")}; vol ${vol(r.shape).toFixed(1)}` : "not repaired");
}
{
  const inside = cast(box.wrapped.Reversed()) as unknown as Shape3D;
  const r = repairShape(inside);
  check("inside-out solid → turned round", !!r && vol(r.shape) > 0 && near(vol(r.shape), V), r ? r.fixes.join(", ") : "not repaired");
}
{
  const cyl = makeCylinder(10, 30) as unknown as Shape3D;
  const r = repairShape(pile(cyl.faces.map((f) => f.wrapped)), { volume: vol(cyl) });
  check("loose faces of a cylinder → solid", !!r && isHealthy(healthOf(r.shape)) && near(vol(r.shape), vol(cyl)), r ? r.fixes.join(", ") : "not repaired");
}
{
  // A cube as 12 triangles (what an STL is): one solid, and its faces merged back to 6.
  const p = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]] as [number, number, number][];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const tris = quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]).map((t) => makePolygon(t.map((i) => p[i])).wrapped);
  const r = repairShape(pile(tris), { volume: 1000 });
  check("cube as 12 triangles (an STL) → solid of 6 faces", !!r && isHealthy(healthOf(r.shape)) && near(vol(r.shape), 1000) && r.shape.faces.length === 6, r ? `${r.fixes.join(", ")}; ${r.shape.faces.length} faces` : "not repaired");
}
{
  // Two boxes fused a hair apart: a sliver of a face where they almost meet.
  const a = makeBaseBox(20, 20, 20) as unknown as Shape3D;
  const b = (makeBaseBox(20, 20, 20) as any).translate([10, 0, 1e-5]) as Shape3D;
  const f = (a as any).fuse(b) as Shape3D;
  const h = healthOf(f);
  const r = repairShape(f);
  check("fused with a 0.00001 step (hair-thin faces) → clean", h.thin > 0 && (!!r && healthOf(r.shape).thin === 0 && near(vol(r.shape), vol(f), 0.01)), `before: ${h.thin} thin, ${h.solids} solids; ${r ? r.fixes.join(", ") : "not repaired"}`);
}
{
  // An STL sphere mesh, imported: sewn into a real solid.
  const n = 12;
  const pts: number[][][] = [];
  for (let i = 0; i <= n; i++) {
    const row: number[][] = [];
    for (let j = 0; j < 2 * n; j++) {
      const th = (i / n) * Math.PI;
      const ph = (j / (2 * n)) * 2 * Math.PI;
      row.push([10 * Math.sin(th) * Math.cos(ph), 10 * Math.sin(th) * Math.sin(ph), 10 * Math.cos(th)]);
    }
    pts.push(row);
  }
  // What an STL import gives: loose triangles.
  const tris: unknown[] = [];
  const tri = (a: number[], b: number[], c: number[]) => tris.push(makePolygon([a, b, c] as [number, number, number][]).wrapped);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < 2 * n; j++) {
      const j2 = (j + 1) % (2 * n);
      if (i > 0) tri(pts[i][j], pts[i + 1][j], pts[i][j2]);
      if (i < n - 1) tri(pts[i][j2], pts[i + 1][j], pts[i + 1][j2]);
    }
  const mesh = pile(tris);
  const h = healthOf(mesh);
  const t0 = performance.now();
  const r = repairShape(mesh);
  const dt = performance.now() - t0;
  check("STL-style sphere mesh (loose triangles) → one solid", !!r && isHealthy(healthOf(r.shape)) && vol(r.shape) > 3500, `before: ${h.solids} solids, ${h.faces} faces; ${r ? `${r.fixes.join(", ")}, vol ${vol(r.shape).toFixed(0)}` : "not repaired"}, ${dt.toFixed(0)} ms`);
}
{
  const one = pile([box.faces[0].wrapped]);
  check("a lone face can't be made a solid → refused", repairShape(one) === null);
}
void oc;
process.exit(failed ? 1 : 0);
