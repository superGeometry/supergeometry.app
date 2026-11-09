// Run: npx tsx tests/mutate.test.ts [fixture] [perStep] [seed] [from] [to]
//
// Mutation sweep of the geometry engine. Real projects (tests/fixtures) are
// replayed with one value of one step changed at a time to what people type
// by mistake and what damaged files hold: 0, the sign flipped, a millionth,
// a thousand times, a billion, nothing at all, an empty list, a reference to
// something that isn't there. Each changed step must either
//   - be refused, with a message a person can read (no engine words), or
//   - leave every body it changed a valid, closed solid with a real volume,
// and never crash the engine, or take minutes.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC, type Shape3D } from "replicad";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { debugBodies, regenerate, shapeValid, withFreshKernel } from "../src/kernel/engine";
import type { Feature } from "../src/doc/types";
import { rng, solids } from "./fuzzkit";

let restarts = 0;
const load = async () => setOC(await (opencascade as unknown as () => Promise<any>)());
await load();
/** A rebuild as the app does it: the engine loaded afresh if it breaks down. */
const rebuild = (fs: Feature[], saved = false) => withFreshKernel(async () => (restarts++, await load()), () => regenerate(fs, saved));

const FIXTURE = process.argv[2] ?? "valve";
const PER_STEP = Number(process.argv[3] ?? 3);
const SEED = Number(process.argv[4] ?? 1);
const FROM = Number(process.argv[5] ?? 0);
const TO = Number(process.argv[6] ?? 1e9);
const LOG = process.env.MUTATE_LOG;
const SLOW_MS = 30000;

const doc = JSON.parse(readFileSync(new URL(`./fixtures/${FIXTURE}.json`, import.meta.url), "utf8"));
const features: Feature[] = doc.features;
const R = rng(SEED);

type Path = (string | number)[];
/** Every value of a step worth changing: numbers, references (ids), lists. */
function leaves(v: unknown, path: Path, out: { path: Path; v: unknown }[]): void {
  if (path.length === 1 && ["id", "name", "type", "suppressed", "color", "folder"].includes(String(path[0]))) return;
  if (typeof v === "number") out.push({ path, v });
  else if (typeof v === "string") {
    // (Ids of other things; not text, modes or file contents.)
    const k = String(path[path.length - 1]);
    if (["body", "sketch", "target", "plane", "axis", "step"].includes(k) || (typeof path[path.length - 1] === "number" && ["tools", "bodies", "regions", "entities", "steps"].includes(String(path[path.length - 2])))) out.push({ path, v });
  } else if (Array.isArray(v)) {
    if (v.length && path.length) out.push({ path, v });
    // (A sketch's or a cage's hundreds of points: a few of them.)
    const some = v.length > 6 ? [0, Math.floor(v.length / 2), v.length - 1] : v.map((_, i) => i);
    for (const i of some) leaves(v[i], [...path, i], out);
  } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "data" && k !== "log") leaves(x, [...path, k], out);
}
function changes(v: unknown): unknown[] {
  if (typeof v === "number") {
    const x = v === 0 ? 1 : v;
    return [0, -x, x * 1e-6, x * 1000, 1e9, null, v === 0 ? 1e-7 : x * 1.0000001];
  }
  if (typeof v === "string") return ["nope", ""];
  return [[], null];
}
const set = (f: Feature, path: Path, v: unknown): Feature => {
  const c = structuredClone(f) as any;
  let o = c;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path[path.length - 1]] = v;
  return c;
};

