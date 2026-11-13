// The console's handle on the app: `sg` - read what's there and work the tools
// without tapping at pixels. For checking the app by hand or by script (the
// browser's console, or a test driving the page). Type sg.help() to list it.
//
//   sg.state()                      the project, tool, hint, panel, selection, errors, bodies
//   sg.select(sg.sel.body("Box"))   pick something (as a tap would)
//   sg.actions()                    what the picked thing offers (left column, bottom bar)
//   sg.run("Project as Sketch")     run one (by id or label, also in sub-menus)
//   sg.panel()                      the open tool's window: slots, values, choices
//   sg.set("XY")  sg.set("Height", 2)  sg.set("Sink in", true)
//   sg.pick(sg.sel.face("Box", 3))  give the waiting slot a face / edge / plane…
//   sg.done()   sg.cancel()   await sg.idle()   await sg.health()
import type { App } from "./app";
import type { ToolItem, PanelItem } from "./ui/ui";
import type { Feature } from "./doc/types";
import type { Sel } from "./tools/tool";
import type { PickHit } from "./view/viewport";
import type { ProjectDoc } from "./doc/types";
import { parseProject } from "./doc/store";
import { newProjectId } from "./doc/library";

// (The app's insides it reads: kept out of the classes' public faces on purpose.)
interface Insides {
  tool: { id: string; editingId?: string; activeSketch?: string; slots?: { label: string; accept(h: PickHit): boolean; multi?: boolean }[]; active?: number; advance?(): void; render?(): void; update?(): void };
  regenerate(): Promise<void>;
  undo(): void;
  redo(): void;
  switchProject(doc: ProjectDoc, id: string): Promise<void>;
}
interface UIInsides {
  toolItems: ToolItem[];
  bottomItems: ToolItem[];
  panelSpec: { title: string; items?: PanelItem[]; fields?: { label: string; value: number; onInput(v: number): void }[]; actions?: ToolItem[]; onDone?(): void; onCancel?(): void } | null;
  hintText: string | null;
  recentToasts?: string[];
}

interface Listed {
  id: string;
  label: string;
  /** Where it sits: "Sketch › Rectangle". */
  path: string;
  disabled?: boolean;
  why?: string;
  item: ToolItem;
}

