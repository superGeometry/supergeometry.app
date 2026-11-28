// Quick actions: a short row of round buttons right beside whatever is
// picked - on the model a face, an edge, a point, a body, a sketch's shape, a
// plane, an axis, an image; in a sketch its curves and points - with the two
// tools most likely next for it (a flat face: Sketch, Move; a round one:
// Thread, Fillet; an edge: Chamfer, Move; a body: Fillet, Mirror; a sketch's
// curves: Construction, Delete). The most likely of all already has its handle
// on it (a face's arrow, an edge's fillet dot, a gimbal): these are the next
// ones. On the model the row ends with Delete and More, which opens every
// other tool the pick has (Shell among them); they are the very tools the line
// at the bottom offers for the pick (the same ToolItems).
//
// Settings > Quick buttons switches them off: none are made then, for a pick or
// for a tool's own choices (Extrude's Add and Cut beside the face), and the
// line at the bottom is where the tools are.

import type { Vec3 } from "../doc/types";
import { settings } from "../settings";
import { icons } from "../ui/icons";
import type { ToolItem } from "../ui/ui";
import type { Viewport } from "../view/viewport";
import { clampToFree } from "./annotate";

/** By kind of pick: the tools to offer, best first (the first two there are and can be used now). */
export const QUICK = {
  // (A freeform surface's face: Edit Freeform first - shaping it again is what it is for.)
  face: ["editFreeform", "thread", "sketch", "move", "fillet", "thicken"],
  // (Fillet first, before Chamfer. Its dot is on the edge to drag as well.)
  edge: ["fillet", "chamfer", "move", "thread", "connect"],
  vertex: ["moveVertex", "delete"],
  // (A body that is, or began as, a freeform: Edit Freeform first.)
  body: ["editFreeform", "fillet", "mirror"],
  profile: ["extrude", "revolve"],
  plane: ["sketch", "plane"],
  axis: ["delete"],
  image: ["scale", "delete"],
  // In a sketch: its picked curves and points (the sketch tool's own buttons).
  // (Constraints between them: its button opens the ones that fit what is picked.)
  curve: ["construction", "constraints", "delete"],
  point: ["delete"],
} satisfies Record<string, string[]>;

export type QuickKind = keyof typeof QUICK;

export interface QuickPlace {
  /** The pick's outward normal (a face's, a shape's): they go the other way from its arrow on the screen. */
  facing?: Vec3;
  /** Turned away (seen from behind): hidden (a body's face; a sketch's shape is seen from both sides). */
  hideBack?: boolean;
  /** How far from the point (px): further for a gimbal round it. */
  gap?: number;
}

/**
 * Under More: the tools used most, each always in the same place whatever is picked - in this order, most used
 * first. One the pick has no use for is left out and those after it move up; what is not named here comes after,
 * as the pick lists it. (Each line: the ids one name goes by on a face, an edge, a body.)
 */
const MORE_ORDER: string[][] = [
  ["extrude"],
  ["offsetFace", "offsetEdge", "offsetFromEdge", "offset"],
  ["plane", "planePerp", "planeEdge"],
  ["split"],
  ["shell"],
  ["scale"],
  ["fillet"],
  ["chamfer"],
  ["loft"],
  ["revolve"],
  ["sweep"],
  ["faceFreeform", "editFreeform", "freeform"],
  ["pattern"],
  ["mirror"],
  ["rotate"],
  ["translate"],
  ["replace"],
  ["projs", "proje"],
  ["hole"],
  ["lip"],
  ["boss"],
  ["snap"],
];
const MORE_PLACE = new Map(MORE_ORDER.flatMap((ids, i) => ids.map((id) => [id, i] as const)));

/** At most this many: only the important things (the rest is under More at the row's end). */
const MOST = 2;
/**
 * An edge has three: Fillet, Chamfer and Move/Rotate Edge. Move/Rotate Edge is for one straight edge: with a curved one, or several, it is not
 * offered and the row is the two.
 */
const MOST_OF: Partial<Record<QuickKind, number>> = { edge: 3, curve: 3 };

