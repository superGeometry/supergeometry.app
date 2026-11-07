// Run: npx tsx tests/faceeditcases.test.ts - face edits found by comparing
// random cases before and after the concave-face / delete changes
// (tests/fixtures/faceeditcases.json), each checked against what it must be.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { readFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { cylinderOf } from "../src/kernel/faceEdit";
import { healthOf, isHealthy } from "../src/kernel/repair";

setOC(await (opencascade as unknown as () => Promise<any>)());
const C = JSON.parse(readFileSync(new URL("./fixtures/faceeditcases.json", import.meta.url), "utf8"));
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const build = async (fs: any[]) => {
  const r: any = await regenerate(fs);
  const s = r.errors.length ? null : debugBodies().get(r.bodies[0].id)!;
  return { err: r.errors[0]?.message as string | undefined, s, v: s ? Math.abs(measureVolume(s)) : NaN };
};
const noPre = (fs: any[]) => fs.filter((f) => f.id !== "pre");
const rounds = (s: any) => s.faces.filter((f: any) => f.geomType === "CYLINDRE").length;

{
  // An L's bottom tilted about its centre with a fillet along its inner corner:
  // the fillet goes back on that edge only (not also on another edge whose
  // middle happens to lie on both planes).
  const a = await build(C.tiltLWithFillet);
  const plain = await build(noPre(C.tiltLWithFillet));
  check("L bottom tilted, fillet put back on its own edge only", !!a.s && isHealthy(healthOf(a.s)) && rounds(a.s) === 1 && Math.abs(plain.v - a.v) < 15, `${a.err ?? ""} ${a.s ? rounds(a.s) : "-"} round, ${a.v.toFixed(2)} vs ${plain.v.toFixed(2)} without the fillet`);
}
{
  const a = await build(C.moveLTopWithFillet);
  const plain = await build(noPre(C.moveLTopWithFillet));
  check("L top moved down with a fillet on it: all of it moves, one fillet", !!a.s && isHealthy(healthOf(a.s)) && rounds(a.s) === 1 && Math.abs(plain.v - a.v) < 15, `${a.err ?? ""} ${a.v.toFixed(2)} vs ${plain.v.toFixed(2)}`);
}
{
  // Tilted about its own centre: the volume can't change.
  const before = await build(C.tiltLTop.slice(0, -1));
  const a = await build(C.tiltLTop);
  check("L top tilted about its centre: same volume, one face", !!a.s && Math.abs(a.v - before.v) < before.v * 1e-6 && a.s.faces.length === 8, `${before.v.toFixed(3)} → ${a.v.toFixed(3)}, ${a.s?.faces.length} faces`);
}
{
  const before = await build(C.tiltBottomWithBossBulge.slice(0, -1));
  const a = await build(C.tiltBottomWithBossBulge);
  check("bottom with a boss bulging past its side tilted: whole face tilts", !!a.s && Math.abs(a.v - before.v) < before.v * 1e-6 && a.s.faces.filter((f: any) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] < -0.999).length === 0, `${before.v.toFixed(3)} → ${a.v.toFixed(3)}`);
}
{
  // A ring swept 248° (R 19.065–38.135, 21.31 high), its outside offset 2.68.
  const a = await build(C.offsetRing248);
  const want = (Math.PI * (40.815 ** 2 - 19.065 ** 2) * 247.99) / 360 * 21.31;
  const radii = a.s ? a.s.faces.map((f: any) => (f.geomType === "CYLINDRE" ? cylinderOf(f)?.r : undefined)).filter((x: any) => x !== undefined) : [];
  check("ring swept past half a turn: its outside offset all the way round", !!a.s && isHealthy(healthOf(a.s)) && Math.abs(a.v - want) < want * 1e-3 && radii.every((r: number) => Math.abs(r - 40.815) < 1e-3 || Math.abs(r - 19.065) < 1e-3), `${a.err ?? ""} ${a.v.toFixed(1)} want ${want.toFixed(1)}, radii ${radii.map((r: number) => r.toFixed(3))}`);
}
{
  // A swept ring's bottom (inward corner: its inner arc) pushed down 3.36 with a
  // fillet along one end: the same as pushing it without the fillet, then filleting.
  const a = await build(C.offsetRingBottomWithFillet);
  check("ring bottom offset round a fillet = offset, then fillet", !!a.s && isHealthy(healthOf(a.s)) && Math.abs(a.v - 6520.478) < 0.01, `${a.err ?? ""} ${a.v.toFixed(3)} want 6520.478`);
}
for (const k of ["deleteWallOfPlate", "deleteWallOfBoxWithBoss", "deletePlateTop"]) {
  const a = await build(C[k]);
  check(`${k}: refused (not "some other piece of the part is left")`, !!a.err && /can't be removed/.test(a.err), a.err ?? `accepted, ${a.v.toFixed(1)}`);
}
process.exit(failed ? 1 : 0);
