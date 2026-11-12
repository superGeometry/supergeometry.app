// Split Body with several planes, and with other bodies, at once.
// Run: npx tsx tests/splitmulti.test.ts
import type { Feature } from "../src/doc/types";
import { after, block, bodies, check, cylinder, done, near, volume, XY, YZ } from "./kit";

// A 100 × 20 × 20 bar.
const bar = block("bar", 100, 20, 20);
const split = (extra: Record<string, unknown>): Feature => ({ id: "S", name: "Split", type: "split", body: "bar", plane: YZ(30), ...extra }) as Feature;

{
  const r = await after([...bar, split({ planes: [YZ(60)] })], "bar");
  const all = bodies();
  const vols = ["bar", "S", "S:2"].map((id) => volume(all.get(id)));
  check("two planes: three pieces, biggest keeps the body", !r.err && near(vols[0], 40 * 400, 1e-3) && near(vols[1], 30 * 400, 1e-3) && near(vols[2], 30 * 400, 1e-3), { err: r.err, vols });
}

// A rod (r 5) through the bar's middle, standing up: the bar cut along it, the rod kept.
{
  const rod = cylinder("rod", 5, 40, 50, 10, -10);
  const r = await after([...bar, ...rod, split({ noPlane: true, tools: ["rod"] })], "bar");
  const all = bodies();
  const total = volume(all.get("bar")) + volume(all.get("S"));
  check("cut along another body: the bar in two pieces, adding up", !r.err && all.has("S") && near(total, 100 * 400, 1e-2), { err: r.err, total });
  check("the rod it was cut with is still there, whole", near(volume(all.get("rod")), Math.PI * 25 * 40, 1e-1), volume(all.get("rod")));
}

// A plane and a body together.
{
  const rod = cylinder("rod", 5, 40, 50, 10, -10);
  const r = await after([...bar, ...rod, split({ plane: XY(10), tools: ["rod"] })], "bar");
  const n = [...bodies().keys()].filter((id) => id === "bar" || id === "S" || id.startsWith("S:")).length;
  check("a plane and a body: four pieces", !r.err && n === 4, { err: r.err, n });
}

// Nothing crosses it: says so.
{
  const r = await after([...bar, split({ plane: YZ(500), planes: [YZ(600)] })], "bar");
  check("planes that miss it say so", !!r.err, r.err);
}

done();
