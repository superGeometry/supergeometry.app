// Sweep's Profile position, Orientation and Corners; Loft's start and end continuity.
// Run: npx tsx tests/sweeploftopts.test.ts
import type { Feature, Vec3 } from "../src/doc/types";
import { after, check, circle, done, line, near, poly, sketch, volume, XY, XZ, YZ } from "./kit";
import { arrangement, regionRef } from "../src/sketch/regions";

const regions = (sk: Feature) => arrangement((sk as { entities: never }).entities).regions.map(regionRef);
const bounds = (s: { boundingBox: { bounds: [Vec3, Vec3] } } | undefined) => s?.boundingBox.bounds;

// An L-shaped path in XY: (0,0) → (40,0) → (40,40).
const path = sketch("p", XY(), [line("a", [0, 0], [40, 0]), line("b", [40, 0], [40, 40])]);
const sweep = (id: string, src: Feature, extra: Record<string, unknown> = {}): Feature =>
  ({ id, name: id, type: "sweep", source: { kind: "profile", sketch: src.id, regions: regions(src) }, path: { kind: "sketch", sketch: "p", entities: ["a", "b"] }, mode: "new", ...extra }) as Feature;

// A square profile square to the path at its start (on YZ through the origin).
const sq = sketch("q", YZ(), [poly("r", [[-3, -3], [3, -3], [3, 3], [-3, 3]])]);
{
  const round = await after([path, sq, sweep("S", sq)], "S");
  const mitre = await after([path, sq, sweep("S", sq, { corner: "mitre" })], "S");
  check("a round-cornered sweep builds", !round.err && volume(round.body) > 36 * 70, { err: round.err, v: volume(round.body) });
  check("a mitred one fills the corner out (more than round)", !mitre.err && volume(mitre.body) > volume(round.body) + 1, { err: mitre.err, round: volume(round.body), mitre: volume(mitre.body) });
  check("a mitred corner is square: the outside corner reaches (43, -3)", !mitre.err && near(bounds(mitre.body)![1][0], 43, 1e-3) && near(bounds(mitre.body)![0][1], -3, 1e-3), bounds(mitre.body));
}

// Profile position: a circle drawn off to the side, flat on XY - moved onto the path's start.
{
  const off = sketch("o", XY(), [circle("c", -20, 30, 2)]);
  const s = await after([path, off, sweep("S", off, { position: "start" })], "S");
  const want = Math.PI * 4 * 80; // about: the bend's a little less
  check("on the path's start: a tube along the path", !s.err && Math.abs(volume(s.body) - want) < want * 0.05, { err: s.err, v: volume(s.body), want });
  const b = bounds(s.body);
  check("it runs along the path (x 0…42, y -2…40)", !!b && near(b[0][0], 0, 0.05) && near(b[1][1], 40, 0.05), b);
}

// Orientation: along a slanted line (40 across, 20 up in Y), the square stays
// facing +X (parallel: its cross-section along X is 6×6 for 40 → 1440) or
// turns square to the line (normal: 6×6 for the line's whole 44.7 → 1610).
{
  const slant = sketch("p", XY(), [line("a", [0, 0], [40, 20])]);
  const one = (extra: Record<string, unknown>): Feature => ({ ...sweep("S", sq, extra), path: { kind: "sketch", sketch: "p", entities: ["a"] } }) as Feature;
  const s = await after([slant, sq, one({ orientation: "parallel" })], "S");
  check("parallel to profile: the square keeps facing +X", !s.err && near(volume(s.body), 36 * 40, 0.5), { err: s.err, v: volume(s.body) });
  const t = await after([slant, sq, one({ orientation: "parallel", twist: 30 })], "S");
  check("a twist with parallel says why it can't", !!t.err && /Normal to path/.test(t.err), t.err);
}

// Loft: two squares 30 apart, then the same with the start leaving straight out (G1).
{
  const a = sketch("la", XY(), [poly("r", [[-10, -10], [10, -10], [10, 10], [-10, 10]])]);
  const b = sketch("lb", XY(30), [poly("r", [[-4, -4], [4, -4], [4, 4], [-4, 4]])]);
  const loft = (extra: Record<string, unknown> = {}): Feature =>
    ({ id: "L", name: "L", type: "loft", sections: [a, b].map((s) => ({ kind: "profile", sketch: s.id, regions: regions(s) })), ruled: false, mode: "new", ...extra }) as Feature;
  const free = await after([a, b, loft()], "L");
  const g1 = await after([a, b, loft({ startContinuity: "g1" })], "L");
  const g2 = await after([a, b, loft({ startContinuity: "g2", endContinuity: "g1", endWeight: 2 })], "L");
  check("a free loft builds", !free.err && volume(free.body) > 0, free.err);
  check("G1 at the start: fuller near the start (more volume)", !g1.err && volume(g1.body) > volume(free.body) + 1, { err: g1.err, free: volume(free.body), g1: volume(g1.body) });
  check("G2 and G1 with a magnitude build", !g2.err && volume(g2.body) > 0, g2.err);
  check("the ends stay where they were (z 0…30)", !g1.err && near(bounds(g1.body)![0][2], 0, 1e-3) && near(bounds(g1.body)![1][2], 30, 1e-3), bounds(g1.body));
  const ruled = await after([a, b, loft({ ruled: true, startContinuity: "g1" })], "L");
  check("straight sides with continuity say why not", !!ruled.err, ruled.err);
}

void XZ;
done();
