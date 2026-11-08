// Run: npx tsx tests/historygroups.test.ts - steps taken out of History groups
// stay in their place in the timeline: a group split around them.
import { ungroupedSteps } from "../src/doc/historyGroups";
import type { HistoryGroup } from "../src/doc/types";

let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};
const order = ["a", "b", "c", "d", "e", "f"];
const groups: HistoryGroup[] = [
  { id: "g1", name: "Base", steps: ["b", "c", "d", "e"] },
  { id: "g2", name: "Top", steps: ["f"] },
];
const show = (gs: HistoryGroup[]) => gs.map((g) => `${g.name}:${g.steps.join("")}`).join(" ");

const mid = ungroupedSteps(order, groups, new Set(["c"]));
check("from the middle: the group splits around it (b | c | d e)", show(mid) === "Base:b Base (2):de Top:f" && mid[0].id === "g1", show(mid));
const edge = ungroupedSteps(order, groups, new Set(["b"]));
check("from the start: the rest stays one group", show(edge) === "Base:cde Top:f", show(edge));
const all = ungroupedSteps(order, groups, new Set(["b", "c", "d", "e"]));
check("all of it: the group is gone", show(all) === "Top:f", show(all));
const two = ungroupedSteps(order, groups, new Set(["c", "e", "a"]));
check("two out, and one in no group: b | c | d | e", show(two) === "Base:b Base (2):d Top:f", show(two));
const none = ungroupedSteps(order, groups, new Set(["a"]));
check("none of them grouped: nothing changes", show(none) === show(groups));
const ids = new Set(mid.map((g) => g.id));
check("the split part gets an id of its own", ids.size === mid.length);

console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
