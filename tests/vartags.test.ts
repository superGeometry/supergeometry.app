// Run: npx tsx tests/vartags.test.ts - variable tags in the view: each sits
// where its variable acts on the model as it is now (the desk lamp built by
// hand: arms turned at their joints), with its kind (length / angle / number).
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { readFileSync } from "node:fs";
import { regenerate } from "../src/kernel/engine";
import { resolveDoc } from "../src/doc/params";
import { kindOfVariable, madeFrom, namesIn, usesOf, variableTags } from "../src/doc/varAnchors";
import type { ProjectDoc, Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const f3 = (p: Vec3 | null) => (p ? p.map((x) => x.toFixed(1)).join(", ") : "none");

check("names in a formula, not units", JSON.stringify(namesIn("2*kR + 3 mm - (p1)mm")) === '["kR","p1"]' && JSON.stringify(namesIn("mm + 4")) === '["mm"]', JSON.stringify(namesIn("2*kR + 3 mm - (p1)mm")));

const doc = JSON.parse(readFileSync(new URL("./fixtures/desklamp-hand.json", import.meta.url), "utf8")) as ProjectDoc;
resolveDoc(doc);
const r = await regenerate(doc.features as any);
const tags = variableTags(doc.variables, doc.features, r);
const tag = (n: string) => tags.find((t) => t.name === n)!;
const box = (id: string) => {
  const b = r.bodies.find((x) => x.id === id)!;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.positions.length; i += 3) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], b.positions[i + k])), (hi[k] = Math.max(hi[k], b.positions[i + k]));
  return { lo, hi };
};
const inside = (p: Vec3 | null, id: string, pad = 2) => {
  if (!p) return false;
  const { lo, hi } = box(id);
  return p.every((x, k) => x > lo[k] - pad && x < hi[k] + pad);
};
const arm1 = "extrude-mw6zldl8-77ke";
const arm2 = "extrude-mw6zp54w-vwb2";
const head = "transform-mw6zpz65-gpm1:extrude-mw6zpv4o-7q9b:0";
const base = "extrude-mw6z9bsk-dfvp";

check("arm1: on the lower arm, turned up at its joint", inside(tag("arm1").at, arm1), f3(tag("arm1").at));
check("arm2: on the upper arm, turned twice", inside(tag("arm2").at, arm2), f3(tag("arm2").at));
check("shadeL: on the shade (turned three times, and the swivel)", inside(tag("shadeL").at, head), f3(tag("shadeL").at));
check("baseH: on the base", inside(tag("baseH").at, base), f3(tag("baseH").at));
check("baseR: on the base's rim", inside(tag("baseR").at, base), f3(tag("baseR").at));
check("p1 and a1: at the lower joint (the turn's pivot), on the arm's end", inside(tag("p1").at, arm1) && inside(tag("a1").at, arm1), f3(tag("p1").at));
check("p2 and p3: at the elbow and the head's joint, on the upper arm", inside(tag("p2").at, arm2) && inside(tag("p3").at, arm2), `${f3(tag("p2").at)} / ${f3(tag("p3").at)}`);
check("every variable of the lamp has a spot", tags.every((t) => t.at), tags.filter((t) => !t.at).map((t) => t.name).join(", "));

const uses = usesOf(doc.features);
const kinds = Object.fromEntries(doc.variables.map((v) => [v.name, kindOfVariable(v.name, doc.variables, uses)]));
check("kinds: lengths, and the turns' angles (typed as plain numbers)", ["baseR", "arm1", "p1", "p3", "kR", "shadeR"].every((n) => kinds[n] === "length") && ["a1", "a2", "a3", "swivel"].every((n) => kinds[n] === "angle"), JSON.stringify(kinds));
check("kinds: not used, a formula of lengths is a length; a plain number, a number", kindOfVariable("w2", [{ name: "w", expr: "3 mm" }, { name: "w2", expr: "w * 2" }], new Map()) === "length" && kindOfVariable("n", [{ name: "n", expr: "4" }], new Map()) === "number");
check("made from: p2 = p1 + arm1", JSON.stringify(madeFrom("p2", doc.variables)) === '["p1","arm1"]');

// Turned another way: the tags follow.
const turned = structuredClone(doc);
turned.variables = turned.variables.map((v) => (v.name === "a1" ? { ...v, expr: "60" } : v.name === "swivel" ? { ...v, expr: "-40" } : v));
resolveDoc(turned);
const r2 = await regenerate(turned.features as any);
const t2 = variableTags(turned.variables, turned.features, r2);
const box2 = (id: string) => {
  const b = r2.bodies.find((x) => x.id === id)!;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.positions.length; i += 3) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], b.positions[i + k])), (hi[k] = Math.max(hi[k], b.positions[i + k]));
  return { lo, hi };
};
const in2 = (n: string, id: string) => {
  const p = t2.find((t) => t.name === n)!.at;
  const { lo, hi } = box2(id);
  return !!p && p.every((x, k) => x > lo[k] - 2 && x < hi[k] + 2);
};
check("lower arm raised, lamp swivelled: arm1, arm2 and shadeL still on their parts", in2("arm1", arm1) && in2("arm2", arm2) && in2("shadeL", head), f3(t2.find((t) => t.name === "shadeL")!.at));

console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
