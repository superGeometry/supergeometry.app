// Run: npx tsx tests/sweepgaps.test.ts - a tube swept along a spline comes out
// whole. Sweeps used the path's Frenet frame, which flips half a turn where a
// bend changes side and is undefined where the path runs straight: a user's
// S-curve tube (tests/fixtures/sweepgaps.json, its circle 2.34 off the path)
// broke into pieces that jumped sideways, and the fan's guard spokes came out
// short. Checked: the tube is as long as its path (no shorter than the
// straight lines between the path's points), and its volume and its side
// give the same length (a broken tube's don't).
import opencascade from "replicad-opencascadejs";
import { measureArea, measureVolume, setOC } from "replicad";
import { readFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const chords = (pts: number[][]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

async function tube(name: string, feats: any[], id: string, r: number, path: number[][]) {
  const res: any = await regenerate(feats);
  const s = debugBodies().get(id)!;
  check(`${name}: builds, one clean solid`, !res.errors.length && !!s && isHealthy(healthOf(s)), res.errors.map((e: any) => e.message).join("; "));
  const side = s.faces.reduce((a, f) => Math.max(a, measureArea(f)), 0);
  const byside = side / (2 * Math.PI * r);
  const byvol = Math.abs(measureVolume(s)) / (Math.PI * r * r);
  const c = chords(path);
  check("…as long as its path", byside >= c && byside < c * 1.1, `${byside.toFixed(2)} (straight lines ${c.toFixed(2)})`);
  check("…volume and side agree (no pieces jumping off)", Math.abs(byvol - byside) < byside * 0.005, `${byvol.toFixed(2)} vs ${byside.toFixed(2)}`);
}

const doc = JSON.parse(readFileSync(new URL("./fixtures/sweepgaps.json", import.meta.url), "utf8"));
await tube("S-curve tube, circle off the path", doc.features, "sweep-mw6p7ni3-sy2n", 2.5, doc.features[0].entities[0].points);

const spokePath = [[-62, 320], [-64, 300], [-71, 262], [-77, 226]];
await tube(
  "fan guard spoke",
  [
    { id: "sSpokePath", name: "Spoke path", type: "sketch", plane: { origin: [0, 0, 0], normal: [1, 0, 0], xDir: [0, 1, 0] }, entities: [{ id: "sp1", kind: "spline", points: spokePath, closed: false, mode: "fit" }] },
    { id: "sSpoke", name: "Spoke", type: "sketch", plane: { origin: [0, 0, 320], normal: [0, 0, 1], xDir: [1, 0, 0] }, entities: [{ id: "c", kind: "circle", center: [0, -62], radius: 1.4 }] },
    { id: "spoke", name: "Spoke", type: "sweep", source: { kind: "profile", sketch: "sSpoke", regions: [{ c: [0, -62], a: Math.PI * 1.96 }] }, path: { kind: "sketch", sketch: "sSpokePath", entities: ["sp1"] }, mode: "new" },
  ],
  "spoke",
  1.4,
  spokePath,
);
process.exit(failed ? 1 : 0);
