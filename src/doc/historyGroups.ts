// History groups (runs of steps under one name): changing them (pure logic).

import type { HistoryGroup } from "./types";

/**
 * Groups with these steps taken out. Groups are runs of steps next to each
 * other: one the steps were in the middle of splits around them (the second
 * part keeps the name, numbered), so they show in their own place.
 */
export function ungroupedSteps(order: readonly string[], groups: readonly HistoryGroup[], out: ReadonlySet<string>): HistoryGroup[] {
  const next: HistoryGroup[] = [];
  const stamp = Date.now().toString(36);
  for (const g of groups) {
    if (!g.steps.some((id) => out.has(id))) {
      next.push(g);
      continue;
    }
    const idx = g.steps.map((id) => order.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b);
    const runs: string[][] = [];
    let run: string[] = [];
    for (const i of idx) {
      if (out.has(order[i])) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(order[i]);
    }
    if (run.length) runs.push(run);
    runs.forEach((steps, k) => next.push(k ? { id: `${g.id}-${stamp}-${k}`, name: `${g.name} (${k + 1})`, steps } : { ...g, steps }));
  }
  return next;
}
