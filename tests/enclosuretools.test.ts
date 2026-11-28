// Run: npx tsx tests/enclosuretools.test.ts
// The enclosure tools: a screw boss with its ribs, a snap hook and its slot, a lip and its groove along a rim, and a
// rib from lines of a sketch - each on a tray (a 60 x 40 x 20 block hollowed from the top, walls and floor 2 thick).
import { regenerate } from "../src/kernel/engine";
import type { Feature, Vec3 } from "../src/doc/types";
import { after, block, check, done, extrude, health, line, near, poly, rect, sketch, volume, XY } from "./kit";

const PI = Math.PI;
const faceRef = (body: string, f: any) => ({ body, center: f.center, normal: f.normal, area: f.area, step: f.step, curve: f.curve });
const facing = (r: any, n: Vec3) => r.bodies[0].faces.filter((f: any) => f.type === "PLANE" && f.normal[0] * n[0] + f.normal[1] * n[1] + f.normal[2] * n[2] > 0.999);

const hollow = sketch("hs", XY(20), [rect("hr", 2, 2, 58, 38)]);
const tray: Feature[] = [...block("B", 60, 40, 20), hollow, extrude("H", hollow, -18, "cut", { target: "B" })];
const t0 = await after(tray, "B");
const V = 60 * 40 * 20 - 56 * 36 * 18;
check("the tray: a block hollowed from the top", !t0.err && near(volume(t0.body), V, 1e-6), `${volume(t0.body)} ${t0.errors}`);
const r0: any = t0.r;
const up = facing(r0, [0, 0, 1]);
const floor = faceRef("B", up.find((f: any) => near(f.center[2], 2, 1e-6)));
const rim = faceRef("B", up.find((f: any) => near(f.center[2], 20, 1e-6)));
const wall = faceRef("B", facing(r0, [1, 0, 0]).find((f: any) => near(f.center[0], 2, 1e-6)));
const box = (s: any) => s.boundingBox.bounds as [Vec3, Vec3];

// ---------------------------------------------------------------- boss
const boss = (more: Record<string, unknown> = {}): Feature =>
  ({ id: "K", name: "K", type: "boss", face: floor, at: [30, 20, 2], size: "M3", fit: "screw", diameter: 6, height: 10, hole: 2.5, holeDepth: 8, ribs: 0, ribThickness: 1.2, ribReach: 5, ...more }) as Feature;
{
  const a = await after([...tray, boss()], "B");
  check("a boss on the floor: a post 6 across and 10 tall, a 2.5 hole 8 deep", !a.err && near(volume(a.body), V + PI * 9 * 10 - PI * 1.25 * 1.25 * 8, 1e-5), `${volume(a.body) - V} ${a.errors}`);
  check("... one sound solid", health(a.body!).healthy, health(a.body!));
  const made = a.r.bodies[0].faces.filter((f: any) => f.step === "K");
  check("... its faces are the step's own", made.length >= 3, made.length);
}
{
  const a = await after([...tray, boss({ hole: 0 })], "B");
  check("no hole: a plain post", !a.err && near(volume(a.body), V + PI * 9 * 10, 1e-5), `${volume(a.body) - V} ${a.errors}`);
}
{
  const a = await after([...tray, boss({ ribs: 4 })], "B");
  const plain = V + PI * 9 * 10 - PI * 1.25 * 1.25 * 8;
  check("four ribs round its foot: more material, one sound solid", !a.err && volume(a.body) > plain + 20 && health(a.body!).healthy, `${volume(a.body) - plain} ${a.errors}`);
}
{
  // Near a corner: two of its ribs point at walls 6 away - they stop in the wall, none comes out the far side.
  const a = await after([...tray, boss({ at: [8, 8, 2], ribs: 4, ribReach: 20 })], "B");
  const [lo, hi] = a.body ? box(a.body) : [[0, 0, 0], [0, 0, 0]];
  check("ribs longer than the room they have stop at the walls", !a.err && near(lo[0], 0, 1e-6) && near(lo[1], 0, 1e-6) && near(hi[0], 60, 1e-6) && health(a.body!).healthy, `${lo} ${hi} ${a.errors}`);
}
{
  const a = await after([...tray, boss({ at: [200, 20, 2] })], "B");
  check("off the body: refused, in words", !!a.err && /off the body/.test(a.err), a.err);
  const b = await after([...tray, boss({ hole: 7 })], "B");
  check("a hole wider than the post: refused, in words", !!b.err && /narrower/.test(b.err), b.err);
}
{
  // The floor made thicker afterwards is not the test: the tray made bigger before it is. A boss in the middle stays in the middle.
  const big: Feature[] = [...block("B", 80, 40, 20), hollow, extrude("H", hollow, -18, "cut", { target: "B" })];
  const rb: any = await regenerate(big);
  const fl = faceRef("B", facing(rb, [0, 0, 1]).find((f: any) => near(f.center[2], 2, 1e-6)));
  const a = await after([...big, boss({ face: fl, centered: true, at: [1, 1, 2] })], "B");
  const post = a.r.bodies[0].faces.find((f: any) => f.step === "K" && f.round && !f.round.hole);
  check("put on the middle of the face it stands in the middle", !a.err && !!post && near(post.center[0], 30, 1e-6) && near(post.center[1], 20, 1e-6), `${post?.center} ${a.errors}`);
}

