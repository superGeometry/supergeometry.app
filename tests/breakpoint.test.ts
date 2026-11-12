// The History's breakpoint: the steps after it are off until it's removed.
// Run: npx tsx tests/breakpoint.test.ts
import type { Feature } from "../src/doc/types";
import { after, block, check, circle, done, extrude, near, sketch, volume, XY } from "./kit";

const hole = sketch("h", XY(10), [circle("c", 10, 10, 3)]);
const cut = extrude("C", hole, -10, "cut");
const all: Feature[] = [...block("B", 20, 20, 10), hole, cut];

{
  const on = await after(all, "B");
  check("without a breakpoint the hole is cut", !on.err && near(volume(on.body), 4000 - Math.PI * 9 * 10, 0.05), { err: on.err, v: volume(on.body) });
  const back = await after(all.map((f) => (f.id === "C" || f.id === "h" ? { ...f, rolledBack: true } : f)), "B");
  check("after the breakpoint the cut is off", !back.err && near(volume(back.body), 4000, 1e-3), { err: back.err, v: volume(back.body) });
  check("and its sketch is not drawn", !back.r.sketchBoundaries?.h || !back.r.sketchBoundaries.h.length, Object.keys(back.r.sketchBoundaries ?? {}));
}

done();
