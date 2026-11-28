// The sizes a screw boss has, by its screw: the hole a screw cuts its own thread in (the tap drill's size), the
// hole a brass heat-set insert is pressed into (the usual size for its thread - an insert's maker may say another),
// and a post wide enough to leave a sound wall round either.

import type { BossFeature } from "./types";

interface BossSize {
  name: string;
  /** The screw's nominal diameter. */
  d: number;
  screw: number;
  insert: number;
}

export const BOSS_SIZES: BossSize[] = [
  { name: "M2", d: 2, screw: 1.6, insert: 3.2 },
  { name: "M2.5", d: 2.5, screw: 2.1, insert: 4 },
  { name: "M3", d: 3, screw: 2.5, insert: 4 },
  { name: "M4", d: 4, screw: 3.3, insert: 5.6 },
  { name: "M5", d: 5, screw: 4.2, insert: 6.4 },
  { name: "M6", d: 6, screw: 5, insert: 8 },
  { name: "M8", d: 8, screw: 6.8, insert: 9.6 },
];

export const bossSize = (name: string | undefined): BossSize | undefined => BOSS_SIZES.find((s) => s.name === name);

/** The hole and the post for this screw, fitted this way (the post to the half millimetre above). */
export function bossFor(size: BossSize, fit: BossFeature["fit"]): Pick<BossFeature, "size" | "hole" | "diameter"> {
  const hole = fit === "insert" ? size.insert : size.screw;
  const wall = Math.max(1.5, size.d * 0.55);
  return { size: size.name, hole, diameter: Math.ceil((hole + 2 * wall) * 2 - 1e-9) / 2 };
}