// ---------------------------------------------------------------- snap fit
const snap = (more: Record<string, unknown> = {}): Feature =>
  ({ id: "S", name: "S", type: "snap", face: floor, at: [30, 20, 2], kind: "hook", length: 8, width: 5, thickness: 1.6, overhang: 1.2, hookHeight: 2, angle: 0, clearance: 0.2, ...more }) as Feature;
{
  // The outline: the arm, and the nose (a quarter of it square, the rest sloped back to the arm's middle).
  const [t, L, o, hh] = [1.6, 8, 1.2, 2];
  const pts: [number, number][] = [[-t / 2, 0], [t / 2, 0], [t / 2, L], [t / 2 + o, L], [t / 2 + o, L + hh * 0.25], [0, L + hh], [-t / 2, L + hh]];
  let area = 0;
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length];
    area += p[0] * q[1] - q[0] * p[1];
  });
  area = Math.abs(area) / 2;
  const a = await after([...tray, snap()], "B");
  check("a hook on the floor: its outline, 5 wide", !a.err && near(volume(a.body), V + area * 5, 1e-5), `${volume(a.body) - V} ${area * 5} ${a.errors}`);
  const [, hi] = box(a.body!);
  check("... 10 tall from the floor, one sound solid", near(hi[2], 20, 1e-6) && health(a.body!).healthy, hi);
  const b = await after([...tray, snap({ angle: 90 })], "B");
  check("turned a quarter round: the same hook", !b.err && near(volume(b.body), V + area * 5, 1e-5), `${volume(b.body) - V} ${b.errors}`);
}
{
  const a = await after([...tray, snap({ kind: "slot", face: wall, at: [2, 20, 12] })], "B");
  check("a slot in the wall: the hook's size and a clearance all round, the overhang and a clearance deep", !a.err && near(volume(a.body), V - 5.4 * 2.4 * 1.4, 1e-5), `${V - volume(a.body)} ${a.errors}`);
  const b = await after([...tray, snap({ kind: "slot", face: wall, at: [2, 20, 12], through: true })], "B");
  check("... right through the wall", !b.err && near(volume(b.body), V - 5.4 * 2.4 * 2, 1e-5), `${V - volume(b.body)} ${b.errors}`);
  const c = await after([...tray, snap({ kind: "slot", face: wall, at: [2, 200, 12] })], "B");
  check("a slot off the face: refused, in words", !!c.err && /off the body/.test(c.err), c.err);
}

