// Run: npx tsx tests/movedmesh.test.ts
// A body moved, turned, mirrored or patterned has the same shape: its mesh is
// the original's, moved the same way (not meshed again - seconds on a big
// body). Each face's triangles must still be that face: same area, same
// middle, facing out - also mirrored, where they're turned round.
import { check, done, sketch, rect, circle, poly, extrude, XY } from "./kit";
import { regenerate } from "../src/kernel/engine";
import type { Feature, Vec3 } from "../src/doc/types";
import type { BodyMesh } from "../src/kernel/protocol";

// An L-shaped block with a round hole and a slot: faces of every kind, no two alike.
const L = sketch("s", XY(), [poly("p", [[0, 0], [40, 0], [40, 15], [15, 15], [15, 30], [0, 30]])]);
const holes = sketch("h", XY(12), [circle("c", 7, 7, 4), rect("r", 25, 4, 35, 9)]);
const body: Feature[] = [L, extrude("E", L, 12), holes, { ...extrude("H", holes, 8, "cut"), reverse: true } as Feature];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Per face: the triangles' area and area-weighted middle, and how many triangles face against their vertex normals. */
function check1(name: string, m: BodyMesh) {
  const P = (i: number): Vec3 => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
  const N = (i: number): Vec3 => [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]];
  let worst = 0;
  let worstAt = "";
  let inward = 0;
  for (const g of m.faceGroups) {
    let area = 0;
    const c: Vec3 = [0, 0, 0];
    for (let t = g.start; t < g.start + g.count; t += 3) {
      const [a, b, d] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      const n = cross(sub(P(b), P(a)), sub(P(d), P(a)));
      const A = Math.hypot(...n) / 2;
      if (dot(n, N(a)) < 0) inward++;
      area += A;
      for (let k = 0; k < 3; k++) c[k] += (A * (P(a)[k] + P(b)[k] + P(d)[k])) / 3;
    }
    const f = m.faces[g.face];
    const off = Math.hypot(...sub(c.map((x) => x / area) as Vec3, f.center));
    const da = Math.abs(area - f.area) / f.area;
    if (off + da * 10 > worst) (worst = off + da * 10), (worstAt = `face ${g.face} (${f.type}): middle ${off.toFixed(3)} mm off, area ${(da * 100).toFixed(2)} % off`);
  }
  check(`${name}: every face's triangles are that face, facing out`, worst < 0.3 && inward === 0, `${worstAt}; ${inward} triangles facing in`);
}

const moves: [string, Feature, string[]][] = [
  ["moved and turned", { id: "T", name: "T", type: "transform", bodies: ["E"], op: { kind: "move", translate: [30, -20, 5], rotate: { origin: [10, 10, 0], axis: [0.3, 0.4, 1], angle: 37 } } } as Feature, ["E"]],
  ["mirrored", { id: "T", name: "T", type: "transform", bodies: ["E"], op: { kind: "mirror", plane: { origin: [50, 0, 0], xDir: [0, 1, 0], normal: [1, 0.2, 0] } } } as Feature, ["E"]],
  ["mirrored as a copy", { id: "T", name: "T", type: "transform", bodies: ["E"], copy: true, op: { kind: "mirror", plane: { origin: [0, -5, 0], xDir: [1, 0, 0], normal: [0, 1, 0] } } } as Feature, ["E", "T:E:0"]],
  ["a row of copies", { id: "T", name: "T", type: "transform", bodies: ["E"], op: { kind: "linear", dir: [1, 1, 0], spacing: 60, count: 3 } } as Feature, ["E", "T:E:0", "T:E:1"]],
  ["copies round an axis", { id: "T", name: "T", type: "transform", bodies: ["E"], op: { kind: "circular", axis: { origin: [-20, 0, 0], dir: [0, 0, 1] }, angle: 360, count: 4 } } as Feature, ["E", "T:E:0", "T:E:1", "T:E:2"]],
];

for (const [name, step, ids] of moves) {
  // Once without the step (the body's own mesh, kept), once with it.
  await regenerate(structuredClone(body));
  const r = await regenerate([...structuredClone(body), step]);
  check(`${name}: built`, !r.errors.length && ids.every((id) => r.bodies.some((b) => b.id === id)), r.errors.map((e) => e.message).join(" | "));
  for (const id of ids) {
    const m = r.bodies.find((b) => b.id === id);
    if (m) check1(`${name}, ${id}`, m);
  }
}

// The same done from nothing (no mesh of the original to start from): meshed as usual, and the same.
{
  const r = await regenerate([...structuredClone(body), { ...moves[0][1], id: "T2" }]);
  const m = r.bodies.find((b) => b.id === "E");
  check("moved, built in one go: built", !r.errors.length && !!m);
  if (m) check1("moved, built in one go", m);
}

done();
