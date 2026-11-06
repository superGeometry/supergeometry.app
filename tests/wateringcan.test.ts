// Run: npx tsx tests/wateringcan.test.ts [out.json] — a watering can made as one
// freeform: a cylinder cage with its top taken off (the opening), a spout
// pulled out of an inset face low on the front (rising past the rim, flared at
// the tip, left open), a handle on the back (an inset face arched round and
// bridged to another), all given a 2 mm wall inwards. The way it's done with the
// Freeform tool: Delete faces, Inset, Extrude face + gimbal, Bridge holes, Thickness.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { writeFileSync } from "node:fs";
import { boundaryEdges, bridgeFaces, cylinderCage, deleteFaces, extrudeFaces, insetFaces, selfCrossings, windingAgrees, type Cage } from "../src/freeform/cage";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { healthOf, isHealthy } from "../src/kernel/repair";
import type { Vec3 } from "../src/doc/types";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const D = 160, H = 200, ROWS = 5, WALL = 2;
const N = 8;

/** Centre and outward normal of a cage face. */
const faceInfo = (c: Cage, i: number) => {
  const P = c.faces[i].map((v) => c.verts[v]);
  const m = [0, 1, 2].map((k) => (P[0][k] + P[1][k] + P[2][k] + P[3][k]) / 4) as Vec3;
  const u = [0, 1, 2].map((k) => P[2][k] - P[0][k]);
  const w = [0, 1, 2].map((k) => P[3][k] - P[1][k]);
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const l = Math.hypot(...n) || 1;
  return { m, n: n.map((x) => x / l) as Vec3 };
};
/** The face whose outward normal is closest to `dir` among those whose centre is near height z. */
const faceAt = (c: Cage, dir: Vec3, z: number): number => {
  let best = -1, score = -Infinity;
  c.faces.forEach((_, i) => {
    const { m, n } = faceInfo(c, i);
    const s = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] - Math.abs(m[2] - z) / 20;
    if (s > score) (score = s), (best = i);
  });
  return best;
};
const ringOf = (c: Cage, f: number) => c.faces[f];
const centreOf = (c: Cage, vs: number[]) => [0, 1, 2].map((k) => vs.reduce((s, v) => s + c.verts[v][k], 0) / vs.length) as Vec3;
/** Turn points about an axis along y through `o` by `a` radians (in the xz plane, +a from +x towards +z). */
const turnY = (p: Vec3, o: Vec3, a: number): Vec3 => {
  const dx = p[0] - o[0], dz = p[2] - o[2];
  return [o[0] + dx * Math.cos(a) - dz * Math.sin(a), p[1], o[2] + dx * Math.sin(a) + dz * Math.cos(a)];
};
const setVerts = (c: Cage, vs: number[], f: (p: Vec3) => Vec3): Cage => {
  const verts = c.verts.map((p) => [...p] as Vec3);
  for (const v of vs) verts[v] = f(c.verts[v]);
  return { verts, faces: c.faces };
};