function flatten(items: ToolItem[], path: string[] = []): Listed[] {
  // (Separators have no label.)
  return items.filter((it) => it.label).flatMap((it) => [
    { id: it.id, label: it.label, path: [...path, it.label].join(" › "), ...(it.disabled ? { disabled: true, why: it.why } : {}), item: it },
    ...flatten(it.children ?? [], [...path, it.label]),
  ]);
}
const plain = (l: Listed[]) => l.map(({ item: _, ...rest }) => rest);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function installDebug(app: App): void {
  const inside = app as unknown as Insides;
  const ui = app.ui as unknown as UIInsides;
  const features = () => app.store.doc.features;
  /** A step or body by id or name. */
  const featureOf = (key: string): Feature | undefined => features().find((f) => f.id === key) ?? features().find((f) => same(f.name, key));
  const bodyId = (key: string): string => {
    const list = app.view.bodyList;
    const names = app.store.doc.names ?? {};
    return list.find((b) => b.id === key)?.id ?? list.find((b) => same(names[b.id] ?? b.name, key))?.id ?? key;
  };

  const panelItems = (): PanelItem[] => {
    const spec = ui.panelSpec;
    if (!spec) return [];
    const fields: PanelItem[] = (spec.fields ?? []).map((f) => ({ type: "number", label: f.label, value: f.value, onInput: f.onInput }));
    return [...fields, ...(spec.items ?? [])];
  };

  const shown = (): ToolItem[] => [...ui.toolItems, ...ui.bottomItems, ...(ui.panelSpec?.actions ?? [])];

  const sg = {
    app,

    /** What's there now, in one look. */
    state() {
      const r = app.result;
      const byId = new Map(features().map((f) => [f.id, f.name]));
      return {
        project: app.store.doc.name,
        tool: inside.tool.id,
        editing: inside.tool.editingId ?? inside.tool.activeSketch ?? null,
        hint: ui.hintText,
        panel: ui.panelSpec?.title ?? null,
        selection: app.selection,
        steps: features().length,
        errors: (r?.errors ?? []).map((e) => `${byId.get(e.featureId) ?? e.featureId}: ${e.message}`),
        notes: (r?.notes ?? []).map((e) => `${byId.get(e.featureId) ?? e.featureId}: ${e.message}`),
        toasts: ui.recentToasts?.slice(-5) ?? [],
        bodies: sg.bodies(),
      };
    },

    /** The steps in History: id, name, type, switched off, its error. */
    steps() {
      const errs = new Map((app.result?.errors ?? []).map((e) => [e.featureId, e.message]));
      return features().map((f, i) => ({ i: i + 1, id: f.id, name: f.name, type: f.type, ...(f.suppressed ? { off: true } : {}), ...(errs.has(f.id) ? { error: errs.get(f.id) } : {}) }));
    },

    /** A step as stored (by id or name). */
    step: (key: string) => featureOf(key),

    /** The bodies shown: id, name, how many faces and edges, hidden. */
    bodies() {
      const names = app.store.doc.names ?? {};
      const hidden = new Set(app.store.doc.hidden);
      return app.view.bodyList.map((b) => ({ id: b.id, name: names[b.id] ?? b.name, faces: b.faces.length, edges: b.edges.length, ...(hidden.has(b.id) ? { hidden: true } : {}) }));
    },

    /** Each body measured on the solid: valid, closed, solids, faces, volume, box. */
    health: () => app.kernel.health(features()),

    /** The main tools (the left column with nothing picked, with their sub-menus). */
    tools: () => plain(flatten(app.mainTools())),

    /** What's offered now: the left column (what the picked thing offers), the bottom bar, the open window's buttons. */
    actions: () => plain(flatten(shown())),

    /** Run a tool or action by id or label (what's offered now first, then the main tools). */
    run(key: string): string {
      const all = [...flatten(shown()), ...flatten(app.mainTools())];
      const hit = all.find((x) => x.id === key) ?? all.find((x) => same(x.label, key)) ?? all.find((x) => same(x.path, key));
      if (!hit) return `No "${key}" here. sg.actions() / sg.tools() list what there is.`;
      if (hit.disabled) return `"${hit.label}" is off: ${hit.why ?? "(no reason given)"}`;
      if (!hit.item.run) return `"${hit.label}" opens a menu: ${(hit.item.children ?? []).map((c) => c.label).join(", ")}`;
      hit.item.run();
      return `ran ${hit.path}`;
    },

    /** The tool wheel (More → Tool wheel): where its groups and fanned-out tools are on the page, to point and tap at. */
    wheel: () => app.wheel.describe(),

    /** Every tool the wheel offers now, by where it is ("Tools › Fillet"): the same as sg.actions(), arranged its way. */
    wheelTools: () => app.wheel.tools(),
    settingsWheel: () => app.settingsWheel.describe(),

    /** Pick things, as taps would (sg.sel builds them). */
    select(...sel: Sel[]) {
      app.setSelection(sel);
      return app.selection;
    },

    /** Things to pick, by name or id. */
    sel: {
      body: (body: string): Sel => ({ kind: "body", body: bodyId(body) }),
      face: (body: string, face: number): Sel => ({ kind: "face", body: bodyId(body), face }),
      edge: (body: string, edge: number): Sel => ({ kind: "edge", body: bodyId(body), edge }),
      vertex: (body: string, vertex: number): Sel => ({ kind: "vertex", body: bodyId(body), vertex }),
      /** A sketch's closed shape (regions counted as the sketch finds them). */
      profile: (sketch: string, region = 0): Sel => ({ kind: "profile", sketch: featureOf(sketch)?.id ?? sketch, region }),
      curve: (sketch: string, entity: string): Sel => ({ kind: "curve", sketch: featureOf(sketch)?.id ?? sketch, entity }),
      plane: (id: string): Sel => ({ kind: "plane", id: featureOf(id)?.id ?? id }),
      axis: (id: string): Sel => ({ kind: "axis", id: featureOf(id)?.id ?? id }),
      origin: (): Sel => ({ kind: "origin" }),
    },

    /** A body's faces: index, type, centre, normal, area (to find the one to pick). */
    faces(body: string) {
      return (app.view.body(bodyId(body))?.faces ?? []).map((f, i) => ({ i, type: f.type, center: f.center, normal: f.normal, area: +f.area.toFixed(3), ...(f.round ? { round: f.round } : {}) }));
    },

    /** A body's edges: index, type, ends. */
    edges(body: string) {
      return (app.view.body(bodyId(body))?.edges ?? []).map((e, i) => ({ i, type: e.type, start: e.start, mid: e.mid, end: e.end, length: +e.length.toFixed(3) }));
    },

    /** The open tool's window: title, rows (slots, numbers, choices, toggles), buttons. */
    panel() {
      const spec = ui.panelSpec;
      if (!spec) return null;
      return {
        title: spec.title,
        rows: panelItems().map((it) => {
          switch (it.type) {
            case "number":
            case "slider":
            case "toggle":
              return { type: it.type, label: it.label, value: it.value };
            case "slot":
              return { type: it.type, label: it.label, value: it.value, ...(it.active ? { waiting: true } : {}), filled: it.filled };
            case "choice":
              return { type: it.type, label: it.label ?? "", value: it.value, options: it.options.map((o) => o.label) };
            case "button":
              return { type: it.type, label: it.label };
            case "chips":
              return { type: it.type, label: it.label ?? "", chips: it.chips.map((c) => c.label + (c.on ? " (on)" : "")) };
            default:
              return { type: (it as { type: string }).type };
          }
        }),
        buttons: (spec.actions ?? []).map((a) => a.label),
      };
    },

    /**
     * Set a row of the open window by its label: a number, a toggle, a choice
     * (or just a choice's option: sg.set("XY")), a slot to fill next, a button.
     */
    set(label: string, value?: number | boolean | string): string {
      const items = panelItems();
      const row = items.find((it) => "label" in it && it.label && same(it.label, label));
      if (row) {
        switch (row.type) {
          case "number":
          case "slider":
            row.onInput(Number(value));
            return `${row.label} = ${value}`;
          case "toggle":
            row.onChange(value === undefined ? !row.value : !!value);
            return `${row.label} ${value === undefined ? !row.value : !!value ? "on" : "off"}`;
          case "choice": {
            const o = row.options.find((x) => x.id === value || same(x.label, String(value)));
            if (!o) return `${row.label}: no "${value}" (${row.options.map((x) => x.label).join(", ")})`;
            row.onChange(o.id);
            return `${row.label} = ${o.label}`;
          }
          case "slot":
            row.onClick();
            return `${row.label}: waiting for a pick`;
          case "button":
            row.onClick();
            return `pressed ${row.label}`;
        }
      }
      // An option of a choice with no label (the X / Y / Z, XY / XZ / YZ by a slot), or a chip.
      for (const it of items) {
        if (it.type === "choice") {
          const o = it.options.find((x) => same(x.label, label));
          if (o) {
            it.onChange(o.id);
            return `chose ${o.label}`;
          }
        }
        if (it.type === "chips") {
          const c = it.chips.find((x) => same(x.label, label));
          if (c) {
            c.onClick();
            return `tapped ${c.label}`;
          }
        }
      }
      const btn = ui.panelSpec?.actions?.find((a) => same(a.label, label) || a.id === label);
      if (btn?.run) {
        btn.run();
        return `pressed ${btn.label}`;
      }
      return `No "${label}" in the window. sg.panel() lists its rows.`;
    },

    /** Give the open tool's waiting slot a pick (a face, edge, profile, plane…), as a tap on it would. */
    pick(sel: Sel, point?: [number, number, number]): string {
      const t = inside.tool;
      const slot = t.slots?.[t.active ?? -1];
      if (!slot) return "No slot waiting (sg.set(<slot label>) makes one wait).";
      let at = point;
      if (!at && (sel.kind === "face" || sel.kind === "edge")) {
        const b = app.view.body(sel.body);
        at = sel.kind === "face" ? b?.faces[sel.face]?.center : b?.edges[sel.edge]?.mid;
      }
      const hit = { ...sel, point: at ?? [0, 0, 0] } as PickHit;
      if (!slot.accept(hit)) return `${slot.label} doesn't take that.`;
      t.advance?.();
      t.render?.();
      t.update?.();
      return `${slot.label}: picked`;
    },

    /** Done / Cancel in the open tool's window. */
    done(): string {
      const spec = ui.panelSpec;
      if (!spec?.onDone) return "No window with Done open.";
      spec.onDone();
      return `done: ${spec.title}`;
    },
    cancel(): string {
      const spec = ui.panelSpec;
      if (spec?.onCancel) spec.onCancel();
      else app.setTool(null);
      return "cancelled";
    },

    undo: () => inside.undo(),
    redo: () => inside.redo(),

    /** Wait until the geometry engine has nothing left to do (and the page has drawn it). */
    async idle(timeoutMs = 30000): Promise<boolean> {
      const k = app.kernel as unknown as { pending: Map<number, unknown>; regenRunning: boolean };
      const t0 = performance.now();
      let quiet = 0;
      while (performance.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
        quiet = k.pending.size || k.regenRunning ? 0 : quiet + 1;
        if (quiet >= 3) return true;
      }
      return false;
    },

    /** The project as saved (JSON). */
    save: () => JSON.stringify(app.store.doc),

    /**
     * Open a project (its JSON, as text or object) as a new one in the
     * library, as File → Open does; the one open now is kept. Resolves once
     * it is built.
     */
    async load(project: string | object, name?: string): Promise<string> {
      const doc = parseProject(typeof project === "string" ? project : JSON.stringify(project));
      if (name) doc.name = name;
      await inside.switchProject(doc, newProjectId());
      await sg.idle();
      return doc.name;
    },

    /** What there is, with one line each. */
    help(): number {
      const lines: string[] = Object.entries(sg as Record<string, unknown>)
        .filter(([k]) => k !== "app")
        .map(([k, v]) => (typeof v === "function" ? `sg.${k}(${((v as () => void).toString().match(/^[^(]*\(([^)]*)\)/)?.[1] ?? "").replace(/\s+/g, " ")})` : `sg.${k}`));
      console.log(lines.join("\n"));
      return lines.length;
    },
  };

  (window as unknown as { sg: typeof sg }).sg = sg;
}
