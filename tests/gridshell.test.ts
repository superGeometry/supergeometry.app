// Run: npx tsx tests/gridshell.test.ts
// Shell held to volumes worked out by hand: a block, a cylinder and an L with
// different faces open - and parts where two faces are closer together than
// two walls, so their walls run into each other (a hole near a side, a pocket
// near a side, two holes side by side). Those came out wrong without a word:
// a pocket's walls left out (the pocket a window into the hollow), the tube
// round a hole cut a wall and a half short of the opening, a broken shell
// "repaired" a sixth too light. Where it can't be built, it says so.
import { block, circle, cylinder, done, extrude, poly, rect, sketch, XY } from "./kit";
import { build, faceRef, near, say } from "./grid";
import type { Feature, SketchEntity } from "../src/doc/types";

const shell = (body: string, faces: any[], thickness: number): Feature => ({ id: "S", name: "S", type: "shell", body, faces, thickness }) as Feature;
const told = (g: Awaited<ReturnType<typeof build>>, body = "A") => `${g.errors.join(" | ")} ${g.unsound} got ${g.vol[body]?.toFixed(2)}`;
const sound = (g: Awaited<ReturnType<typeof build>>) => !g.errors.length && !g.unsound.length;

// ------------------------------------------------------------ plain shapes
{
  const W = 40, D = 30, H = 20;
  const A = block("A", W, D, H);
  for (const t of [0.5, 2, 5, 9, 9.99]) {
    await build(A);
    const top = faceRef("A", (n) => n[2] > 0.99);
    const side = faceRef("A", (n) => n[0] > 0.99);
    const bottom = faceRef("A", (n) => n[2] < -0.99);
    const cases: [string, any[], number][] = [
      ["its top open", [top], W * D * H - (W - 2 * t) * (D - 2 * t) * (H - t)],
      ["top and bottom open (a tube)", [top, bottom], W * D * H - (W - 2 * t) * (D - 2 * t) * H],
      ["its top and a side open", [top, side], W * D * H - (W - t) * (D - 2 * t) * (H - t)],
      ["sealed (no face open)", [], W * D * H - (W - 2 * t) * (D - 2 * t) * (H - 2 * t)],
    ];
    for (const [name, faces, v] of cases) {
      const g = await build([...A, shell("A", faces, t)]);
      say(sound(g) && near(g.vol.A, v, 2e-4), `a block shelled ${t}, ${name}`, `${told(g)} want ${v.toFixed(2)}`);
    }
  }
  const C = cylinder("C", 15, 30);
  for (const t of [1, 5, 14]) {
    await build(C);
    const g = await build([...C, shell("C", [faceRef("C", (n) => n[2] > 0.99)], t)]);
    const v = Math.PI * (225 * 30 - (15 - t) ** 2 * (30 - t));
    say(sound(g) && near(g.vol.C, v, 3e-4), `a cylinder shelled ${t}, its top open`, `${told(g, "C")} want ${v.toFixed(2)}`);
  }
  // An L: the wall is as thick at its inside corner as anywhere (the hollow's corner there is round).
  const sL = sketch("s", XY(), [poly("p", [[0, 0], [40, 0], [40, 15], [15, 15], [15, 40], [0, 40]])]);
  const L = [sL, extrude("L", sL, 10)];
  for (const t of [1, 3, 7]) {
    await build(L);
    const g = await build([...L, shell("L", [faceRef("L", (n) => n[2] > 0.99)], t)]);
    const v = 9750 - ((15 - 2 * t) * (65 - 2 * t) + (1 - Math.PI / 4) * t * t) * (10 - t);
    say(sound(g) && near(g.vol.L, v, 3e-4), `an L shelled ${t}, its top open`, `${told(g, "L")} want ${v.toFixed(2)}`);
  }
}

// ------------------------------------------------------------ faces closer together than two walls
const A = block("A", 40, 30, 20);
const cutIn = (id: string, es: SketchEntity[], depth: number): Feature[] => {
  const s = sketch(`${id}-s`, XY(20), es);
  return [s, extrude(id, s, -depth, "cut", { target: "A" })];
};
/** The part of a disc of radius r beyond a line d from its middle. */
const beyond = (r: number, d: number) => (d >= r ? 0 : r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d));
/** What two discs of radius r, d apart, cover together. */
const twoDiscs = (r: number, d: number) => 2 * Math.PI * r * r - (d >= 2 * r ? 0 : 2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d));
/** The hollow of the block with its bottom open, before what stands in it is taken out: its footprint and height. */
const room = (t: number) => ({ area: (40 - 2 * t) * (30 - 2 * t), high: 20 - t });

