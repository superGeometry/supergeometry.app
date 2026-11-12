// Commands by name: what a shortcut key or the search box runs. Everything
// the app offers is a ToolItem somewhere - the picked thing's tools in the
// left column, the bottom bar, the open window's buttons, the main menus -
// so a command is found by its label there, and run as a tap would run it.

import { icons } from "./icons";
import { el, type ToolItem } from "./ui";

export interface Listed {
  label: string;
  /** Where it is: "Construct › Plane › Through 3 Points". */
  path: string;
  item: ToolItem;
}

/** Every item, sub-menus included (separators have no label). */
export function flatten(items: ToolItem[], path: string[] = []): Listed[] {
  return items.filter((it) => it.label).flatMap((it) => [{ label: it.label, path: [...path, it.label].join(" › "), item: it }, ...flatten(it.children ?? [], [...path, it.label])]);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The first of `labels` that can be run now: what the picked thing offers
 * first (so E on a face is its Extrude), then the main menus.
 */
export function findAction(offered: ToolItem[], main: ToolItem[], labels: string[]): Listed | null {
  const lists = [flatten(offered), flatten(main)];
  for (const label of labels)
    for (const list of lists) {
      const hit = list.find((x) => same(x.label, label) && x.item.run && !x.item.disabled);
      if (hit) return hit;
    }
  return null;
}

/**
 * How well the typed letters fit a command, or null if they don't: every
 * letter in order, a letter at the start of a word or straight after the
 * last one counting more ("p3" finds Plane – Through 3 Points, "snu" Scale –
 * Non-uniform).
 */
export function score(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let at = -1;
  let total = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, at + 1);
    if (i < 0) return null;
    const wordStart = i === 0 || !/[a-z0-9]/.test(t[i - 1]);
    total += (wordStart ? 3 : 1) + (i === at + 1 ? 2 : 0) - Math.min(1, (i - at - 1) * 0.05);
    at = i;
  }
  // A whole word typed, or the start of the name: better still.
  if (t.startsWith(q)) total += 4;
  return total - t.length * 0.01;
}

/** The commands used last (first: the latest), remembered on this device. */
const RECENT = "sg.recentCommands";
function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function remember(path: string): void {
  try {
    localStorage.setItem(RECENT, JSON.stringify([path, ...recent().filter((p) => p !== path)].slice(0, 8)));
  } catch {
    // (No storage here: nothing remembered.)
  }
}

let openBox: HTMLElement | null = null;

/**
 * The search box (X or Ctrl+F): type part of a command's name, the list
 * narrows; ↑ ↓ pick, Enter (or a click) runs it, → completes the name, Esc
 * closes. What the picked thing offers comes first.
 */
export function openCommandSearch(offered: () => ToolItem[], main: () => ToolItem[]): void {
  if (openBox) return void openBox.querySelector("input")?.focus();
  const box = el("div", "cmd-search");
  const input = el("input", "cmd-input");
  input.type = "text";
  input.placeholder = "Search commands…";
  input.setAttribute("aria-label", "Search commands");
  input.autocomplete = "off";
  input.spellcheck = false;
  const list = el("div", "cmd-list");
  list.setAttribute("role", "listbox");
  box.append(input, list);
  document.body.append(box);
  openBox = box;

  // Each command once (the left column's copy of a main tool is the same command).
  const all = (): Listed[] => {
    const seen = new Set<string>();
    return [...flatten(offered()), ...flatten(main())].filter((x) => {
      if (!x.item.run || seen.has(x.path)) return false;
      seen.add(x.path);
      return true;
    });
  };
  let shown: Listed[] = [];
  let at = 0;

  const paint = () => {
    list.innerHTML = "";
    if (!shown.length) list.append(el("div", "cmd-empty", input.value.trim() ? "No command by that name" : "Type a command's name"));
    shown.forEach((x, i) => {
      const row = el("button", `cmd-row${i === at ? " on" : ""}${x.item.disabled ? " off" : ""}`);
      row.type = "button";
      row.setAttribute("role", "option");
      row.innerHTML = icons[x.item.icon] ?? "";
      const words = el("span", "cmd-words");
      words.append(el("span", "cmd-label", x.label));
      const where = x.path.split(" › ").slice(0, -1).join(" › ");
      if (where || x.item.disabled) words.append(el("span", "cmd-where", x.item.disabled ? (x.item.why ?? "Not now") : where));
      row.append(words);
      if (x.item.shortcut) row.append(el("kbd", "cmd-key", x.item.shortcut));
      row.addEventListener("pointerdown", (e) => e.preventDefault());
      row.addEventListener("click", () => run(i));
      list.append(row);
    });
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  };

  const filter = () => {
    const q = input.value.trim();
    const items = all();
    if (!q) {
      // Nothing typed: the ones used last, then what the picked thing offers.
      const byPath = new Map(items.map((x) => [x.path, x]));
      const last = recent().flatMap((p) => (byPath.has(p) ? [byPath.get(p)!] : []));
      const here = flatten(offered()).filter((x) => x.item.run && !last.some((l) => l.path === x.path));
      shown = [...last, ...here].slice(0, 12);
    } else {
      shown = items
        .map((x) => ({ x, s: Math.max(score(q, x.label) ?? -Infinity, (score(q, x.path) ?? -Infinity) - 2) }))
        .filter((r) => r.s > -Infinity)
        .sort((a, b) => Number(!!a.x.item.disabled) - Number(!!b.x.item.disabled) || b.s - a.s || a.x.path.length - b.x.path.length)
        .slice(0, 12)
        .map((r) => r.x);
    }
    at = Math.max(0, shown.findIndex((x) => !x.item.disabled));
    paint();
  };

  const close = () => {
    box.remove();
    openBox = null;
    document.removeEventListener("pointerdown", outside, true);
  };
  const run = (i: number) => {
    const x = shown[i];
    if (!x || x.item.disabled) return;
    close();
    remember(x.path);
    x.item.run!();
  };
  const outside = (e: PointerEvent) => {
    if (!box.contains(e.target as Node)) close();
  };

  input.addEventListener("input", filter);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") return void (e.preventDefault(), close());
    if (e.key === "Enter") return void (e.preventDefault(), run(at));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      at = (at + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
      paint();
    }
    // → at the end of the text: the highlighted command's whole name.
    if (e.key === "ArrowRight" && input.selectionStart === input.value.length && shown[at]) {
      e.preventDefault();
      input.value = shown[at].label;
      filter();
    }
  });
  document.addEventListener("pointerdown", outside, true);
  filter();
  input.focus();
}

