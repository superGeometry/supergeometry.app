// Run: npx tsx tests/freeform.test.ts — cages, subdivision and the cage → solid conversion.
import assert from "node:assert/strict";
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC, type Shape3D } from "replicad";
import { boundaryEdges, boxCage, bridgeLoops, cageEdgeKey, cageEdges, cylinderCage, deleteFaces, fillLoop, holeLoops, isClosed, planeCage, sphereCage, subdivide } from "../src/freeform/cage";
import { cageToShape } from "../src/kernel/freeform";
import { evalSurface, interpolateGrid } from "../src/freeform/bspline";

setOC(await (opencascade as unknown as () => Promise<any>)());

const checks: [string, () => string][] = [
  ["cages are closed (box, cylinder, sphere) / open (plane)", () => {
    assert.ok(isClosed(boxCage()));
    assert.ok(isClosed(cylinderCage()));
    assert.ok(isClosed(sphereCage()));
    assert.ok(!isClosed(planeCage()));
    return `box ${boxCage().verts.length} pts, cylinder ${cylinderCage().faces.length} faces`;
  }],
  ["subdivision: every face becomes a 9×9 grid sharing its borders", () => {
    const s = subdivide(boxCage(), 3);
    assert.equal(s.n, 8);
    assert.equal(s.grids.length, 24);
    // Euler characteristic of a closed surface: V − E + F = 2.
    const F = s.grids.length * 64;
    const E = (F * 4) / 2;
    assert.equal(s.points.length - E + F, 2);
    return `${s.points.length} points`;
  }],
  ["patch surfaces pass through their grid points", () => {
    const s = subdivide(sphereCage(40), 3);
    const g = s.grids[5].map((row) => row.map((i) => s.points[i]));
    const poles = interpolateGrid(g);
    let worst = 0;
    for (let i = 0; i <= 8; i++)
      for (let j = 0; j <= 8; j++) {
        const q = evalSurface(poles, i / 8, j / 8);
        worst = Math.max(worst, Math.hypot(q[0] - g[i][j][0], q[1] - g[i][j][1], q[2] - g[i][j][2]));
      }
    assert.ok(worst < 1e-9, `off by ${worst}`);
    return `max error ${worst.toExponential(1)}`;
  }],
  ["sphere cage → near-spherical solid of ~diameter 40", () => {
    const solid = cageToShape(sphereCage(40));
    const v = measureVolume(solid);
    const ideal = (4 / 3) * Math.PI * 20 ** 3;
    const bb = solid.boundingBox;
    assert.ok(Math.abs(v - ideal) / ideal < 0.12, `volume ${v} vs ${ideal}`);
    return `vol ${v.toFixed(0)} (sphere ${ideal.toFixed(0)}), ${solid.faces.length} faces, size ${bb.width.toFixed(1)}`;
  }],
  ["box cage → closed solid", () => {
    const solid = cageToShape(boxCage([40, 40, 40], 2));
    const v = measureVolume(solid);
    assert.ok(v > 20000 && v < 64000, `volume ${v}`);
    return `vol ${v.toFixed(0)}, ${solid.faces.length} faces`;
  }],
  ["cylinder cage → closed solid", () => {
    const solid = cageToShape(cylinderCage(40, 40));
    const v = measureVolume(solid);
    assert.ok(v > 20000, `volume ${v}`);
    return `vol ${v.toFixed(0)}`;
  }],
  ["moving a cage point bulges the shape", () => {
    const c = sphereCage(40);
    const top = c.verts.reduce((best, p, i) => (p[2] > c.verts[best][2] ? i : best), 0);
    const before = cageToShape(c).boundingBox.depth;
    c.verts[top] = [c.verts[top][0], c.verts[top][1], c.verts[top][2] + 20];
    const after = cageToShape(c).boundingBox.depth;
    assert.ok(after > before + 5, `${before} → ${after}`);
    return `height ${before.toFixed(1)} → ${after.toFixed(1)}`;
  }],
  ["plane surface thickened up / down / both → solids of the same volume", () => {
    const vols = (["up", "down", "both"] as const).map((side) => {
      const s = cageToShape(planeCage([60, 60], 4), 3, { thickness: 2, side });
      const bb = s.boundingBox;
      return { v: measureVolume(s), zmin: bb.bounds[0][2], zmax: bb.bounds[1][2] };
    });
    for (const x of vols) assert.ok(Math.abs(x.v - vols[0].v) / vols[0].v < 0.02 && x.v > 1000, JSON.stringify(vols));
    assert.ok(vols[0].zmin > -0.01 && vols[1].zmax < 0.01 && vols[2].zmin < -0.9 && vols[2].zmax > 0.9, JSON.stringify(vols));
    return vols.map((x) => `${x.v.toFixed(0)} [${x.zmin.toFixed(1)}…${x.zmax.toFixed(1)}]`).join(", ");
  }],
  ["delete a face, then fill the hole again → closed solid", () => {
    const box = boxCage([40, 40, 40], 2);
    const holed = deleteFaces(box, [0]);
    assert.ok(!isClosed(holed));
    const rim = new Set(boundaryEdges(holed).map(([a, b]) => cageEdgeKey(a, b)));
    const loops = holeLoops(holed, rim);
    assert.equal(loops.length, 1);
    const filled = fillLoop(holed, loops[0])!;
    assert.ok(isClosed(filled));
    const v = measureVolume(cageToShape(filled));
    assert.ok(v > 0, `volume ${v}`);
    return `hole of ${loops[0].length} edges filled, vol ${v.toFixed(0)}`;
  }],
  ["two facing holes bridged → closed (tunnel)", () => {
    // Box, 3 per side: remove the middle top and middle bottom quads → a hole through.
    const box = boxCage([40, 40, 40], 3);
    const holed = deleteFaces(box, [4, 13]);
    const loops = holeLoops(holed, new Set(boundaryEdges(holed).map(([a, b]) => cageEdgeKey(a, b))));
    assert.equal(loops.length, 2);
    const tube = bridgeLoops(holed, loops[0], loops[1])!;
    assert.ok(isClosed(tube));
    const solid = cageToShape(tube);
    const full = measureVolume(cageToShape(box));
    // A real hole through: less than the full box, but most of it is still there.
    assert.ok(measureVolume(solid) > full * 0.5 && measureVolume(solid) < full * 0.97, `volume ${measureVolume(solid)} vs box ${full}`);
    return `${tube.faces.length} faces, vol ${measureVolume(solid).toFixed(0)}`;
  }],
  ["plane cage → open surface (a shell, no volume)", () => {
    const sheet = cageToShape(planeCage([60, 60], 4)) as Shape3D;
    assert.equal(sheet.faces.length, 16);
    return `${sheet.faces.length} faces, ${cageEdges(planeCage()).length} cage edges`;
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  try {
    console.log("ok  ", name, "—", fn());
  } catch (e) {
    failed++;
    console.log("FAIL", name, "—", e instanceof Error ? e.message : e);
  }
}
process.exit(failed ? 1 : 0);