const close: [string, Feature[], (t: number) => number | null][] = [
  // name, the steps, the shell's volume with the bottom open (null: see below)
  [
    "a hole 2 mm from a side",
    cutIn("h", [circle("c", 5, 15, 3)], 20),
    // The tube round the hole (3 + t), less what of it is in the side wall already.
    (t) => 24000 - 9 * Math.PI * 20 - (room(t).area - (Math.PI * (3 + t) ** 2 - beyond(3 + t, 5 - t))) * room(t).high,
  ],
  [
    "a hole half a millimetre from a side",
    cutIn("h", [circle("c", 3.5, 15, 3)], 20),
    (t) => 24000 - 9 * Math.PI * 20 - (room(t).area - (Math.PI * (3 + t) ** 2 - beyond(3 + t, 3.5 - t))) * room(t).high,
  ],
  [
    "two holes 1.5 mm apart",
    [...cutIn("h", [circle("c", 15, 15, 3)], 20), ...cutIn("g", [circle("c", 22.5, 15, 3)], 20)],
    (t) => 24000 - 18 * Math.PI * 20 - (room(t).area - twoDiscs(3 + t, 7.5)) * room(t).high,
  ],
  [
    "a pocket 2 mm from a side",
    cutIn("h", [rect("r", 2, 10, 12, 20)], 8),
    // Half a millimetre: clear of the side, its edges round (worked out by hand). Thicker, its wall
    // and the side's are one, and the hollow's inside corners come out sharp: the pocket grown by t,
    // as far as it is inside the room - x from t to 12 + t, y from 10 - t to 20 + t, z from 12 - t up.
    (t) => (t < 1 ? 2109.5 : 23200 - (room(t).area * room(t).high - 12 * (10 + 2 * t) * 8)),
  ],
  [
    "a hole 1.7 mm from a pocket",
    [...cutIn("h", [circle("c", 20, 15, 5)], 20), ...cutIn("p", [rect("r", 26, 5, 36, 12)], 8)],
    (t) => (t === 0.5 ? 2368.2 : null),
  ],
];
for (const [name, extra, right] of close) {
  const fs = [...A, ...extra];
  for (const t of [0.5, 1, 1.5, 2.5]) {
    const pre = await build(fs);
    const bottom = faceRef("A", (n) => n[2] < -0.99);
    const g = await build([...fs, shell("A", [bottom], t)]);
    const want = right(t);
    if (name.startsWith("a hole 1.7")) {
      if (t === 0.5) say(sound(g) && near(g.vol.A, 2368.2, 2e-4), `${name}, shelled ${t}: walls round both`, `${told(g)} want 2368.2`);
      else if (t < 2.5) say(/Walls this thick don't fit/.test(g.errors.join()) && near(g.vol.A, pre.vol.A, 1e-9), `${name}, shelled ${t}: can't be built - said so, the part left as it was`, told(g));
      // (At 2.5 the two walls are one lump, and it builds again.)
      else say(sound(g) && near(g.vol.A, 10804, 2e-3), `${name}, shelled ${t}: their walls one lump`, `${told(g)} want about 10804`);
      continue;
    }
    say(sound(g) && want !== null && near(g.vol.A, want, 3e-4), `${name}, shelled ${t}`, `${told(g)} want ${want?.toFixed(1)}`);
  }
}

// A pocket cut into the face that is opened hangs from that face alone: said, not left loose.
{
  const fs = [...A, ...cutIn("h", [rect("r", 15, 10, 25, 20)], 8)];
  await build(fs);
  const top = faceRef("A", (n, c) => n[2] > 0.99 && Math.abs(c[2] - 20) < 1e-6);
  const g = await build([...fs, shell("A", [top], 1)]);
  say(/standing loose/.test(g.errors.join()), "a block with a pocket in its top, the top opened: refused (the pocket would come loose)", told(g));
  await build(fs);
  const bottom = faceRef("A", (n) => n[2] < -0.99);
  const b = await build([...fs, shell("A", [bottom], 1)]);
  // The room, less the pocket grown by 1 with its edges round (as the one-step shell makes them).
  const grown = (12 * 12 - (4 - Math.PI)) * 7 + (100 + 40 * (Math.PI / 4) + (2 / 3) * Math.PI);
  say(sound(b) && near(b.vol.A, 23200 - (38 * 28 * 19 - grown), 3e-4), "...its bottom opened instead: walls round the pocket too", `${told(b)} want ${(23200 - (38 * 28 * 19 - grown)).toFixed(1)}`);
}
done();