// 1. The body: a cylinder (8 around, 5 rows), turned so a face looks straight
//    front (+x) and back (−x); slightly barrel-shaped, narrower at the top.
let cage = cylinderCage(D, H, ROWS);
{
  const turn = -Math.PI / N;
  const widen = [1, 1.05, 1.06, 1.03, 0.96, 0.88];
  cage = {
    faces: cage.faces,
    verts: cage.verts.map(([x, y, z]) => {
      const k = Math.round((z / H) * ROWS);
      const s = widen[Math.max(0, Math.min(ROWS, k))];
      return [(x * Math.cos(turn) - y * Math.sin(turn)) * s, (x * Math.sin(turn) + y * Math.cos(turn)) * s, z] as Vec3;
    }),
  };
}
// 2. The opening: delete the top cap (the faces looking up at the top).
{
  const top = cage.faces.map((_, i) => i).filter((i) => faceInfo(cage, i).n[2] > 0.9 && faceInfo(cage, i).m[2] > H - 1);
  check("top cap found (4 faces)", top.length === 4, `${top.length}`);
  cage = deleteFaces(cage, top);
}
// 3. The spout: inset the front face of row 2 (z 40–80), then pull the inner
//    face out and up six times — turned 45° up at first, then a little more each time,
//    a little narrower — and flare the last one (the rose). Its end stays open.
{
  const f = faceAt(cage, [1, 0, 0], 60);
  const ins = insetFaces(cage, [f], 0.45)!;
  cage = ins.cage;
  let end = ins.faces[0];
  const steps = [
    { go: 36, tilt: 45, scale: 0.9 },
    { go: 36, tilt: 8, scale: 0.88 },
    { go: 36, tilt: 6, scale: 0.88 },
    { go: 36, tilt: 4, scale: 0.9 },
    { go: 32, tilt: 2, scale: 0.95 },
    { go: 12, tilt: 0, scale: 1.7 },
  ];
  let dir = 0; // degrees up from +x
  for (const s of steps) {
    const ex = extrudeFaces(cage, [end], 1)!;
    cage = ex.cage;
    end = ex.faces[0];
    const ring = ringOf(cage, end);
    const c0 = centreOf(cage, [...ring]);
    dir += s.tilt;
    const a = (dir * Math.PI) / 180;
    // Back to where the ring was (extruding moved it 1), then along the spout.
    const n = faceInfo(cage, end).n;
    const base: Vec3 = [c0[0] - n[0], c0[1] - n[1], c0[2] - n[2]];
    const to: Vec3 = [base[0] + Math.cos(a) * s.go, base[1], base[2] + Math.sin(a) * s.go];
    cage = setVerts(cage, [...ring], (p) => {
      // Turn the ring by this step's tilt (about its own centre), shrink it, move it on.
      const q = turnY(p, c0, (s.tilt * Math.PI) / 180);
      return [to[0] + (q[0] - c0[0]) * s.scale, to[1] + (q[1] - c0[1]) * s.scale, to[2] + (q[2] - c0[2]) * s.scale];
    });
  }
  const tip = centreOf(cage, [...ringOf(cage, end)]);
  check("spout tip rises above the rim (water stays in when full)", tip[2] > H + 10, `tip at x ${tip[0].toFixed(0)}, z ${tip[2].toFixed(0)}`);
  cage = deleteFaces(cage, [end]);
}
// 4. The handle: inset the back faces of rows 4 and 2; the upper one is pulled
//    round in five 30° steps about a point between them; then its end face
//    and the lower face are bridged.
{
  const up = faceAt(cage, [-1, 0, 0], 140);
  const lo = faceAt(cage, [-1, 0, 0], 60);
  const ins = insetFaces(cage, [up, lo], 0.5)!;
  cage = ins.cage;
  const [fu, fl] = ins.faces.map((f) => f).sort((a, b) => faceInfo(cage, b).m[2] - faceInfo(cage, a).m[2]);
  const cu = faceInfo(cage, fu).m, cl = faceInfo(cage, fl).m;
  const pivot: Vec3 = [(cu[0] + cl[0]) / 2, 0, (cu[2] + cl[2]) / 2];
  const lower = [...ringOf(cage, fl)];
  // Each ring placed from the first one (in order round the face): turned k·30°
  // about the pivot, swung out a little — a D-shaped grip.
  const first = [...ringOf(cage, fu)].map((v) => [...cage.verts[v]] as Vec3);
  let end = fu;
  for (let k = 1; k <= 5; k++) {
    const ex = extrudeFaces(cage, [end], 1)!;
    cage = ex.cage;
    end = ex.faces[0];
    const ring = [...ringOf(cage, end)];
    const a = (k * 30 * Math.PI) / 180;
    const out = 1 + 0.45 * Math.sin(a);
    const at = first.map((p) => {
      const r = turnY(p, pivot, a);
      return [pivot[0] + (r[0] - pivot[0]) * out, r[1], r[2]] as Vec3;
    });
    const verts = cage.verts.map((p) => [...p] as Vec3);
    ring.forEach((v, i) => (verts[v] = at[i]));
    cage = { verts, faces: cage.faces };
  }
  // The arm's end face and the lower inset face, bridged into one tube (Bridge faces).
  const lowFace = cage.faces.findIndex((f) => lower.every((v) => f.includes(v)));
  const br = bridgeFaces(cage, end, lowFace);
  check("handle bridged (Bridge faces), faces wound consistently", !!br && windingAgrees(br));
  if (br) cage = br;
}
const crossings = selfCrossings(cage);
check("the smooth shape doesn't pass through itself", !crossings.length, crossings.length ? `${crossings.length} crossings, first at ${crossings[0].map((x) => x.toFixed(0))}` : `${cage.faces.length} cage faces`);

