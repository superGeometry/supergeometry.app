// Extrude's ends, start and draft, and the Intersect result.
// Run: npx tsx tests/extrudeext.test.ts
import { measureArea } from "replicad";
import type { Feature, FaceRef, Vec3 } from "../src/doc/types";
import { after, block, check, circle, cylinder, done, extrude, near, rect, sketch, volume, XY, YZ } from "./kit";

const sq = sketch("s", XY(), [rect("r", 0, 0, 20, 20)]);
const box = (s: { boundingBox: { bounds: [Vec3, Vec3] } } | undefined) => s?.boundingBox.bounds;

// Draft: the sides lean in, the top is smaller - a frustum.
{
  const { body, err } = await after([sq, extrude("E", sq, 10, "new", { draft: 5 })], "E");
  const top = 20 - 2 * 10 * Math.tan((5 * Math.PI) / 180);
  const want = (10 / 3) * (400 + top * top + 20 * top);
  check("a 5° draft narrows the far end", !err && near(volume(body), want, 0.5), { err, v: volume(body), want });
  const out = await after([sq, extrude("E", sq, 10, "new", { draft: -5 })], "E");
  check("a negative draft widens it", !out.err && volume(out.body) > 4000, { err: out.err, v: volume(out.body) });
}

// Through all: a hole cut through a block, from a sketch above it.
{
  const hole = sketch("h", XY(25), [circle("c", 10, 10, 2)]);
  const { body, err } = await after([...block("B", 20, 20, 10), hole, extrude("E", hole, -1, "cut", { extent: "through" })], "B");
  check("through all cuts right through", !err && near(volume(body), 4000 - Math.PI * 4 * 10, 0.05), { err, v: volume(body) });
}

// Up to a plane, either side of the shape.
{
  const up = await after([sq, extrude("E", sq, 1, "new", { extent: "to", to: { plane: XY(7) } })], "E");
  check("up to a plane above", !up.err && near(volume(up.body), 400 * 7, 1e-3), { err: up.err, v: volume(up.body) });
  const down = await after([sq, extrude("E", sq, 1, "new", { extent: "to", to: { plane: XY(-3) } })], "E");
  check("up to a plane below goes down", !down.err && near(volume(down.body), 400 * 3, 1e-3) && near(box(down.body)![0][2], -3, 1e-6), { err: down.err, v: volume(down.body) });
}

/** A face of a built body as a step refers to it. */
async function faceRef(fs: Feature[], bodyId: string, pick: (c: Vec3, n: Vec3) => boolean): Promise<FaceRef> {
  const { body } = await after(fs, bodyId);
  const f = body!.faces.find((f) => pick(f.center.toTuple() as Vec3, f.normalAt().toTuple() as Vec3))!;
  return { body: bodyId, center: f.center.toTuple() as Vec3, normal: f.normalAt().toTuple() as Vec3, area: measureArea(f) };
}

// Up to a flat face of another body (its plane, wider than the face too).
{
  const base = block("B", 10, 10, 5, [0, 0, 12]);
  const under = await faceRef(base, "B", (c, n) => near(c[2], 12) && n[2] < -0.9);
  const { body, err } = await after([...base, sq, extrude("E", sq, 1, "new", { extent: "to", to: { face: under } })], "E");
  check("up to a flat face", !err && near(volume(body), 400 * 12, 1e-3), { err, v: volume(body) });
}

// Up to a round face: a bar from the side stops at a cylinder's wall.
{
  const pillar = cylinder("C", 10, 20);
  const wall = await faceRef(pillar, "C", (c, n) => Math.abs(n[2]) < 0.1);
  const bar = sketch("b", YZ(-30), [rect("r", -2, 8, 2, 12)]);
  const { body, err } = await after([...pillar, bar, extrude("E", bar, 1, "new", { extent: "to", to: { face: wall } })], "E");
  const b = box(body);
  // From x = -30 to the wall, which is at about x = -9.8 for y in -2..2.
  check("up to a round face", !err && !!b && near(b[0][0], -30, 1e-6) && b[1][0] > -10.1 && b[1][0] < -9.7, { err, b });
}

// Start: it begins 5 from the shape.
{
  const { body, err } = await after([sq, extrude("E", sq, 10, "new", { start: 5 })], "E");
  const b = box(body);
  check("start offsets it", !err && !!b && near(b[0][2], 5, 1e-6) && near(b[1][2], 15, 1e-6), { err, b });
}

// Intersect: only what's in both stays.
{
  const disc = sketch("d", XY(-5), [circle("c", 10, 10, 5)]);
  const { body, err } = await after([...block("B", 20, 20, 10), disc, extrude("E", disc, 30, "intersect" as "new")], "B");
  check("intersect keeps the overlap", !err && near(volume(body), Math.PI * 25 * 10, 0.05), { err, v: volume(body) });
}

done();