export class QuickActions {
  private readonly box = document.createElement("div");
  private readonly hook = () => this.layout();
  /** The window's size changed (a phone's buttons are smaller): the names are fitted to the buttons as they are now. */
  private readonly refit = () => (fitNames(this.box), this.layout());
  /**
   * A colour just tapped: the pick's buttons are made again (the one in use lit), and they come back with the
   * same choices open, so another colour is one tap more.
   */
  private static reopen: { id: string; until: number } | null = null;

  /** `items`: what the pick offers (the wheel's own list, its kinds' items too); `at`: the point it is shown beside. */
  static show(view: Viewport, kind: QuickKind, items: ToolItem[], at: Vec3, place: QuickPlace = {}, all = false): QuickActions | null {
    // (Switched off in Settings: none, whatever is picked.)
    if (!settings.value.quickButtons) return null;
    const byId = new Map<string, ToolItem>();
    const walk = (its: ToolItem[]) => {
      for (const it of its) {
        if (!byId.has(it.id)) byId.set(it.id, it);
        if (it.children?.length) walk(it.children);
      }
    };
    walk(items);
    const picked = (QUICK[kind] as readonly string[]).map((id) => byId.get(id)).filter((it): it is ToolItem => !!it && !it.disabled && (!!it.run || !!it.children?.length) && (!it.beta || it.id === "editFreeform")).slice(0, MOST_OF[kind] ?? MOST);
    if (!all) return picked.length ? new QuickActions(view, picked, at, place) : null;
    // On the model: Delete beside them, and a last button that opens every other tool the pick has. The few most likely
    // stay the row; the rest come up under it only when asked for, so nothing is crowded.
    const usable = (it: ToolItem | undefined): it is ToolItem => !!it && !it.disabled && !!it.run;
    const del = [byId.get("delete"), byId.get("deleteBody")].find(usable);
    const row = del && !picked.includes(del) ? [...picked, del] : picked;
    const rest: ToolItem[] = [];
    // (Beside a corner, not Move/Rotate Body: it moves the whole body, which is not what a corner was picked for.
    // It is still under Transform on the line.)
    // (A body's own Color and Fade are there too: each a button opening its choices in the same card.)
    const choosers = kind === "body" ? ["color", "opacity"] : [];
    const skip = new Set(["deselect", "reveal", "material", "wholePattern", ...["color", "opacity"].filter((id) => !choosers.includes(id)), ...(kind === "vertex" ? ["move"] : [])]);
    const gather = (its: ToolItem[]) => {
      for (const it of its) {
        if (!it.label || it.id.startsWith("---") || skip.has(it.id) || it.disabled) continue;
        // (A tool that starts by itself is one button, its kinds a tap further inside it; a bare group is its tools.)
        if (it.run || (choosers.includes(it.id) && it.children?.length)) {
          if (!row.includes(it) && !rest.some((r) => r.label === it.label) && !row.some((r) => r.label === it.label)) rest.push(it);
        } else if (it.children?.length) gather(it.children);
      }
    };
    gather(items);
    // The two patterns are one button, Pattern: its two kinds open in the card (one place in the list, not two).
    const pats = rest.filter((r) => r.id === "patl" || r.id === "patc");
    if (pats.length === 2) {
      rest.splice(rest.indexOf(pats[0]), 1, { id: "pattern", label: "Pattern", icon: pats[0].icon, children: pats });
      rest.splice(rest.indexOf(pats[1]), 1);
    }
    // Each in its place (a sort that keeps the order of those it has no place for).
    const rankOf = (it: ToolItem) => MORE_PLACE.get(it.id === "patl" || it.id === "patc" ? "pattern" : it.id) ?? MORE_ORDER.length;
    const sorted = rest.map((it, i) => ({ it, i })).sort((a, b) => rankOf(a.it) - rankOf(b.it) || a.i - b.i).map((x) => x.it);
    rest.splice(0, rest.length, ...sorted);
    // (Just one more: it is a button of the row, before Delete - a More that opens a single button is a tap wasted.)
    if (rest.length === 1 && rest[0].run) {
      const one = rest.pop()!;
      row.splice(del && row.includes(del) ? row.indexOf(del) : row.length, 0, one);
    }
    return row.length || rest.length ? new QuickActions(view, row, at, place, rest) : null;
  }

