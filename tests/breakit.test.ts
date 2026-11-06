// Run: npx tsx tests/breakit.test.ts [scenarios] [steps] [seed]
//
// Tries to break the geometry engine: random (but repeatable) sequences of
// edits on boxes, cylinders, L-shapes, plates with holes and revolved parts —
// offsets in and out (huge ones too), fillets and chamfers of any size, faces
// moved and tilted, corners and edges dragged, faces deleted, shells, booleans,
// face scaling, extrusions from faces. A step may fail with a message (that's
// fine: "can't do that"). A step that succeeds must leave every body a single,
// valid, closed solid with a sane volume and no hair-thin faces.
import opencascade from "replicad-opencascadejs";
import { getOC, measureArea, setOC, type Shape3D } from "replicad";
import { writeFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import type { Feature } from "../src/doc/types";
import { base, problems, randomStep, rng, solids } from "./fuzzkit";

setOC(await (opencascade as unknown as () => Promise<any>)());
const oc = getOC();

const SCENARIOS = Number(process.argv[2] ?? 10);
const STEPS = Number(process.argv[3] ?? 6);
const SEED = Number(process.argv[4] ?? 1);

const repaired: string[] = [];
const failures: { scenario: number; step: string; problems: string[]; features: Feature[] }[] = [];
let ok = 0;
let refused = 0;
const refusedBy: Record<string, number> = {};
const refusedWhy: Record<string, number> = {};
const ONLY = process.env.BREAKIT_ONLY ? Number(process.env.BREAKIT_ONLY) : null;
for (let sc = 0; sc < SCENARIOS; sc++) {
  if (ONLY !== null && sc !== ONLY) {
    // (Keep the random sequence the same: nothing else uses it across scenarios.)
    continue;
  }
  const R = rng(SEED * 1000 + sc);
  let features = base(R, sc);
  let res: any = await regenerate(features);
  if (res.errors.length) {
    console.log(`scenario ${sc}: base failed: ${res.errors[0].message}`);
    continue;
  }
  const size = Math.max(...res.bodies[0].faces.map((f: any) => Math.max(...f.center.map(Math.abs)))) * 2 || 20;
  for (let st = 0; st < STEPS; st++) {
    const step = randomStep(R, st, res, size);
    if (!step) continue;
    const prevSolids = new Map(debugBodies());
    // What every body looks like now (its faces' areas): a step must never change an earlier result.
    // (A face whose area can't even be measured shows up as "?" — and as a failure below.)
    const area = (f: any) => {
      try {
        return measureArea(f).toFixed(4);
      } catch {
        return "?";
      }
    };
    const sig = (m: Map<string, Shape3D>) => [...m].map(([k, v]) => `${k}:${v.faces.map(area).join(",")}`).join("|");
    const sigBefore = sig(prevSolids);
    if (sigBefore.includes("?")) {
      failures.push({ scenario: sc, step: "(earlier step)", problems: ["a body has a face whose area can't be measured"], features });
      break;
    }
    const next = [...features, step];
    let r: any;
    try {
      r = await regenerate(next);
    } catch (err) {
      failures.push({ scenario: sc, step: step.name, problems: [`threw: ${(err as Error).message}`], features: next });
      break;
    }
    const err = r.errors.find((e: any) => e.featureId === step.id);
    if (!err && (r.notes ?? []).some((n: any) => n.featureId === step.id && /Repaired automatically/.test(n.message))) repaired.push(step.name);
    if (sig(prevSolids) !== sigBefore) {
      failures.push({ scenario: sc, step: step.name, problems: ["changed an earlier step's result"], features: next });
      console.log(`FAIL scenario ${sc} step ${st} (${step.name}): changed an earlier step's result${err ? " (refused)" : ""}`);
      break;
    }
    if (ONLY !== null) console.log(`  step ${st} ${step.name}: ${err ? "refused: " + err.message : "ok"} | ${r.bodies.map((b: any) => b.id + ":" + b.faces.length + "f").join(" ")}`);
    if (ONLY !== null && process.env.BREAKIT_DUMP) writeFileSync(`${process.env.BREAKIT_DUMP}-${st}.json`, JSON.stringify(next));
    if (err) {
      refused++;
      refusedBy[step.name] = (refusedBy[step.name] ?? 0) + 1;
      const why = `${step.name}: ${String(err.message).slice(0, 90)}`;
      refusedWhy[why] = (refusedWhy[why] ?? 0) + 1;
      continue; // a clear "can't" — fine; try something else
    }
    const solidsNow = new Map(debugBodies());
    const bad: string[] = [];
    for (const b of r.bodies) {
      const s = solidsNow.get(b.id);
      if (!s) continue;
      const mayPart = step.type === "boolean" || step.type === "split" || (step.type === "extrude" && !(step.source.kind === "face" && step.target === step.source.face.body && step.mode !== "new"));
      const prev = prevSolids.get(b.id);
      const p = problems(s, b.openEdges.length, mayPart, prev ? solids(prev) : 1);
      if (p.length) bad.push(`${b.name}: ${p.join(", ")}`);
    }
    if (bad.length) {
      failures.push({ scenario: sc, step: step.name, problems: bad, features: next });
      console.log(`FAIL scenario ${sc} step ${st} (${step.name}): ${bad.join("; ")}`);
      break;
    }
    ok++;
    features = next;
    res = r;
  }
}
// Only when asked (BREAKIT_OUT=file), so a normal run leaves nothing behind.
if (process.env.BREAKIT_OUT) writeFileSync(process.env.BREAKIT_OUT, JSON.stringify(failures, null, 1));
if (repaired.length) console.log(`${repaired.length} edits saved by the automatic repair (${[...new Set(repaired)].join(", ")})`);
console.log(`${ok} edits ok, ${refused} refused (${JSON.stringify(refusedBy)}), ${failures.length} broke the model`);
const byStep: Record<string, number> = {};
for (const f of failures) byStep[f.step] = (byStep[f.step] ?? 0) + 1;
console.log("broken by:", JSON.stringify(byStep));
if (process.env.BREAKIT_WHY)
  for (const [k, n] of Object.entries(refusedWhy).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${n}× ${k}`);
if (failures.length) process.exit(1);
