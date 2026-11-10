// Run: npx tsx tests/deps.test.ts [fixture] [every]
//
// A step is rebuilt only when something it read of the model changed. Real
// projects have one size of one step nudged (every few steps in turn); the
// rebuild that follows - most steps put back as they were - must give exactly
// what building the whole project from nothing gives: the same bodies, the
// same volumes and faces, the same steps failing with the same words.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC, type Shape3D } from "replicad";
import { readFileSync } from "node:fs";
import { debugBodies, rebuildStats, regenerate, resetKernel } from "../src/kernel/engine";
import type { Feature } from "../src/doc/types";

/** A fresh engine (its memory only grows: a big project built many times over would fill one). */
const fresh = async () => {
  setOC(await (opencascade as unknown as () => Promise<any>)());
  resetKernel();
};
await fresh();
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

type Path = (string | number)[];
/** A size of the step to nudge: its first number that isn't a count or part of a reference. */
function size(v: unknown, path: Path): Path | null {
  if (typeof v === "number") {
    const k = String(path[path.length - 1]);
    const top = String(path[0]);
    if (["face", "faces", "edges", "edge", "source", "axis", "plane", "vertex", "guide", "path", "cage"].includes(top)) return null;
    if (/count|sides|grid|segments|steps/i.test(k) || Math.abs(v) < 1e-6) return null;
    return path;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < Math.min(v.length, 40); i++) {
      const p = size(v[i], [...path, i]);
      if (p) return p;
    }
    return null;
  }
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (path.length === 0 && ["id", "name", "type", "suppressed", "data", "log", "exprs", "color"].includes(k)) continue;
      const p = size(x, [...path, k]);
      if (p) return p;
    }
  return null;
}
const nudged = (f: Feature, path: Path, k: number): Feature => {
  const c = structuredClone(f) as any;
  let o = c;
  for (const key of path.slice(0, -1)) o = o[key];
  o[path[path.length - 1]] *= k;
  return c;
};
/** A rebuild's result as something to compare: each body's volume, faces and edges, and what failed. */
function told(r: any): string {
  const bodies = [...debugBodies()].map(([id, s]) => {
    let v = 0;
    try {
      v = measureVolume(s as Shape3D);
    } catch {
      v = NaN;
    }
    const mesh = r.bodies.find((b: any) => b.id === id);
    return `${id} ${v.toPrecision(9)} ${mesh?.faces.length}f ${mesh?.edges.length}e ${mesh?.name}`;
  });
  return [...bodies.sort(), ...r.errors.map((e: any) => `${e.featureId}: ${e.message}`).sort(), ...(r.notes ?? []).map((e: any) => `note ${e.featureId}: ${e.message}`).sort()].join("\n");
}

const fixtures = process.argv[2] ? [process.argv[2]] : ["lamp-hand", "desklamp-hand", "valve", "fan-hand"];
const EVERY = Number(process.argv[3] ?? 7);
for (const fixture of fixtures) {
  const features: Feature[] = JSON.parse(readFileSync(new URL(`./fixtures/${fixture}.json`, import.meta.url), "utf8")).features;
  resetKernel();
  await regenerate(features, true);
  let tried = 0;
  let put = 0;
  let ran = 0;
  const wrong: string[] = [];
  let t = 0;
  let tFull = 0;
  for (let i = 0; i < features.length; i += EVERY) {
    // The next step from here with a size to nudge.
    let k = i;
    let path: Path | null = null;
    for (; k < features.length && k < i + EVERY; k++) {
      if (features[k].suppressed || features[k].type === "image") continue;
      path = size(features[k], []);
      if (path) break;
    }
    if (!path) continue;
    const changed = features.map((f, j) => (j === k ? nudged(f, path!, 1.03) : f));
    // As the app does it: the project as saved is in the engine, one step of it changes.
    if (tried % 3 === 0) await fresh();
    await regenerate(features, true);
    let t0 = performance.now();
    const quick: any = await regenerate(changed);
    t += performance.now() - t0;
    const after = features.length - k - 1;
    put += rebuildStats.reused;
    ran += rebuildStats.ran;
    const a = told(quick);
    // From nothing.
    resetKernel();
    t0 = performance.now();
    const full: any = await regenerate(changed);
    tFull += performance.now() - t0;
    const b = told(full);
    tried++;
    if (a !== b) {
      const [la, lb] = [a.split("\n"), b.split("\n")];
      const d = la.find((x, n) => x !== lb[n]) ?? "(fewer lines)";
      wrong.push(`[${k}] ${features[k].type} "${features[k].name}" ${path.join(".")}: ${d.slice(0, 140)} | from nothing: ${(lb[la.indexOf(d)] ?? "").slice(0, 140)} (${after} steps after it)`);
    }
  }
  check(`${fixture}: ${tried} steps changed one at a time, each rebuild the same as from nothing`, tried > 0 && !wrong.length, wrong.slice(0, 6).join("\n     "));
  console.log(`     steps after the changed one: ${ran} rebuilt, ${put} put back as they were; ${(t / 1000).toFixed(1)} s against ${(tFull / 1000).toFixed(1)} s from nothing`);
}
process.exit(failed ? 1 : 0);
