// Run: npx tsx tests/flatends.test.ts
// Where a round or a chamfer ends on a flat face, the kernel hands back the piece of that face beside its end as a
// spline surface: flat, but never merged with the rest of the face, so curved lines crossed a cube's flat side.
// Those pieces are planes again and the face is one (engine.ts flatSplinesPlain).
import type { Feature } from "../src/doc/types";
import { YZ, after, block, bodies, check, done, extrude, poly, sketch, volume } from "./kit";

// A block 20 x 20 x 21 with a wedge on its x = 20 side, as wide as the block: the wedge's long edges run into
// the block's side faces' planes, so a round on one ends on the block's flat side.
const s2 = sketch("s2", YZ(20), [poly("t", [[0, 10.5], [20, 10.5], [10, 0]])]);
const base = [...block("b", 20, 20, 21), s2, extrude("wedge", s2, 6.1, "join", { target: "b" })];
const blend = (id: string, type: "fillet" | "chamfer", y: number, radius: number) => ({ id, name: id, type, edges: [{ body: "b", mid: [23.05, y, 10.5], dir: [1, 0, 0], length: 6.1 }], radius }) as unknown as Feature;

const flatSide = () => bodies().get("b")!.faces.filter((f) => Math.abs(f.center.toTuple()[0] - 20) < 1e-6 && Math.abs(Math.abs(f.normalAt().toTuple()[0]) - 1) < 1e-6);
for (const [name, steps] of [
  ["a round", [blend("F", "fillet", 20, 2)]],
  ["a chamfer", [blend("C", "chamfer", 0, 4.2)]],
  ["a round and a chamfer", [blend("F", "fillet", 20, 2), blend("C", "chamfer", 0, 4.2)]],
] as const) {
  const v0 = volume((await after(base, "b")).body);
  const { errors, body } = await after([...base, ...steps], "b");
  const side = flatSide();
  const kinds = [...new Set(bodies().get("b")!.faces.map((f) => f.geomType))].sort().join(" ");
  check(`${name} ending on the block's side: that side is flat faces only, no spline pieces`, !errors.length && side.every((f) => f.geomType === "PLANE") && !kinds.includes("BSPLINE"), `${side.length} faces on the side; kinds: ${kinds} ${errors.join("; ")}`);
  check(`${name}: something was taken off, and the body is sound`, volume(body) < v0 - 1 && volume(body) > v0 - 80, `${v0.toFixed(2)} -> ${volume(body).toFixed(2)}`);
}
done();
