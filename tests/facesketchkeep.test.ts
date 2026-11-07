// Run: npx tsx tests/facesketchkeep.test.ts
// A face slid within its own plane / turned about its normal (the faces round
// it follow, on a body of flat faces), and Subtract / Intersect keeping the
// body changed or the bodies it was changed with.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { debugBodies, regenerate, shapeValid } from "../src/kernel/engine";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const XY = { origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] };
const block = (id: string, cx: number, w = 40, h = 20, d = 30) => [
  { id: `s${id}`, name: id, type: "sketch", plane: XY, entities: [{ id: `r${id}`, kind: "rect", center: [cx, 0], w, h, rotation: 0 }] },
  { id, name: id, type: "extrude", source: { kind: "profile", sketch: `s${id}`, regions: [{ c: [cx, 0], a: w * h }] }, distance: d, mode: "new" },
];
const top = { body: "b", center: [0, 0, 30], normal: [0, 0, 1], area: 800 };
const V = (id: string) => Math.abs(measureVolume(debugBodies().get(id)!));
const bb = (id: string) => (debugBodies().get(id) as any).boundingBox.bounds.map((p: number[]) => p.map((x) => +x.toFixed(2)));

{
  const r: any = await regenerate([...block("b", 0), { id: "m", name: "m", type: "moveFace", face: top, translate: [6, 0, 0] }] as any);
  const b = bb("b");
  check("a face slid sideways: the body leans (sheared, same volume)", !r.errors.length && Math.abs(V("b") - 24000) < 1 && b[1][0] === 26 && b[0][0] === -20 && shapeValid(debugBodies().get("b") as any), `${JSON.stringify(b)} ${V("b").toFixed(1)}`);
}
{
  const r: any = await regenerate([...block("b", 0), { id: "m", name: "m", type: "moveFace", face: top, translate: [0, 0, 0], rotate: { origin: [0, 0, 30], axis: [0, 0, 1], angle: 15 } }] as any);
  const b = bb("b");
  check("a face turned about its normal: the body twists (the top's corners turned)", !r.errors.length && b[1][1] > 10.5 && shapeValid(debugBodies().get("b") as any), JSON.stringify(b));
}
{
  const r: any = await regenerate([...block("b", 0), { id: "m", name: "m", type: "moveFace", face: top, translate: [3, 4, 5] }] as any);
  check("a face moved every way at once: pushed and slid", !r.errors.length && bb("b")[1][2] === 35 && bb("b")[1][0] === 23, JSON.stringify(bb("b")));
}
for (const op of ["subtract", "intersect"] as const) {
  for (const [kt, kT] of [[false, false], [true, false], [false, true], [true, true]]) {
    const r: any = await regenerate([...block("A", 0), ...block("B", 25), { id: "op", name: "op", type: "boolean", op, target: "A", tools: ["B"], keepTools: kt || undefined, keepTarget: kT || undefined }] as any);
    const ids = r.bodies.map((b: any) => b.id).sort();
    const want = ["A", ...(kt ? ["B"] : []), ...(kT ? ["op"] : [])].sort();
    const result = kT ? "op" : "A";
    const vr = V(result);
    // A and B overlap 15 × 20 × 30 = 9000.
    const expect = op === "subtract" ? 24000 - 9000 : 9000;
    check(`${op}, keep tools ${kt}, keep target ${kT}: the right bodies, the right result`, !r.errors.length && JSON.stringify(ids) === JSON.stringify(want) && Math.abs(vr - expect) < 1 && (!kT || Math.abs(V("A") - 24000) < 1), `${ids} ${vr.toFixed(0)}`);
  }
}
process.exit(failed ? 1 : 0);
