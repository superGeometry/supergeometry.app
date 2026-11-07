// Run: npx tsx tests/svg.test.ts - SVG → sketch curves.
import assert from "node:assert/strict";
import { parseSVG } from "../src/io/svg";
import { arrangement } from "../src/sketch/regions";

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const checks: [string, () => string][] = [
  ["mm units from width + viewBox; rect / circle become those shapes", () => {
    const { entities, size } = parseSVG(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 200 100">
      <rect x="10" y="10" width="80" height="40"/><circle cx="150" cy="50" r="20"/></svg>`);
    const kinds = entities.map((e) => e.kind).sort().join(",");
    assert.equal(kinds, "circle,rect");
    const r = entities.find((e) => e.kind === "rect") as any;
    const c = entities.find((e) => e.kind === "circle") as any;
    // 200 user units = 100 mm → 0.5 mm each.
    assert.ok(near(r.w, 40) && near(r.h, 20) && near(c.radius, 10), JSON.stringify([r, c]));
    assert.equal(arrangement(entities).regions.length, 2);
    return `size ${size.map((v) => v.toFixed(1)).join(" × ")} mm`;
  }],
  ["path with lines, a cubic, an arc and close → one closed region", () => {
    const { entities } = parseSVG(`<svg viewBox="0 0 100 100" width="100mm">
      <path d="M10 10 H60 C80 10 90 30 90 50 A40 40 0 0 1 50 90 L10 90 Z"/></svg>`);
    const kinds = entities.map((e) => e.kind);
    assert.ok(kinds.includes("spline") && kinds.includes("arc") && kinds.includes("line"), kinds.join());
    const regions = arrangement(entities).regions;
    assert.equal(regions.length, 1);
    return `${entities.length} curves, area ${regions[0].area.toFixed(0)} mm²`;
  }],
  ["relative commands, implicit repeats, groups with transforms; y flips up", () => {
    const { entities } = parseSVG(`<svg width="100px" height="100px">
      <g transform="translate(10,0)"><path d="m0,0 l10,0 0,10 -10,0 z"/></g></svg>`);
    assert.equal(entities.length, 4);
    // A 10 px square → 2.646 mm; the drawing is centred on the origin.
    const xs = entities.flatMap((e: any) => [e.a[0], e.b[0]]);
    assert.ok(near(Math.max(...xs) - Math.min(...xs), (10 * 25.4) / 96), String(xs));
    assert.equal(arrangement(entities).regions.length, 1);
    return "ok";
  }],
  ["text is skipped with a clear message when nothing else is there", () => {
    assert.throws(() => parseSVG(`<svg><text x="0" y="10">Hi</text></svg>`), /converted to paths/);
    return "ok";
  }],
];
let failed = 0;
for (const [name, fn] of checks) {
  try {
    console.log("ok  ", name, "-", fn());
  } catch (e) {
    failed++;
    console.log("FAIL", name, "-", e instanceof Error ? e.message : e);
  }
}
process.exit(failed ? 1 : 0);
