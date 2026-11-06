// Run: npx tsx tests/filletoffset.test.ts — offsetting faces next to a fillet.
// The fillet goes with the face (taken off, the face moved, put back at the same
// radius) — never a stray round face left in the body where the fillet was. When
// it no longer fits, the edge stays sharp and the step carries a note.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { regenerate } from "../src/kernel/engine";

setOC(await (opencascade as unknown as () => Promise<any>)());

// A 40 × 30 × 10 box, its +X top edge filleted R4.
const base: any[] = [
  { id: "sk", name: "Sketch", type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [{ id: "r1", kind: "rect", center: [0, 0], w: 40, h: 30, rotation: 0 }] },
  { id: "e1", name: "Extrude", type: "extrude", source: { kind: "profile", sketch: "sk", regions: [{ c: [0, 0], a: 1200 }] }, distance: 10, mode: "auto" },
  { id: "f1", name: "Fillet", type: "fillet", edges: [{ body: "e1", mid: [20, 0, 10], dir: [0, 1, 0], length: 30 }], radius: 4 },
];
const top = { body: "e1", center: [-2, 0, 10], normal: [0, 0, 1], area: 1080 };
const side = { body: "e1", center: [20, 0, 3], normal: [1, 0, 0], area: 180 };
const end = { body: "e1", center: [0, -15, 5], normal: [0, -1, 0], area: 390 };
const far = { body: "e1", center: [-20, 0, 5], normal: [-1, 0, 0], area: 300 };

const cases: { name: string; face: any; d: number; round: number; note?: boolean }[] = [
  { name: "side next to the fillet, out 5", face: side, d: 5, round: 1 },
  { name: "side in 3", face: side, d: -3, round: 1 },
  { name: "side in 15", face: side, d: -15, round: 1 },
  { name: "top up 5", face: top, d: 5, round: 1 },
  { name: "top in 3", face: top, d: -3, round: 1 },
  { name: "top in 8 (the fillet no longer fits)", face: top, d: -8, round: 0, note: true },
  { name: "end the fillet runs into, out 5", face: end, d: 5, round: 1 },
  { name: "far side, out 5", face: far, d: 5, round: 1 },
];

let failed = 0;
for (const c of cases) {
  const r = await regenerate([...base, { id: "o1", name: "Offset", type: "extrude", source: { kind: "face", face: c.face }, distance: c.d, mode: "auto", target: "e1" }]);
  const b = r.bodies[0];
  const round = b?.faces.filter((f) => f.type !== "PLANE").length ?? -1;
  const problems = [
    r.errors.length ? `error: ${r.errors.map((e) => e.message).join("; ")}` : "",
    r.bodies.length !== 1 ? `${r.bodies.length} bodies` : "",
    b && b.openEdges.length ? `${b.openEdges.length} open edges` : "",
    round !== c.round ? `${round} round faces (expected ${c.round})` : "",
    !!c.note !== !!r.notes?.length ? `note: ${JSON.stringify(r.notes ?? [])}` : "",
  ].filter(Boolean);
  if (problems.length) failed++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.name}${problems.length ? " — " + problems.join(", ") : ""}`);
}
if (failed) process.exit(1);
