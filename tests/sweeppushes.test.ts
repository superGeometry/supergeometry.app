// Run: npx tsx tests/sweeppushes.test.ts - a user's S-curve tube whose ends
// were pushed in again and again (Offset Face on a sweep's end, 19 times;
// tests/fixtures/sweeppushes.json). Pushes on the bend failed: the end's plane
// cuts an S-shaped path in more than one place and only the first was tried,
// and the cutting disc was far wider than the tube (on a tight bend it folded
// over itself, or bit into the tube's next turn: "break into pieces").
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
const doc = JSON.parse(readFileSync(new URL("./fixtures/sweeppushes.json", import.meta.url), "utf8"));
const BODY = "sweep-mw6p7ni3-sy2n";
const A = Math.PI * 2.5 * 2.5;
const name = (id: string) => doc.features.find((f: any) => f.id === id)?.name;
const tube = () => {
  const s = debugBodies().get(BODY)!;
  const ends = s.faces.filter((f) => f.geomType === "PLANE");
  return { s, length: Math.abs(measureVolume(s)) / A, round: ends.length === 2 && ends.every((f) => Math.abs(measureArea(f) - A) < A * 2e-3), ends: ends.map((f) => measureArea(f).toFixed(2)).join(", ") };
};

// As the user saw it: the pushes that failed then (11, 12, 18, 20) left out.
{
  const skip = new Set(["Offset Face 11", "Offset Face 12", "Offset Face 18", "Offset Face 20"]);
  const r: any = await regenerate(doc.features.filter((f: any) => !skip.has(f.name)));
  const t = tube();
  check("as the user built it: every push builds", !r.errors.length, r.errors.map((e: any) => `${name(e.featureId)}: ${e.message}`).join("; "));
  check("…one clean tube, both ends round", isHealthy(healthOf(t.s)) && t.round, `${t.length.toFixed(2)} long; ends ${t.ends}`);
}

// Everything: 11 and 12 build now; by 18 the tube is shorter than the push (an honest error).
{
  const t0 = performance.now();
  const r: any = await regenerate(doc.features);
  const ms = performance.now() - t0;
  const failedNames = r.errors.map((e: any) => name(e.featureId));
  check("all on: Offset Face 11 and 12 build (they're on the bend)", !failedNames.includes("Offset Face 11") && !failedNames.includes("Offset Face 12"), failedNames.join(", "));
  check("…no kernel failures, only pushes past what's left", r.errors.every((e: any) => /remove/.test(e.message)), r.errors.map((e: any) => `${name(e.featureId)}: ${e.message}`).join("; "));
  check("…19 pushes rebuild in reasonable time", ms < 12000, `${Math.round(ms)} ms`);
  const upto = doc.features.slice(0, doc.features.findIndex((f: any) => f.name === "Offset Face 17") + 1);
  await regenerate(upto);
  const t = tube();
  check("…up to 17 the tube is 3 mm long (18 pushes 6.4)", t.length < 6.4 && t.round, `${t.length.toFixed(2)}; ends ${t.ends}`);
}

console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
