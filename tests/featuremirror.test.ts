// Run: npx tsx tests/featuremirror.test.ts
// A feature mirrored or patterned: what a step added to a body (a boss) or cut from it (a hole, a pocket) is added
// or cut again at the other place, the body itself is not copied - and it follows the step when that changes.
import { regenerate } from "../src/kernel/engine";
import { featureFamily } from "../src/doc/featureFamily";
import type { Feature, Vec3 } from "../src/doc/types";
import { after, block, check, circle, done, extrude, health, near, rect, sketch, volume, XY } from "./kit";

const PI = Math.PI;
const faceRef = (body: string, f: any) => ({ body, center: f.center, normal: f.normal, area: f.area, step: f.step, curve: f.curve });
const hollow = sketch("hs", XY(20), [rect("hr", 2, 2, 58, 38)]);
const tray: Feature[] = [...block("B", 60, 40, 20), hollow, extrude("H", hollow, -18, "cut", { target: "B" })];
const V = 60 * 40 * 20 - 56 * 36 * 18;
const r0: any = await regenerate(tray);
const floor = faceRef("B", r0.bodies[0].faces.find((f: any) => f.normal[2] > 0.99 && near(f.center[2], 2, 1e-6)));
const boss = (more: Record<string, unknown> = {}): Feature =>
  ({ id: "K", name: "K", type: "boss", face: floor, at: [12, 10, 2], size: "M3", fit: "screw", diameter: 6, height: 10, hole: 0, holeDepth: 8, ribs: 0, ribThickness: 1.2, ribReach: 4, ...more }) as Feature;
const POST = PI * 9 * 10;
// A pocket cut into the floor from above: 6 x 4, 1 deep, near one end.
const ps = sketch("ps", XY(2), [rect("pr", 8, 26, 14, 30)]);
const pocket = extrude("P", ps, -1, "cut", { target: "B" });
const drill = sketch("ds", XY(12), [circle("dc", 12, 10, 1)]);
const bore = extrude("D", drill, -6, "cut", { target: "B" });
const mid = { origin: [30, 0, 0] as Vec3, xDir: [0, 1, 0] as Vec3, normal: [1, 0, 0] as Vec3 };
const rep = (steps: string[], op: Record<string, unknown>, id = "M"): Feature => ({ id, name: id, type: "transform", bodies: ["B"], copy: true, steps, op }) as Feature;
const mirror = (steps: string[], plane = mid) => rep(steps, { kind: "mirror", plane });