  /** These very buttons (a tool's own choices, the one in use lit), beside `at`. None with Quick buttons switched off. */
  static of(view: Viewport, items: ToolItem[], at: Vec3, place: QuickPlace = {}): QuickActions | null {
    return settings.value.quickButtons ? new QuickActions(view, items, at, place) : null;
  }

  private readonly facing?: Vec3;
  private more?: HTMLButtonElement;

  private constructor(
    private readonly view: Viewport,
    items: ToolItem[],
    private readonly at: Vec3,
    private readonly place: QuickPlace,
    rest: ToolItem[] = [],
  ) {
    this.facing = place.facing;
    this.box.className = "quick-actions";
    const button = (it: ToolItem) => {
      const b = document.createElement("button");
      b.className = `quick-action${it.active ? " on" : ""}${it.id === "delete" || it.id === "deleteBody" ? " danger" : ""}`;
      b.title = it.shortcut ? `${it.label} (${it.shortcut})` : it.label;
      b.setAttribute("aria-label", it.label);
      const icon = icons[it.icon as keyof typeof icons];
      const glyph = document.createElement("i");
      glyph.className = "quick-glyph";
      glyph.textContent = it.glyph ?? "";
      b.innerHTML = `${it.swatch ? `<i class="quick-swatch" style="background:${it.swatch}"></i>` : it.glyph ? "" : (icon ?? "")}<span>${shortName(it.label)}</span>`;
      if (it.glyph) b.prepend(glyph);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        // (A button of the row with choices: tapped again, they close.)
        if (!it.run && it.children?.length) {
          if (chosen === it.id && !grid.hidden && !rest.some((r) => r.id === it.id)) return close();
          choose(it);
        } else it.run?.();
      });
      return b;
    };
    let chosen: string | null = null;
    const close = () => {
      chosen = null;
      if (rest.length) grid.replaceChildren(...rest.map(button));
      else grid.hidden = true;
      fitNames(grid);
      this.layout();
    };
    // A button with choices (Color, Fade): the card shows them in place of the rest, a Back first.
    const choose = (it: ToolItem) => {
      const back = document.createElement("button");
      back.className = "quick-action";
      back.title = "Back to the other tools";
      back.setAttribute("aria-label", "Back");
      back.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg><span>Back</span>`;
      back.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
      });
      const kids = (it.children ?? []).filter((k) => k.label && !k.id.startsWith("---")).map((k): ToolItem => ({
        ...k,
        run: k.run && (() => {
          // (For the moment it takes the buttons to be made again - at once, when the choice took. A choice that
          // made nothing - refused, or a list opened - left it standing a second and a half, and the next thing
          // picked came up with these choices open by themselves.)
          QuickActions.reopen = { id: it.id, until: performance.now() + 300 };
          k.run!();
        }),
      }));
      chosen = it.id;
      grid.hidden = false;
      grid.replaceChildren(back, ...kids.map(button));
      fitNames(grid);
      this.layout();
    };
    const grid = document.createElement("div");
    grid.className = "quick-rest";
    grid.hidden = true;
    const row = document.createElement("div");
    row.className = "quick-row";
    for (const it of items) row.append(button(it));
    this.box.append(row);
    if (rest.length) {
      // The rest of what the pick offers: under the row, opened by its last button (and shut by it again).
      const more = document.createElement("button");
      more.className = "quick-action quick-more";
      more.title = "Every other tool for this";
      more.setAttribute("aria-label", "More tools for this");
      more.innerHTML = `${icons.more ?? ""}<span>More</span>`;
      for (const it of rest) grid.append(button(it));
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        // (Opened again after a list of choices was up in it - Color's: the tools again, as More says.)
        if (grid.hidden && chosen) {
          chosen = null;
          grid.replaceChildren(...rest.map(button));
        }
        grid.hidden = !grid.hidden;
        more.classList.toggle("on", !grid.hidden);
        fitNames(grid);
        this.layout();
      });
      row.append(more);
      this.more = more;
    }
    this.box.append(grid);
    const again = QuickActions.reopen;
    QuickActions.reopen = null;
    const was = again && performance.now() < again.until ? [...items, ...rest].find((r) => r.id === again.id && !r.run && r.children?.length) : undefined;
    if (was) {
      if (rest.includes(was)) this.more?.classList.add("on");
      choose(was);
    }
    // A press on them is theirs: never a pick on the model behind, nor the view turning.
    this.box.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(this.box);
    view.frameHooks.add(this.hook);
    window.addEventListener("resize", this.refit);
    fitNames(this.box);
    this.layout();
  }

  /** Below the point, clear of the handle on it (moved on with the view: only when the view is drawn again). */
  private layout(): void {
    const s = this.view.toScreen(this.at);
    let shown = !!s;
    if (s && this.facing && this.place.hideBack !== false) {
      const v = this.view.cam.viewDir();
      if (v.x * this.facing[0] + v.y * this.facing[1] + v.z * this.facing[2] > 0.05) shown = false;
    }
    this.box.hidden = !shown;
    if (!s || !shown) return;
    const hw = this.box.offsetWidth / 2;
    const hh = this.box.offsetHeight / 2;
    // (A face's arrow points out along its normal: they go the other way on the screen, not under it.)
    const first: [number, number][] = [];
    if (this.facing) {
      const k = this.view.cam.worldPerPixel(this.view.height) * 60;
      const tip = this.view.toScreen([this.at[0] + this.facing[0] * k, this.at[1] + this.facing[1] * k, this.at[2] + this.facing[2] * k]);
      const dx = tip ? s[0] - tip[0] : 0;
      const dy = tip ? s[1] - tip[1] : 0;
      const l = Math.hypot(dx, dy);
      if (l > 8) {
        const d = Math.abs((dx / l) * hw) + Math.abs((dy / l) * hh) + (this.place.gap ?? 34);
        first.push([s[0] + (dx / l) * d, s[1] + (dy / l) * d]);
      }
    }
    const g = this.place.gap ?? 46;
    const spots: [number, number][] = [
      ...first,
      [s[0], s[1] + g + hh],
      [s[0], s[1] - g - hh],
      [s[0] - g - hw, s[1]],
      [s[0] + g + hw, s[1]],
    ].map((p) => clampToFree(p as [number, number], hw, hh));
    // (Nor under a value box on the model - an extrude's distance, beside its arrow.)
    const boxes = [...document.querySelectorAll<HTMLElement>(".dim-widget")].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0);
    const clear = ([x, y]: [number, number]) => !boxes.some((r) => x + hw + 6 > r.left && x - hw - 6 < r.right && y + hh + 6 > r.top && y - hh - 6 < r.bottom);
    const [x, y] = spots.find(clear) ?? spots[0];
    this.box.style.transform = `translate(${Math.round(x - hw)}px, ${Math.round(y - hh)}px)`;
  }

  dispose(): void {
    this.view.frameHooks.delete(this.hook);
    window.removeEventListener("resize", this.refit);
    this.box.remove();
  }
}

/** A short name under the icon ("Move/Rotate Edge" → "Move"). */
function shortName(label: string): string {
  const s = label.replace(/…$/, "").split(/[/ –]/)[0];
  return s.length > 14 ? s.slice(0, 13) + "…" : s;
}

/**
 * A name wider than its round button (Perpendicular; Construction on a phone, where the buttons are smaller) is
 * fitted to it: it ran out over the button's edge. Narrowed first, by up to 15% - its letters stay as tall, which
 * reads better than a smaller size - and made smaller only for what is still too wide. Only when they are drawn
 * again, not every frame.
 */
function fitNames(root: HTMLElement): void {
  for (const s of Array.from(root.querySelectorAll<HTMLElement>(".quick-action > span"))) {
    s.style.fontSize = "";
    s.style.transform = "";
    s.classList.remove("narrowed");
    const room = (s.parentElement?.clientWidth ?? 0) - 6;
    const wide = s.scrollWidth;
    if (room <= 0 || wide <= room) continue;
    const k = Math.max(0.85, room / wide);
    const size = Math.max(7, Math.floor((9 * room * 10) / (wide * k)) / 10);
    if (size < 9) s.style.fontSize = `${size}px`;
    s.classList.add("narrowed");
    s.style.transform = `scaleX(${k.toFixed(3)})`;
  }
}
