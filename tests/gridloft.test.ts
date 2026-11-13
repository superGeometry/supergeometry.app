// Run: npx tsx tests/gridloft.test.ts
// Lofts between every pair of six outlines (a circle, a square, a triangle, a
// hexagon, an L, a star) - straight above, to the side, half the size; smooth
// and straight-sided; and through a waist, with the ends left straight - and
// sweeps of four profiles (a circle, a square, a triangle, a ring) along six
// paths, plain, facing the same way, ending at half size, twisted: each held
// to its volume (the same outline at both ends of a loft is exactly a prism or
// a frustum; a sweep is its profile's area times the path, by Pappus).
//
// What a sweep can't do it says: facing the same way along a leg that lies in
// the profile's own plane (that leg came out missing, or the engine never came
// back), a profile that changes size or turns round a sharp corner of the path
// (two pieces run through each other).
import { circle, done, line, poly, profile, rect, sketch, XY, XZ } from "./kit";
import { build, near, say } from "./grid";
import type { Feature, SketchEntity } from "../src/doc/types";

const ngon = (n: number, r: number, cx: number, cy: number, turn = 0): [number, number][] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(turn + (i * 2 * Math.PI) / n), cy + r * Math.sin(turn + (i * 2 * Math.PI) / n)]);
const area = (pts: [number, number][]) => Math.abs(pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0)) / 2;