{
  const a = await after([...tray, boss(), mirror(["K"])], "B");
  check("a boss mirrored across the tray's middle: the post twice, one body", !a.err && near(volume(a.body), V + 2 * POST, 1e-5) && a.r.bodies.length === 1, `${volume(a.body) - V} ${a.errors}`);
  const h = health(a.body!);
  check("... a sound solid, the second post where the first is mirrored (x 48)", h.healthy && a.r.bodies[0].faces.some((f: any) => f.round && !f.round.hole && near(f.center[0], 48, 1e-6) && near(f.center[1], 10, 1e-6)), h);
  check("... its round wall is the mirror step's own", a.r.bodies[0].faces.some((f: any) => f.step === "M" && f.round));
}
{
  const a = await after([...tray, ps, pocket, mirror(["P"])], "B");
  check("a pocket mirrored: cut again on the other side", !a.err && near(volume(a.body), V - 2 * 6 * 4 * 1, 1e-5) && health(a.body!).healthy, `${V - volume(a.body)} ${a.errors}`);
}
{
  const a = await after([...tray, boss(), drill, bore, mirror(["K", "D"])], "B");
  check("a boss and the hole drilled in it, mirrored together: the post added, then the hole cut in it", !a.err && near(volume(a.body), V + 2 * (POST - PI * 6), 1e-5) && health(a.body!).healthy, `${volume(a.body) - V} ${2 * (POST - PI * 6)} ${a.errors}`);
  const b = await after([...tray, boss(), drill, bore, mirror(["K"])], "B");
  check("the boss alone mirrored, though a hole was drilled in it since: a whole post", !b.err && near(volume(b.body), V + 2 * POST - PI * 6, 1e-5), `${volume(b.body) - V} ${b.errors}`);
}
{
  const a = await after([...tray, boss(), rep(["K"], { kind: "linear", dir: [1, 0, 0], spacing: 12, count: 4 })], "B");
  check("a boss in a row of four: three more posts, one body", !a.err && near(volume(a.body), V + 4 * POST, 1e-5) && a.r.bodies.length === 1 && health(a.body!).healthy, `${volume(a.body) - V} ${a.errors}`);
  const b = await after([...tray, boss({ at: [30, 12, 2] }), rep(["K"], { kind: "circular", axis: { origin: [30, 20, 0], dir: [0, 0, 1] }, count: 2, angle: 360 })], "B");
  check("a boss turned half way round the tray's middle: two posts", !b.err && near(volume(b.body), V + 2 * POST, 1e-5), `${volume(b.body) - V} ${b.errors}`);
}
{
  // The step changed afterwards: the mirrored one follows.
  const a = await after([...tray, boss({ height: 14 }), mirror(["K"])], "B");
  check("the boss made taller: its mirror image is as tall", !a.err && near(volume(a.body), V + 2 * PI * 9 * 14, 1e-5), `${volume(a.body) - V} ${a.errors}`);
  const first = await regenerate([...tray, boss(), mirror(["K"])]);
  const then = await after([...tray, boss({ diameter: 8 }), mirror(["K"])], "B");
  check("... and rebuilt after a change to the boss alone (nothing kept from before)", !first.errors.length && !then.err && near(volume(then.body), V + 2 * PI * 16 * 10, 1e-5), `${volume(then.body) - V} ${then.errors}`);
}
{
  const off = { origin: [100, 0, 0] as Vec3, xDir: [0, 1, 0] as Vec3, normal: [1, 0, 0] as Vec3 };
  const a = await after([...tray, boss(), mirror(["K"], off)], "B");
  check("mirrored to where the body is not: refused, in words", !!a.err && /does not touch the body|loose piece/.test(a.err), a.err);
  const b = await after([...tray, boss(), mirror(["nothing"])], "B");
  check("a step that is gone: refused, in words", !!b.err && /is gone/.test(b.err), b.err);
  const c = await after([...tray, boss({ at: [30, 20, 2] }), mirror(["K"])], "B");
  check("mirrored onto itself: refused, in words", !!c.err && /there already/.test(c.err), c.err);
  const d = await after([...tray, ps, pocket, mirror(["P"], off)], "B");
  check("a pocket mirrored to where the body is not: refused, in words", !!d.err && /changes nothing|off the body/.test(d.err), d.err);
}
{
  // Everything built on the feature comes with it: a screw hole drilled into the boss's top afterwards.
  const r1: any = await regenerate([...tray, boss()]);
  const topOf = r1.bodies[0].faces.find((f: any) => f.step === "K" && f.normal[2] > 0.99);
  const hole = { id: "Hh", name: "Hh", type: "hole", face: faceRef("B", topOf), at: [12, 10, 12], size: "M3", diameter: 2, through: false, depth: 6, head: "none", headDiameter: 4, headDepth: 1 } as Feature;
  const other = { ...boss({ at: [30, 30, 2] }), id: "K2", name: "K2" } as Feature;
  const steps = [...tray, boss(), other, hole];
  const family = featureFamily(steps, ["K"]);
  check("a boss's family: itself and the hole drilled into it - not the other boss, nor the tray's own steps", JSON.stringify(family) === JSON.stringify(["K", "Hh"]), JSON.stringify(family));
  const a = await after([...steps, mirror(family)], "B");
  check("... mirrored whole: a second post with its hole", !a.err && near(volume(a.body), V + 3 * POST - 2 * PI * 6, 1e-5) && health(a.body!).healthy, `${volume(a.body) - V} ${3 * POST - 2 * PI * 6} ${a.errors}`);
  check("a mirror of the boss is not one of its family (mirrored again, it is not repeated twice)", JSON.stringify(featureFamily([...steps, mirror(family)], ["K"])) === JSON.stringify(["K", "Hh"]));
  check("a step that is not there: no family", featureFamily(steps, ["nope"]).length === 0);
}
done();