// ---------------------------------------------------------------- lip
const lip = (more: Record<string, unknown> = {}): Feature => ({ id: "L", name: "L", type: "lip", faces: [rim], kind: "lip", side: "inside", width: 1, height: 1.5, clearance: 0.2, ...more }) as Feature;
{
  const a = await after([...tray, lip()], "B");
  check("a lip on the inside of the rim: a band 1 wide round the opening, 1.5 tall", !a.err && near(volume(a.body), V + (58 * 38 - 56 * 36) * 1.5, 1e-5), `${volume(a.body) - V} ${a.errors}`);
  check("... one sound solid, 21.5 tall", health(a.body!).healthy && near(box(a.body!)[1][2], 21.5, 1e-6), box(a.body!)[1]);
  const b = await after([...tray, lip({ side: "outside" })], "B");
  check("on the outside: a band 1 wide round the outline", !b.err && near(volume(b.body), V + (60 * 40 - 58 * 38) * 1.5, 1e-5), `${volume(b.body) - V} ${b.errors}`);
  const c = await after([...tray, lip({ kind: "groove" })], "B");
  check("the groove for it: 0.2 wider and 0.2 deeper, cut into the rim", !c.err && near(volume(c.body), V - (58.4 * 38.4 - 56 * 36) * 1.7, 1e-5), `${V - volume(c.body)} ${c.errors}`);
  const d = await after([...tray, lip({ kind: "groove", side: "outside" })], "B");
  check("the groove on the outside", !d.err && near(volume(d.body), V - (60 * 40 - 57.6 * 37.6) * 1.7, 1e-5), `${V - volume(d.body)} ${d.errors}`);
  const e = await after([...tray, lip({ width: 2 })], "B");
  check("as wide as the wall: refused, in words", !!e.err && /as wide as the wall/.test(e.err), e.err);
  const g = await after([...tray, lip({ faces: [floor] })], "B");
  check("a face that goes round no opening: refused, in words", !!g.err && /opening/.test(g.err), g.err);
}

// ---------------------------------------------------------------- rib
const rib = (sk: Feature, ids: string[], more: Record<string, unknown> = {}): Feature =>
  ({ id: "R", name: "R", type: "rib", path: { kind: "sketch", sketch: sk.id, entities: ids }, thickness: 2, height: 8, extend: true, ...more }) as Feature;
{
  const s = sketch("rs", XY(2), [line("l", [20, 10], [20, 30])]);
  const a = await after([...tray, s, rib(s, ["l"])], "B");
  check("a line on the floor: a rib 2 thick and 8 tall, run on to the walls at both ends", !a.err && near(volume(a.body), V + 2 * 36 * 8, 1e-5), `${volume(a.body) - V} ${a.errors}`);
  check("... one sound solid", health(a.body!).healthy, health(a.body!));
  const b = await after([...tray, s, rib(s, ["l"], { extend: false })], "B");
  check("not run on: as long as the line", !b.err && near(volume(b.body), V + 2 * 20 * 8, 1e-5), `${volume(b.body) - V} ${b.errors}`);
}
{
  // Drawn above the floor: it goes down to the floor, its top where it was drawn.
  const s = sketch("rs", XY(15), [line("l", [40, 10], [40, 30])]);
  const a = await after([...tray, s, rib(s, ["l"])], "B");
  check("a line above the floor: down to the floor, and on to the walls", !a.err && near(volume(a.body), V + 2 * 36 * 13, 1e-5), `${volume(a.body) - V} ${a.errors}`);
  check("... one sound solid, no taller than the tray", health(a.body!).healthy && near(box(a.body!)[1][2], 20, 1e-6), box(a.body!)[1]);
}
{
  // A corner in the path, one end pointing at a wall and one at the open middle.
  const s = sketch("rs", XY(2), [poly("p", [[10, 20], [30, 20], [30, 30]], false)]);
  const a = await after([...tray, s, rib(s, ["p"])], "B");
  check("a path with a corner: one rib, a sound solid, inside the tray", !a.err && volume(a.body) > V + 300 && health(a.body!).healthy && near(box(a.body!)[1][0], 60, 1e-6), `${volume(a.body) - V} ${a.errors}`);
}
{
  const s = sketch("rs", XY(15), [line("l", [140, 10], [140, 30])]);
  const a = await after([...tray, s, rib(s, ["l"])], "B");
  check("lines over nothing: refused, in words", !!a.err && /nothing under/.test(a.err), a.err);
  const s2 = sketch("rs", XY(1), [line("l", [20, 10], [20, 30])]);
  const b = await after([...tray, s2, rib(s2, ["l"])], "B");
  check("lines inside the body: refused, in words", !!b.err && /inside the body/.test(b.err), b.err);
}
done();
