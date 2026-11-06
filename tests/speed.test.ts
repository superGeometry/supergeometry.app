// Run: npx tsx tests/speed.test.ts — the faster ways give exactly what the
// slow ones did, and stay fast: a body's corners (found by position, not by
// comparing every pair), on a ruler with 11 000 edges and on smaller bodies.
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { readFileSync } from "node:fs";
import { Vector3 } from "three";
import { regenerate } from "../src/kernel/engine";
import { uniqueEnds } from "../src/view/corners";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

/** The old way: each end compared with every corner found so far. */
function slowEnds(edges: { start: number[]; end: number[] }[]): Vector3[] {
  const out: Vector3[] = [];
  for (const e of edges)
    for (const p of [e.start, e.end]) {
      const v = new Vector3(p[0], p[1], p[2]);
      if (!out.some((q) => q.distanceToSquared(v) < 1e-12)) out.push(v);
    }
  return out;
}

const fixtures: [string, any[]][] = [
  ["closet (by hand)", JSON.parse(readFileSync(new URL("./fixtures/closet-hand.json", import.meta.url), "utf8"))],
  ["watering can", JSON.parse(readFileSync(new URL("./fixtures/wateringcan-beginner.json", import.meta.url), "utf8"))],
];
// The ruler, as tests/ruler.test.ts builds it (its doc written to a temp file).
{
  const { execFileSync } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  const f = `${tmpdir()}/speed-ruler-${process.pid}.json`;
  execFileSync(process.execPath, ["--import", "tsx", new URL("./ruler.test.ts", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), f], { stdio: "ignore" });
  fixtures.push(["ruler", JSON.parse(readFileSync(f, "utf8")).features]);
}

for (const [name, feats] of fixtures) {
  const r: any = await regenerate(feats);
  let same = true;
  let n = 0;
  let tFast = 0;
  let tSlow = 0;
  for (const b of r.bodies) {
    let t = performance.now();
    const fast = uniqueEnds(b.edges);
    tFast += performance.now() - t;
    t = performance.now();
    const slow = slowEnds(b.edges);
    tSlow += performance.now() - t;
    n += fast.length;
    if (fast.length !== slow.length || fast.some((v, i) => !v.equals(slow[i]))) same = false;
  }
  check(`corners: same points in the same order — ${name}`, same, `${n} corners, ${tFast.toFixed(1)} ms (was ${tSlow.toFixed(1)} ms)`);
  if (name === "ruler") check("  …the ruler's corners in well under 50 ms", tFast < 50, `${tFast.toFixed(1)} ms`);
}
process.exit(failed ? 1 : 0);