const feats: any[] = [{ id: "can", name: "Watering can", type: "freeform", cage, surface: true, thickness: WALL, thickSide: "down" }];
const t0 = Date.now();
const r: any = await regenerate(feats);
const ms = Date.now() - t0;
check("it builds", !r.errors.length, r.errors.map((e: any) => `${e.feature}: ${e.message}`).join("; "));
const s = debugBodies().get("can");
const vol = s ? Math.abs(measureVolume(s)) : 0;
check("one clean solid", !!s && r.bodies.length === 1 && isHealthy(healthOf(s)), `${ms} ms, ${s?.faces.length} faces`);
if (s) {
  const bb = s.boundingBox.bounds;
  const size = [0, 1, 2].map((k) => bb[1][k] - bb[0][k]);
  check("about 160 wide, the spout and handle beyond, rising above 200", size[1] > 150 && size[1] < 180 && size[0] > 300 && size[2] > H + 10, size.map((x) => x.toFixed(0)).join(" × "));
  // A 2 mm wall over roughly the whole surface (body ~0.13 m², spout, handle): well under a solid can's volume.
  const solidCan = Math.PI * (D / 2) ** 2 * H;
  check("hollow: plastic ~2 mm thick, not a solid lump", vol > 100_000 && vol < solidCan * 0.2, `${(vol / 1000).toFixed(0)} cm³ of plastic (a solid can would be ${(solidCan / 1000).toFixed(0)})`);
}
// The same can built through the Freeform tool on a phone-sized screen
// (tests/fixtures/wateringcan-hand.json): Cylinder; Select all → Turn Z 22.5°,
// Scale 4 × 4 × 5; two edge loops; the top ring narrowed and the cap deleted;
// the front face inset and extruded six times (Turn / Scale / Move typed in
// the card); its tip deleted; the back faces inset, the upper one pulled round
// in five steps, then Bridge faces; Thickness 2 down.
{
  const { readFileSync } = await import("node:fs");
  const hand = JSON.parse(readFileSync(new URL("./fixtures/wateringcan-hand.json", import.meta.url), "utf8"));
  check("by hand: the cage doesn't pass through itself", !selfCrossings(hand[0].cage).length);
  const rh: any = await regenerate(hand);
  check("by hand: it builds", !rh.errors.length, rh.errors.map((e: any) => `${e.feature}: ${e.message}`).join("; "));
  const hs = debugBodies().get(hand[0].id);
  check("by hand: one clean solid", !!hs && rh.bodies.length === 1 && isHealthy(healthOf(hs)), `${hs?.faces.length} faces`);
  if (hs) {
    const bb = hs.boundingBox.bounds;
    const size = [0, 1, 2].map((k) => bb[1][k] - bb[0][k]);
    const hv = Math.abs(measureVolume(hs));
    check("by hand: hollow, about the same size as by code", hv > 100_000 && hv < Math.PI * (D / 2) ** 2 * H * 0.2 && size[2] > H + 10, `${size.map((x) => x.toFixed(0)).join(" × ")}, ${(hv / 1000).toFixed(0)} cm³ (by code ${(vol / 1000).toFixed(0)})`);
  }
}

// The same can the way a beginner can make it, with no values worked out
// (tests/fixtures/wateringcan-beginner.json), 34 actions on a phone-sized
// screen: Cylinder with Diameter 160, Height 200, Rows slider 4; the four top
// faces → Delete faces; the front face → Inset (slider), Extrude face with the
// Length / Bend / Taper / Steps sliders, again short and widening for the
// rose, Delete face; the two back faces → Inset (slider) → Bridge faces (the
// handle arches out by itself); Thickness 2, Down, Done.
{
  const { readFileSync } = await import("node:fs");
  const easy = JSON.parse(readFileSync(new URL("./fixtures/wateringcan-beginner.json", import.meta.url), "utf8"));
  check("no numbers: the cage doesn't pass through itself", !selfCrossings(easy[0].cage).length);
  const re: any = await regenerate(easy);
  check("no numbers: it builds", !re.errors.length, re.errors.map((e: any) => `${e.feature}: ${e.message}`).join("; "));
  const es = debugBodies().get(easy[0].id);
  check("no numbers: one clean solid", !!es && re.bodies.length === 1 && isHealthy(healthOf(es)), `${es?.faces.length} faces`);
  if (es) {
    const bb = es.boundingBox.bounds;
    const size = [0, 1, 2].map((k) => bb[1][k] - bb[0][k]);
    const ev = Math.abs(measureVolume(es));
    check("no numbers: hollow, about the same size as by code", ev > 100_000 && ev < Math.PI * (D / 2) ** 2 * H * 0.2 && size[2] > H + 10, `${size.map((x) => x.toFixed(0)).join(" × ")}, ${(ev / 1000).toFixed(0)} cm³ (by code ${(vol / 1000).toFixed(0)})`);
  }
  // The spout's tip clears the rim (water stays in when the can is full).
  // (The tip's opening: the open edges away from the can's own rim.)
  const tip = [...new Set(boundaryEdges(easy[0].cage).flat())].map((i) => easy[0].cage.verts[i]).filter((v: number[]) => v[0] > 100);
  check("no numbers: the spout's tip is above the rim", tip.length > 0 && tip.every((v: number[]) => v[2] > H), `tip from z ${Math.min(...tip.map((v: number[]) => v[2])).toFixed(0)}`);
}

if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ format: "super", version: 2, name: "Watering can", features: feats, variables: [], views: [], units: "mm", hidden: [], pins: [], names: { can: "Watering can" }, colors: { can: "#3f8f5a" } }));
process.exit(failed ? 1 : 0);
