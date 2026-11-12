// Loft with guide curves along its sides, and with connection points.
// Run: npx tsx tests/loftrails.test.ts
import type { Feature, Vec3 } from "../src/doc/types";
import { measureVolume } from "../src/kernel/ocFree";
import { after, check, circle, done, health, poly, profile, rect, sketch, XY, XZ } from "./kit";

const volume = (s: Parameters<typeof measureVolume>[0] | undefined) => (s ? Math.abs(measureVolume(s)) : 0);

const bb = (s: { boundingBox: { bounds: [Vec3, Vec3] } } | undefined) => s?.boundingBox.bounds;
const loft = (secs: Feature[], extra: Record<string, unknown> = {}): Feature =>
  ({ id: "L", name: "Loft", type: "loft", sections: secs.map((s) => profile(s.id, (s as unknown as { entities: never[] }).entities)), ruled: false, mode: "new", ...extra }) as Feature;

// Connection points: a 20 Ã— 20 square up to a circle (r 12), 40 above.
{
  const sq = sketch("sq", XY(0), [rect("r", -10, -10, 10, 10)]);
  const ci = sketch("ci", XY(40), [circle("c", 0, 0, 12)]);
  const plain = await after([sq, ci, loft([sq, ci])], "L");
  const straight = await after([sq, ci, loft([sq, ci], { connections: [[[10, 10, 0], [12 * Math.SQRT1_2, 12 * Math.SQRT1_2, 40]]] })], "L");
  // The square's corner joined to a point a quarter turn on round the circle: a twisted loft, less inside.
  const twisted = await after([sq, ci, loft([sq, ci], { connections: [[[10, 10, 0], [-12 * Math.SQRT1_2, 12 * Math.SQRT1_2, 40]]] })], "L");
  const vs = [plain, straight, twisted].map((r) => volume(r.body));
  check("connection points: a sound solid", !straight.err && !!straight.body && health(straight.body).healthy, { err: straight.err });
  check("corner to the point over it: about as the plain loft", Math.abs(vs[1] - vs[0]) / vs[0] < 0.005, vs);
  check("corner to a point a quarter turn on: twisted, smaller", !twisted.err && vs[2] < vs[1] * 0.97, vs);
}

// A square to the same square, joined corner to corner: exactly the prism (corners kept sharp).
{
  const a = sketch("a", XY(0), [rect("r", -10, -10, 10, 10)]);
  const b = sketch("b", XY(40), [rect("r", -10, -10, 10, 10)]);
  const r = await after([a, b, loft([a, b], { connections: [[[10, 10, 0], [10, 10, 40]]] })], "L");
  check("square to square: exactly 20 × 20 × 40", !r.err && Math.abs(volume(r.body) - 16000) < 0.5, { err: r.err, v: volume(r.body) });
}

// Two guide curves: circles r 10 at 0 and 60, guides bowing out to x = Â±20 halfway up (in the XZ plane).
{
  const lo = sketch("lo", XY(0), [circle("c", 0, 0, 10)]);
  const hi = sketch("hi", XY(60), [circle("c", 0, 0, 10)]);
  const g = sketch("g", XZ(0), [poly("g1", [[10, 0], [20, 30], [10, 60]], false), poly("g2", [[-10, 0], [-20, 30], [-10, 60]], false)]);
  const rails = [
    { kind: "sketch", sketch: "g", entities: ["g1"] },
    { kind: "sketch", sketch: "g", entities: ["g2"] },
  ];
  const r = await after([lo, hi, g, loft([lo, hi], { rails })], "L");
  const b = bb(r.body);
  check("two guides: the sides bow out to them (x to about 20)", !r.err && !!b && b[1][0] > 18.5 && b[1][0] < 21 && b[0][0] < -18.5, { err: r.err, b });
  check("and not sideways (y stays about 10)", !!b && b[1][1] < 12.5, b);
  check("a sound solid", !!r.body && health(r.body).healthy);

  // A guide that misses a profile says so.
  const far = sketch("f", XZ(0), [poly("f1", [[30, 0], [40, 60]], false)]);
  const bad = await after([lo, hi, far, loft([lo, hi], { rails: [{ kind: "sketch", sketch: "f", entities: ["f1"] }] })], "L");
  check("a guide off the profiles says so", !!bad.err && /touch/.test(bad.err), bad.err);
}

done();
