// Run: npx tsx tests/gridbooleans.test.ts
// Union, Subtract and Intersect between a block and a tool in 22 places: through
// it, inside it, flush with its walls, standing on it, the same height beside
// it, touching a wall from inside, a corner edge lying on a wall. Each result
// held to its exact volume - V(A u B) + V(A n B) = V(A) + V(B), V(A - B) =
// V(A) - V(A n B) - and to being a sound solid.
import { block, cylinder, done, extrude, poly, sketch, XY } from "./kit";
import { build, near, say } from "./grid";
import type { Feature } from "../src/doc/types";

const A = block("A", 40, 30, 20); // 0..40, 0..30, 0..20
const VA = 40 * 30 * 20;
const prism = (id: string, pts: [number, number][], z: number, h: number): Feature[] => {
  const s = sketch(`${id}-s`, XY(z), [poly(`${id}-p`, pts)]);
  return [s, extrude(id, s, h)];
};
// name, the tool's steps, V(A n B) where it is known exactly (null: taken from the engine's own Intersect), pieces Subtract leaves
const tools: [string, Feature[], number | null, number?][] = [
  ["a box through a corner", block("B", 20, 20, 20, [30, 20, 10]), 10 * 10 * 10],
  ["a box inside", block("B", 10, 10, 10, [5, 5, 5]), 1000],
  ["a box through, top to bottom", block("B", 10, 10, 40, [15, 10, -10]), 10 * 10 * 20],
  ["a box flush with a side wall, out of the top", block("B", 10, 10, 30, [0, 10, 5]), 10 * 10 * 15],
  ["a box flush with two walls and the top", block("B", 10, 10, 10, [0, 0, 10]), 1000],
  ["a box of the same height beside it, overlapping", block("B", 40, 30, 20, [25, 10, 0]), 15 * 20 * 20],
  ["a box standing on its top", block("B", 20, 10, 10, [10, 10, 20]), 0],
  ["a box standing on its top, the same outline", block("B", 40, 30, 10, [0, 0, 20]), 0],
  ["a box against its side, flush with the top", block("B", 10, 30, 20, [40, 0, 0]), 0],
  ["a box half sunk into the top, overhanging a side", block("B", 20, 10, 10, [30, 10, 15]), 10 * 10 * 5],
  ["the same block again", block("B", 40, 30, 20, [0, 0, 0]), VA],
  ["a bigger box all round it", block("B", 60, 50, 40, [-10, -10, -10]), VA],
  ["a cylinder through the middle", cylinder("B", 5, 40, 20, 15, -10), Math.PI * 25 * 20],
  ["a cylinder touching a wall from inside", cylinder("B", 5, 40, 5, 15, -10), Math.PI * 25 * 20],
  ["a cylinder half out of a wall", cylinder("B", 5, 40, 0, 15, -10), (Math.PI * 25 * 20) / 2],
  ["a cylinder standing on the top", cylinder("B", 5, 10, 20, 15, 20), 0],
  ["a cylinder sunk 5 into the top", cylinder("B", 5, 10, 20, 15, 15), Math.PI * 25 * 5],
  ["a cylinder as tall as the block, inside", cylinder("B", 5, 20, 20, 15, 0), Math.PI * 25 * 20],
  // (Wider than the block is deep: taken away, the four corners are left.)
  ["a cylinder wider than the block is deep", cylinder("B", 20, 20, 20, 15, 0), null, 4],
  ["a triangle prism through", prism("B", [[10, 5], [30, 5], [20, 25]], -5, 30), 200 * 20],
  ["a triangle prism, one side flush with a wall", prism("B", [[0, 5], [0, 25], [15, 15]], 5, 30), 150 * 15],
  // Its corner edge lies in the block's wall: the join left that edge lying across
  // the wall, bounding nothing, and was refused as "would tear the body open".
  ["a triangle prism, a corner edge on a wall", prism("B", [[0, 15], [20, 5], [20, 25]], 5, 30), 200 * 15],
];

for (const [name, B, known, left = 1] of tools) {
  const base = [...A, ...B];
  const VB = (await build(base)).vol.B;
  const run = (op: string, pieces = 1) => build([...base, { id: "op", name: "op", type: "boolean", op, target: "A", tools: ["B"] } as Feature], { A: pieces });
  const inter = await run("intersect");
  const vi = known ?? (inter.errors.length ? 0 : (inter.vol.A ?? 0));
  if (known === 0) say(/empty/i.test(inter.errors.join()) || (inter.vol.A ?? 0) < 1e-6, `intersect: ${name} - nothing in both`, `${inter.errors.join(" | ")} ${JSON.stringify(inter.vol)}`);
  else if (known !== null) say(!inter.errors.length && !inter.unsound.length && near(inter.vol.A, known), `intersect: ${name}`, `${inter.errors.join(" | ")} ${inter.unsound} got ${inter.vol.A?.toFixed(2)} want ${known.toFixed(2)}`);
  const uni = await run("union");
  say(!uni.errors.length && !uni.unsound.length && uni.ids.length === 1 && near(uni.vol.A, VA + VB - vi), `union: ${name}`, `${uni.errors.join(" | ")} ${uni.unsound} ${uni.ids} got ${uni.vol.A?.toFixed(2)} want ${(VA + VB - vi).toFixed(2)}`);
  const subt = await run("subtract", left);
  if (near(vi, VA, 1e-9)) say(/empty/i.test(subt.errors.join()), `subtract: ${name} - nothing left, said so`, `${subt.errors.join(" | ")} ${JSON.stringify(subt.vol)}`);
  else say(!subt.errors.length && !subt.unsound.length && near(subt.vol.A, VA - vi), `subtract: ${name}`, `${subt.errors.join(" | ")} ${subt.unsound} got ${subt.vol.A?.toFixed(2)} want ${(VA - vi).toFixed(2)}`);
}
done();
