// Run: npx tsx tests/savedcache.test.ts
// A step opened from History, a value changed, then Cancel: the project as
// saved comes back from what was already built, not from a rebuild of every
// step after the one that was open (seconds on a phone with threads in it).
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { debugBodies, regenerate } from "../src/kernel/engine";
import type { Feature } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());

const saved: Feature[] = [
  { id: "sk", name: "Sketch 01", type: "sketch", plane: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] }, entities: [{ id: "r", kind: "rect", center: [0, 0], w: 40, h: 30, rotation: 0 }], constraints: [] },
  { id: "ex", name: "Extrude 01", type: "extrude", source: { kind: "profile", sketch: "sk", regions: [{ c: [0, 0], a: 1200 }] }, distance: 20, mode: "new" },
  { id: "sh", name: "Shell 01", type: "shell", body: "ex", faces: [{ body: "ex", center: [0, 0, 20], normal: [0, 0, 1], area: 1200 }], thickness: 2 },
] as Feature[];

let failed = 0;
const check = (name: string, ok: boolean) => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name);
};

const r0 = await regenerate(saved, true);
check("the saved project builds", !r0.errors.length);
const built = debugBodies().get("ex");
// A preview of the extrude at another height: every step from it on is rebuilt.
const preview = saved.map((f) => (f.id === "ex" ? { ...f, distance: 30 } : f)) as Feature[];
await regenerate(preview);
check("the preview is a different body", debugBodies().get("ex") !== built);
// Cancel: the saved project again - the very same body, not a rebuilt one.
await regenerate(saved, true);
check("Cancel brings back what was built, without a rebuild", debugBodies().get("ex") === built);

process.exit(failed ? 1 : 0);