// ------------------------------------------------------------ lofts
{
  const star: [number, number][] = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 6 : 12;
    const a = (i * Math.PI) / 5;
    return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
  });
  const L: [number, number][] = [[-12, -12], [12, -12], [12, -2], [-2, -2], [-2, 12], [-12, 12]];
  const shapes: [string, (dx: number, k: number) => SketchEntity[], number][] = [
    ["a circle", (dx, k) => [circle("c", dx, 0, 10 * k)], Math.PI * 100],
    ["a square", (dx, k) => [rect("r", dx - 10 * k, -10 * k, dx + 10 * k, 10 * k)], 400],
    ["a triangle", (dx, k) => [poly("p", ngon(3, 12 * k, dx, 0, Math.PI / 2))], area(ngon(3, 12, 0, 0))],
    ["a hexagon", (dx, k) => [poly("p", ngon(6, 11 * k, dx, 0))], area(ngon(6, 11, 0, 0))],
    ["an L", (dx, k) => [poly("p", L.map(([x, y]) => [dx + x * k, y * k] as [number, number]))], area(L)],
    ["a star", (dx, k) => [poly("p", star.map(([x, y]) => [dx + x * k, y * k] as [number, number]))], area(star)],
  ];
  for (const [na, A, areaA] of shapes) {
    for (const [nb, B, areaB] of shapes)
      for (const [where, dx, k] of [["straight above", 0, 1], ["above and 15 to the side", 15, 1], ["above, half the size", 0, 0.5]] as const) {
        const s1 = sketch("s1", XY(0), A(0, 1));
        const s2 = sketch("s2", XY(30), B(dx, k));
        const sections = [profile("s1", A(0, 1)), profile("s2", B(dx, k))];
        for (const ruled of [false, true]) {
          const g = await build([s1, s2, { id: "Lf", name: "Lf", type: "loft", sections, ruled, mode: "new" } as Feature]);
          const a1 = areaB * k * k;
          // The same outline at both ends: exactly a prism (leaning, to the side) or a frustum.
          const exact = na === nb ? (30 / 3) * (areaA + a1 + Math.sqrt(areaA * a1)) : null;
          const lo = Math.min(areaA, a1) * 30 * 0.9;
          const hi = Math.max(areaA, a1) * 30 * 1.1;
          const ok = !g.errors.length && !g.unsound.length && (exact !== null ? near(g.vol.Lf, exact, 3e-4) : g.vol.Lf > lo && g.vol.Lf < hi);
          say(ok, `loft ${ruled ? "straight-sided" : "smooth"}: ${na} to ${nb}, ${where}`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.Lf?.toFixed(1)} ${exact !== null ? "want " + exact.toFixed(1) : `between ${lo.toFixed(0)} and ${hi.toFixed(0)}`}`);
        }
      }
    // Through a waist (the middle one half the size).
    const s1 = sketch("s1", XY(0), A(0, 1));
    const s2 = sketch("s2", XY(20), A(0, 0.5));
    const s3 = sketch("s3", XY(40), A(0, 1));
    const sections = [profile("s1", A(0, 1)), profile("s2", A(0, 0.5)), profile("s3", A(0, 1))];
    for (const [label, extra] of [["smooth", {}], ["straight-sided", { ruled: true }], ["leaving both ends straight (G1)", { startContinuity: "g1", endContinuity: "g1" }], ["holding the curve at both ends (G2)", { startContinuity: "g2", endContinuity: "g2" }]] as const) {
      const g = await build([s1, s2, s3, { id: "Lf", name: "Lf", type: "loft", sections, ruled: false, mode: "new", ...extra } as Feature]);
      // (Straight-sided: two frustums, exactly.)
      const two = 2 * (20 / 3) * (areaA + areaA / 4 + areaA / 2);
      const ok = !g.errors.length && !g.unsound.length && (label === "straight-sided" ? near(g.vol.Lf, two, 3e-4) : g.vol.Lf > areaA * 40 * 0.3 && g.vol.Lf < areaA * 40 * 1.1);
      say(ok, `loft through a waist, ${label}: ${na}`, `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.Lf?.toFixed(1)} ${label === "straight-sided" ? "want " + two.toFixed(1) : `of ${(areaA * 40).toFixed(0)}`}`);
    }
  }
}

// ------------------------------------------------------------ sweeps
{
  // Profiles on the ground plane round the origin; paths on the front plane, leaving the origin straight up.
  const profiles: [string, SketchEntity[], number][] = [
    ["a circle", [circle("c", 0, 0, 3)], Math.PI * 9],
    ["a square", [rect("r", -3, -3, 3, 3)], 36],
    ["a triangle", [poly("p", ngon(3, 4, 0, 0, Math.PI / 2))], area(ngon(3, 4, 0, 0))],
    ["a ring", [circle("c", 0, 0, 4), circle("d", 0, 0, 2)], Math.PI * 12],
  ];
  const arc = (id: string, a: [number, number], m: [number, number], b: [number, number]) => ({ id, kind: "arc", a, m, b }) as unknown as SketchEntity;
  const h = Math.SQRT1_2;
  // name, the curves, its length and how far up it gets (null: a spline - not worked out), a sharp corner?
  const paths: [string, SketchEntity[], number | null, number, boolean][] = [
    ["a straight line", [line("l", [0, 0], [0, 40])], 40, 40, false],
    ["a quarter circle", [arc("a", [0, 0], [30 - 30 * h, 30 * h], [30, 30])], (Math.PI * 30) / 2, 30, false],
    ["a line then a quarter circle", [line("l", [0, 0], [0, 20]), arc("a2", [0, 20], [20 - 20 * h, 20 + 20 * h], [20, 40])], 20 + (Math.PI * 20) / 2, 40, false],
    ["an S of two arcs", [arc("a", [0, 0], [20 - 20 * h, 20 * h], [20, 20]), arc("a2", [20, 20], [20 + 20 * h, 40 - 20 * h], [40, 40])], Math.PI * 20, 40, false],
    ["a smooth spline", [{ id: "sp", kind: "spline", points: [[0, 0], [2, 15], [15, 30], [35, 35]], closed: false, mode: "fit" } as unknown as SketchEntity], null, 35, false],
    ["an L with a sharp corner", [poly("p", [[0, 0], [0, 30], [30, 30]], false)], null, 30, true],
  ];
  for (const [np, P, ar] of profiles)
    for (const [nq, Q, length, rise, sharp] of paths) {
      const sp = sketch("sp", XY(0), P);
      const sq = sketch("sq", XZ(), Q);
      let src = profile("sp", P);
      if (np === "a ring") src = { ...src, regions: src.regions.filter((r) => r.a > 20) };
      const path = { kind: "sketch", sketch: "sq", entities: Q.map((e) => e.id) };
      const sweep = (extra: object) => build([sp, sq, { id: "Sw", name: "Sw", type: "sweep", source: src, path, mode: "new", ...extra } as Feature]);
      const fine = (g: Awaited<ReturnType<typeof build>>, want: number | null) => !g.errors.length && !g.unsound.length && (want !== null ? near(g.vol.Sw, want, 5e-4) : g.vol.Sw > 0);
      const told = (g: Awaited<ReturnType<typeof build>>, want: number | null) => `${g.errors.join(" | ")} ${g.unsound} got ${g.vol.Sw?.toFixed(2)}${want !== null ? " want " + want.toFixed(2) : ""}`;
      const round = np === "a circle" || np === "a ring";

      // Plain: the profile's area times the path's length.
      const plain = length !== null ? ar * length : null;
      let g = await sweep({});
      say(fine(g, plain), `sweep ${np} along ${nq}`, told(g, plain));
      if (sharp) {
        g = await sweep({ corner: "mitre" });
        say(fine(g, null), `sweep ${np} along ${nq}, mitred corner`, told(g, null));
      }
      // Facing the same way: the area times how far the path gets along the way the profile faces.
      g = await sweep({ orientation: "parallel" });
      if (sharp) say(/slides along its own plane/.test(g.errors.join()), `sweep ${np} along ${nq}, facing the same way: no thickness along the second leg - said so`, told(g, null));
      else say(fine(g, ar * rise), `sweep ${np} along ${nq}, facing the same way`, told(g, ar * rise));
      // Ending at half size: the size runs evenly from 1 to 1/2 - 7/12 of the plain sweep.
      g = await sweep({ scale: 0.5 });
      if (sharp && np !== "a circle") say(/sharp corner/.test(g.errors.join()), `sweep ${np} along ${nq}, ending at half size: not round a sharp corner - said so`, told(g, null));
      else say(fine(g, plain !== null ? (plain * 7) / 12 : null), `sweep ${np} along ${nq}, ending at half size`, told(g, plain !== null ? (plain * 7) / 12 : null));
      // Twisted a quarter turn: the same volume (the profile turns about its own middle).
      g = await sweep({ twist: 90 });
      if (sharp && !round) say(/sharp corner/.test(g.errors.join()), `sweep ${np} along ${nq}, twisted 90: not round a sharp corner - said so`, told(g, null));
      else say(fine(g, plain), `sweep ${np} along ${nq}, twisted 90`, told(g, plain));
    }
}
done();