/** Words of the engine's, not a person's. */
const ENGINE_WORDS = /undefined|\bNaN\b|\bnull\b|\[object|Standard_|BRep|TopoDS|Geom_|gp_|is not a function|is not iterable|Cannot read|Cannot set|not defined|exception|wasm|unreachable|out of bounds|\bptr\b|abort|^\s*$|^\d+$|stack/i;

const found: string[] = [];
const say = (kind: string, i: number, f: Feature, path: Path, v: unknown, info: string) => {
  const line = `${kind} | ${FIXTURE}[${i}] ${f.type} "${f.name}" ${path.join(".")} = ${JSON.stringify(v)} | ${info}`;
  found.push(line);
  console.log(line);
  if (LOG) appendFileSync(LOG, line + "\n");
};

const t00 = performance.now();
const base: any = await rebuild(features, true);
const baseErr = new Set(base.errors.map((e: any) => e.featureId));
console.log(`${FIXTURE}: ${features.length} steps, ${base.errors.length} failing as saved, rebuilt in ${((performance.now() - t00) / 1000).toFixed(1)} s`);

let tried = 0;
let refused = 0;
let fine = 0;
let before = new Map<string, Shape3D>();
for (let i = 0; i < features.length && i < TO; i++) {
  const f = features[i];
  if (i >= FROM && !f.suppressed && !baseErr.has(f.id)) {
    const all: { path: Path; v: unknown }[] = [];
    leaves(f, [], all);
    // A few of them, chosen by the seed.
    const pick = all.length <= PER_STEP ? all : Array.from({ length: PER_STEP }, () => all[Math.floor(R() * all.length)]);
    // (MUTATE_ALL: every value of the step, every change of it.)
    const todo = process.env.MUTATE_ALL ? all.flatMap((l) => changes(l.v).map((to) => ({ ...l, to }))) : pick.map((l) => ({ ...l, to: changes(l.v)[Math.floor(R() * changes(l.v).length)] }));
    for (const { path, v, to } of todo) {
      const m = set(f, path, to);
      if (LOG) writeFileSync(LOG + ".now", `${FIXTURE}[${i}] ${f.type} ${path.join(".")} = ${JSON.stringify(to)}\n`);
      tried++;
      const t0 = performance.now();
      let r: any;
      const restartsBefore = restarts;
      try {
        r = await rebuild([...features.slice(0, i), m]);
      } catch (err) {
        say("CRASH", i, f, path, to, String((err as Error)?.message ?? err).slice(0, 200));
        continue;
      }
      const ms = performance.now() - t0;
      if (restarts > restartsBefore) console.log(`  restart: [${i}] ${f.type} ${path.join(".")} = ${JSON.stringify(to)} (${(ms / 1000).toFixed(0)} s)`);
      if (ms > SLOW_MS) say("SLOW", i, f, path, to, `${(ms / 1000).toFixed(0)} s`);
      const errs = r.errors.filter((e: any) => !baseErr.has(e.featureId));
      const own = errs.find((e: any) => e.featureId === f.id);
      const others = errs.filter((e: any) => e.featureId !== f.id);
      if (others.length) say("OTHER", i, f, path, to, others.map((e: any) => `${e.featureId}: ${e.message}`).join(" / ").slice(0, 200));
      if (own) {
        refused++;
        if (ENGINE_WORDS.test(own.message)) say("WORDS", i, f, path, to, own.message.slice(0, 200));
        continue;
      }
      // It went through: what it changed must be sound.
      const bad: string[] = [];
      for (const [id, s] of debugBodies()) {
        if (before.get(id) === s) continue;
        try {
          const info = r.bodies.find((b: any) => b.id === id);
          const open = info?.openEdges?.length ?? 0;
          const sheet = !solids(s as Shape3D);
          // (An open freeform surface is a sheet on purpose.)
          if (sheet && (f.type === "freeform" || f.type === "transform" || f.type === "import" || f.type === "deleteGeom" || f.type === "delete")) continue;
          if (sheet) bad.push(`${id}: no solid`);
          else {
            if (open) bad.push(`${id}: ${open} open edges`);
            if (!shapeValid(s as Shape3D)) bad.push(`${id}: invalid`);
            const vol = measureVolume(s as Shape3D);
            if (!(Math.abs(vol) > 1e-9) || !Number.isFinite(vol)) bad.push(`${id}: volume ${vol}`);
          }
          if (info && Array.from(info.positions as Float32Array).some((x) => !Number.isFinite(x))) bad.push(`${id}: mesh has NaN`);
        } catch (err) {
          bad.push(`${id}: check threw ${String((err as Error)?.message ?? err).slice(0, 80)}`);
        }
      }
      if (bad.length) say("BROKEN", i, f, path, to, bad.join(", ").slice(0, 300));
      else {
        fine++;
        if (process.env.MUTATE_VERBOSE) console.log(`  sound: [${i}] ${f.type} ${path.join(".")} = ${JSON.stringify(to)} (was ${JSON.stringify(v)?.slice(0, 40)})`);
      }
    }
  }
  // The bodies as they are before the next step (unchanged: from the cache).
  await rebuild(features.slice(0, i + 1));
  before = new Map(debugBodies() as Map<string, Shape3D>);
}
console.log(`${found.length ? "FAIL" : "ok  "} ${FIXTURE}: ${tried} changes tried, ${refused} refused in words, ${fine} went through sound, ${found.length} findings, ${restarts} engine restarts, ${((performance.now() - t00) / 1000).toFixed(0)} s`);
process.exit(found.length ? 1 : 0);