/** The keys, as the cheat sheet lists them. */
export const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Sketch",
    [
      ["L", "Line"],
      ["A", "Arc"],
      ["C", "Circle"],
      ["R", "Rectangle"],
      ["G", "Polygon"],
      ["I", "Spline"],
      ["O", "Offset Edge"],
      ["T", "Trim"],
      ["Shift + letter", "A constraint (Shift+A Parallel, P Perpendicular, T Tangent, N Coincident, M Midpoint, C Concentric, V Horizontal/Vertical, E Equal, S Symmetry, L Lock)"],
      ["Enter", "Finish the shape"],
      ["Esc", "Step back"],
    ],
  ],
  [
    "Modeling",
    [
      ["E", "Extrude"],
      ["F", "Fillet (nothing picked: Zoom to Fit)"],
      ["H", "Shell"],
      ["M", "Move/Rotate"],
      ["N", "Translate"],
      ["P", "Project as Sketch"],
      ["S", "Scale (nothing picked: Sketch)"],
      ["V", "Revolve"],
      ["W", "Sweep"],
      ["Ctrl + U / B / I", "Union / Subtract / Intersect"],
    ],
  ],
  [
    "View",
    [
      ["Ctrl (or Alt) + 1", "Default view"],
      ["Ctrl (or Alt) + 2 … 7", "Front, Back, Top, Bottom, Right, Left"],
      ["Space", "Zoom to the face under the pointer"],
    ],
  ],
  [
    "Edit",
    [
      ["X or Ctrl + F", "Search commands"],
      ["Ctrl + Z / Ctrl + Shift + Z", "Undo / Redo"],
      ["Ctrl + S", "Save"],
      ["Delete", "Delete what's picked"],
      ["?", "This list"],
    ],
  ],
];

/** The cheat sheet (the ? key, or Shortcuts in the search). */
export function showShortcuts(): void {
  const back = el("div", "dialog-back");
  const box = el("div", "dialog shortcuts");
  const head = el("div", "library-head");
  head.append(el("div", "panel-title", "Keyboard shortcuts"));
  const closeBtn = el("button", "icon-btn library-close");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.innerHTML = icons.close;
  head.append(closeBtn);
  const body = el("div", "shortcuts-body");
  for (const [group, rows] of SHORTCUTS) {
    body.append(el("div", "shortcuts-group", group));
    for (const [key, what] of rows) {
      const row = el("div", "shortcuts-row");
      row.append(el("kbd", "cmd-key", key), el("span", "", what));
      body.append(row);
    }
  }
  box.append(head, body);
  back.append(box);
  const close = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "?") (e.preventDefault(), close());
    e.stopPropagation();
  };
  closeBtn.addEventListener("click", close);
  back.addEventListener("pointerdown", (ev) => ev.target === back && close());
  window.addEventListener("keydown", onKey, true);
  document.body.append(back);
}
