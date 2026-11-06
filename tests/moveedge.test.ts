// Run: npx tsx tests/moveedge.test.ts — a user's part (tests/fixtures/moveedge.json):
// the bottom edge of a face with a notch cut into it (an L-shaped face, a fillet
// along its top) moved out. Tilting a face with inward corners used to move only
// its convex part, so the fillet couldn't be put back and the move was refused.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { readFileSync } from "node:fs";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";

setOC(await (opencascade as unknown as () => Promise<any>)());
const fs = JSON.parse(readFileSync(new URL("./fixtures/moveedge.json", import.meta.url), "utf8"));
const BODY = "extrude-mw57bjyk-sfwi";
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const r0: any = await regenerate(fs.slice(0, -1));
const v0 = Math.abs(measureVolume(debugBodies().get(BODY)!));
const r: any = await regenerate(fs);
const s = debugBodies().get(BODY)!;
check("Move Edge 01 rebuilds", !r0.errors.length && !r.errors.length, r.errors.map((e: any) => e.message).join("; "));
const notes = (r.notes ?? []).map((n: any) => n.message).join("; ");
check("…a clean solid, nothing repaired, no fillet given up", isHealthy(healthOf(s)) && !/Repaired|doesn't fit/.test(notes), notes);
const rounds = s.faces.filter((f) => f.geomType === "CYLINDRE").length;
check("…same faces: 13, the 3 fillets kept", s.faces.length === 13 && rounds === 3, `${s.faces.length} faces, ${rounds} round`);
const bb = s.boundingBox.bounds;
check("…the edge is out at x = 37.5", Math.abs(bb[1][0] - 37.5) < 1e-6, `max x ${bb[1][0]}`);
// The face it tilted is one flat face now, none of it left standing at x = 30.
const tilted = s.faces.filter((f) => f.geomType === "PLANE" && Math.abs(f.normalAt().toTuple()[2] - 0.323) < 0.01);
const left = s.faces.filter((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[0] > 0.999 && Math.abs(f.center.toTuple()[0] - 30) < 1e-3);
check("…the face tilted as a whole (no piece left behind)", tilted.length === 1 && !left.length, `${tilted.length} tilted, ${left.length} left at x=30`);
check("…it grew (the bottom went out further than the top came in)", Math.abs(measureVolume(s)) > v0, `${v0.toFixed(1)} → ${Math.abs(measureVolume(s)).toFixed(1)}`);
process.exit(failed ? 1 : 0);
