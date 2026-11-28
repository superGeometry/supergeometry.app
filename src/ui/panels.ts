// The right column: what is used while modelling - Fit, Display - and one
// Settings button for what is set now and then (units & grid, snapping, the
// number pad, appearance), each row there showing how it is set now. Views
// are on the view cube; Screenshot is in Print / Share; History has its own
// button at the top. (Their lists are still kept by id: other parts of the
// app open them.)

import type { SavedView, Units, Vec3 } from "../doc/types";
import type { DocStore } from "../doc/store";
import { MOUSE_PRESETS, mousePreset, settings, type Settings } from "../settings";
import { fmtLen as lenText, UNIT_LABEL, units } from "../units";
import type { Viewport } from "../view/viewport";
import type { UI } from "./ui";
import { el } from "./ui";
import { textField } from "./textField";

export function setupRightColumn(ui: UI, view: Viewport, store: DocStore, onUnits: (u: Units) => void, isolatedNames: () => string[] = () => []): void {
  ui.addRight("fit", "fit", "Zoom to fit (F)", () => view.fitAll(), () => "Fit");
  // (Kept by id, with no button in the column: opened from Settings.)
  const stash = { host: el("div", ""), className: "right-btn" };
  const lists: Record<string, (host: HTMLElement) => void> = {};
  const kept = (id: string, open: (host: HTMLElement) => void) => (lists[id] = open);
  ui.addRight("snap", "magnet", "Snapping", kept("snap", (host) => {
    const s = settings.value;
    host.append(heading("Snap to"));
    const snapRow = (key: keyof Settings["snap"], label: string) =>
      toggleRow(label, s.snap[key], (v) => settings.set("snap", { ...settings.value.snap, [key]: v }));
    host.append(snapRow("grid", "Grid"), snapRow("guideLines", "Sketch guide lines"), snapRow("guidePoints", "Sketch guide points"), snapRow("points3d", "3D guide points"), snapRow("distantEdges", "Distant edges"));
    host.append(heading("Show"));
    host.append(toggleRow("Guide points", s.showGuidePoints, (v) => settings.set("showGuidePoints", v)), toggleRow("Snapping hints", s.showSnapHints, (v) => settings.set("showSnapHints", v)));
    host.append(el("div", "pop-note", "Hold Shift while drawing to place a point without snapping."));
  }), undefined, stash);

  ui.addRight(
    "units",
    "ruler",
    "Units & grid",
    kept("units", (host) => {
      host.append(heading("Units"));
      const list: [Units, string][] = [
        ["mm", "Millimeter"],
        ["cm", "Centimeter"],
        ["m", "Meter"],
        ["in", "Inch"],
        ["ft", "Foot"],
      ];
      for (const [u, label] of list) host.append(choiceRow(label, units() === u, () => (onUnits(u), ui.refreshPopover())));
      host.append(heading("Grid"));
      const s = settings.value;
      // Switched on, it keeps the squares as they are right now, at this zoom.
      const lockRow = toggleRow(s.gridLocked ? `Lock grid size (${fmtStep(s.gridStep)})` : `Lock grid size (now ${fmtStep(view.grid.step)})`, s.gridLocked, (v) => {
        if (v) settings.set("gridStep", +view.grid.step.toPrecision(6));
        settings.set("gridLocked", v);
        ui.refreshPopover();
      });
      host.append(lockRow);
      const stepRow = el("label", "pop-row");
      stepRow.append(el("span", "", "Locked size (mm)"));
      const input = textField("pop-input");
      input.inputMode = "decimal";
      // (Not locked: the squares' size right now - what locking would keep.)
      input.value = String(s.gridLocked ? s.gridStep : +view.grid.step.toPrecision(6));
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (v > 0) settings.set("gridStep", v);
      });
      stepRow.append(input);
      host.append(stepRow);
      const gridNote = el("div", "pop-note", s.gridLocked ? "The squares stay this size at any zoom, and a sketch snaps to them. Switch the lock off for a grid that follows the zoom." : `The grid follows the zoom (now ${fmtStep(view.grid.step)} a square), and a sketch snaps to the squares shown. Lock it to keep them as they are now.`);
      host.append(gridNote);
      // Not locked, the size follows the zoom while this is open: the row, the box and the note say the squares'
      // size as it is now. They said the size it was when the window opened.
      if (!s.gridLocked) {
        let shown = view.grid.step;
        const follow = () => {
          // (Closed, or drawn again: this one is done.)
          if (!lockRow.isConnected || lockRow.closest("[hidden]")) return void view.frameHooks.delete(follow);
          const now = view.grid.step;
          if (now === shown) return;
          shown = now;
          (lockRow.firstElementChild as HTMLElement).textContent = `Lock grid size (now ${fmtStep(now)})`;
          if (document.activeElement !== input) input.value = String(+now.toPrecision(6));
          gridNote.textContent = `The grid follows the zoom (now ${fmtStep(now)} a square), and a sketch snaps to the squares shown. Lock it to keep them as they are now.`;
        };
        view.frameHooks.add(follow);
      }
      host.append(heading("Degree format"));
      host.append(choiceRow("Decimal (27.15°)", s.degrees === "decimal", () => (settings.set("degrees", "decimal"), ui.refreshPopover())), choiceRow("Fractional (27° 15′)", s.degrees === "fractional", () => (settings.set("degrees", "fractional"), ui.refreshPopover())));
    }),
    () => UNIT_LABEL[units()],
    stash,
  );

  // Appearance (camera, projection, grid, axes): back in the right-hand column.
  ui.addRight("appearance", "eye", "Appearance", kept("appearance", (host) => {
    const s = settings.value;
    host.append(
      heading("Appearance"),
      toggleRow("Animate camera", s.animateCamera, (v) => settings.set("animateCamera", v)),
      toggleRow("Orthographic", s.ortho, (v) => settings.set("ortho", v)),
      toggleRow("Show grid", s.showGrid, (v) => settings.set("showGrid", v)),
      toggleRow("Show world axes", s.showAxes, (v) => settings.set("showAxes", v)),
    );
  }), undefined, stash);

  // Mouse: which drags turn, move and zoom the view - the app's own way or another CAD program's, for hands used
  // to it. Only where there is a mouse.
  lists.mouse = (host) => {
    const s = settings.value;
    const now = mousePreset(s.mouse);
    host.append(heading("Mouse like in"));
    for (const m of MOUSE_PRESETS) {
      const row = choiceRow(m.apps, now.id === m.id, () => (settings.set("mouse", m.id), ui.refreshPopover()));
      row.title = m.text;
      host.append(row);
    }
    host.append(el("div", "pop-note", now.text));
    host.append(heading("Wheel"));
    host.append(toggleRow("Forward zooms out", s.wheelReverse, (v) => settings.set("wheelReverse", v)));
    host.append(el("div", "pop-note", "Always: the wheel zooms where the pointer is, a plain right drag turns the view, Alt + left drag turns it too (a trackpad), and a left drag on empty space draws a box to select with."));
  };

  // Views (standard and saved): the button at the view cube's bottom right.
  const cube = document.getElementById("viewcube")!;
  ui.addRight("views", "views", "Views (tap to open / close)", (host) => {
    const body = el("div", "");
    host.append(heading("Views"), body);
    const showViews = () => {
      body.innerHTML = "";
      // Picking a view closes the list (it would only cover the view picked).
      const go = (label: string, n: Vec3, x?: Vec3) => choiceRow(label, false, () => (view.cam.flatUntilTurned(), view.cam.lookAlong(n, x), ui.closePopover()));
      body.append(choiceRow("⌂ Default view", false, () => (view.cam.iso(), view.fitAll(), ui.closePopover())));
      body.append(go("Top", [0, 0, 1]), go("Bottom", [0, 0, -1]), go("Front", [0, -1, 0]), go("Back", [0, 1, 0], [-1, 0, 0]), go("Right", [1, 0, 0], [0, 1, 0]), go("Left", [-1, 0, 0], [0, -1, 0]));
      body.append(heading("Saved views"));
      for (const v of store.doc.views) {
        const row = choiceRow(v.name, false, () => (view.cam.restore(v), ui.closePopover()));
        const del = el("button", "icon-btn small", "✕");
        del.title = "Delete view";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          store.commit((d) => (d.views = d.views.filter((x) => x.name !== v.name)));
          showViews();
        });
        row.append(del);
        body.append(row);
      }
      body.append(
        choiceRow("＋ Save current view", false, () => {
          const name = `View ${store.doc.views.length + 1}`;
          const sv: SavedView = view.cam.savedView(name);
          store.commit((d) => d.views.push(sv));
          showViews();
        }),
      );
    };
    showViews();
  }, undefined, { host: cube, className: "vc-roll bottom right vc-views" });

  ui.addRight("display", "display", "Display modes", (host) => {
    const s = settings.value;
    host.append(heading("Shaders"));
    for (const [id, label] of [["wireframe", "Wireframe"], ["xray", "X-Ray"], ["shaded", "Shaded"]] as const) {
      host.append(choiceRow(label, s.shader === id, () => (settings.set("shader", id), ui.refreshPopover())));
    }
    host.append(heading("Options"));
    host.append(toggleRow("Show edges", s.showEdges, (v) => settings.set("showEdges", v)), toggleRow("Show hidden edges", s.showHiddenEdges, (v) => settings.set("showHiddenEdges", v)));
    // Surface analysis: how smoothly faces meet (zebra), how much they bend (curvature).
    host.append(heading("Analysis"));
    for (const [id, label] of [["none", "Off"], ["zebra", "Zebra stripes"], ["curvature", "Curvature map"]] as const) {
      // (Off is lit while the overhang check, below the line, is the one that is on: none of these three is.)
      host.append(choiceRow(label, s.analysis === id, () => (settings.set("analysis", id), ui.refreshPopover())));
    }
    if (s.analysis === "zebra") {
      host.append(
        toggleRow("Horizontal stripes", s.zebraDirection === "horizontal", (v) => settings.set("zebraDirection", v ? "horizontal" : "vertical")),
        sliderRow("Stripes", 4, 48, 1, s.zebraStripes, (v) => settings.set("zebraStripes", v), (v) => String(v)),
      );
    }
    if (s.analysis === "curvature") {
      // On a log scale: a 0.5 mm fillet and a 5 m roof both get a useful setting.
      host.append(
        sliderRow("Full colour at radius", Math.log10(0.5), Math.log10(5000), 0.01, Math.log10(s.curvatureRadius), (v) => settings.set("curvatureRadius", +(10 ** v).toPrecision(2)), (v) => fmtLen(10 ** v)),
        el("div", "pop-note", "Red: domed. Green: flat. Blue: hollow."),
      );
    }
    // For printing, apart from the surface analyses: which faces lean out too far to print without support.
    host.append(el("div", "pop-rule"));
    host.append(toggleRow("Overhang check", s.analysis === "overhang", (v) => (settings.set("analysis", v ? "overhang" : "none"), ui.refreshPopover())));
    if (s.analysis === "overhang") {
      host.append(
        sliderRow("Prints without support up to", 20, 80, 1, s.overhangAngle, (v) => settings.set("overhangAngle", v), (v) => `${v}°`),
        el("div", "pop-note", "Red: needs support, printed upright as it stands. Yellow: close to the limit. The angle is how far a face leans out from upright."),
      );
    }
  }, () => (settings.value.analysis === "zebra" ? "Zebra" : settings.value.analysis === "curvature" ? "Curv." : settings.value.analysis === "overhang" ? "Overhang" : ({ shaded: "Shaded", wireframe: "Wire", xray: "X-Ray" })[settings.value.shader]));

  ui.addRight("shot", "camera", "Screenshot", () => {
    void view.screenshot({ project: store.doc.name, isolated: isolatedNames() }).then((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${store.doc.name} ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ui.toast("Screenshot saved");
    });
  }, undefined, stash);

  // On-screen numpad: one tap on, one tap off (lit while on).
  const pad = ui.addRight("numpad", "numpad", "On-screen numpad for typing values (tap to switch on / off)", () => {
    settings.set("numpad", !settings.value.numpad);
    ui.toast(settings.value.numpad ? "On-screen numpad on" : "On-screen numpad off");
  }, () => "NumPad", stash);
  const markPad = () => pad.classList.toggle("on", settings.value.numpad);
  settings.onChange(() => (markPad(), ui.refreshRight()));
  markPad();
  ui.addRight("history", "history", "History", () => ui.toggleHistory(), undefined, stash);

  // Settings: one row for each thing set now and then, saying how it is set; a tap opens its list (and back).
  let page: "units" | "snap" | "appearance" | "mouse" | null = null;
  const gear = ui.addRight(
    "settings",
    "settings",
    "Settings",
    (host) => {
      const s = settings.value;
      if (page) {
        const back = el("button", "pop-row pop-back", "‹  Settings");
        back.addEventListener("click", () => ((page = null), ui.refreshPopover()));
        host.append(back);
        lists[page](host);
        return;
      }
      const nav = (label: string, now: string, to: NonNullable<typeof page>) => {
        const row = el("button", "pop-row pop-nav");
        row.append(el("span", "", label), el("span", "pop-value", now), el("span", "pop-chev", "›"));
        row.addEventListener("click", () => ((page = to), ui.refreshPopover()));
        return row;
      };
      const snaps = Object.values(s.snap).filter(Boolean).length;
      host.append(
        heading("Settings"),
        nav("Units & grid", `${UNIT_LABEL[units()]}${s.gridLocked ? ` · grid ${s.gridStep} mm` : ""}`, "units"),
        nav("Snapping", snaps ? `${snaps} of ${Object.keys(s.snap).length} on` : "Off", "snap"),
        nav("Appearance", `${s.ortho ? "Orthographic" : "Perspective"}${s.showGrid ? "" : " · no grid"}`, "appearance"),
      );
      if (matchMedia("(any-pointer: fine)").matches) host.append(nav("Mouse", mousePreset(s.mouse).apps.split(",")[0], "mouse"));
      // The switches last, under the rows that open a list. Quick buttons: the round buttons beside what is picked
      // (off for working from the line at the bottom alone).
      const quick = toggleRow("Quick buttons", s.quickButtons, (v) => settings.set("quickButtons", v));
      quick.title = "The round buttons beside what you pick";
      host.append(toggleRow("Number pad on screen", s.numpad, (v) => settings.set("numpad", v)), quick);
    },
    () => UNIT_LABEL[units()],
  );
  // (Opened afresh: its first page.)
  gear.addEventListener("pointerdown", () => (page = null));
  // Sketch mode only (CSS shows it under body.sketching): show/hide the constraint column.
  const cons = ui.addRight("constraints", "constraints", "Constraints (sketch)", () => settings.set("showConstraints", !settings.value.showConstraints));
  cons.classList.add("sketch-only");
  const mark = () => cons.classList.toggle("on", settings.value.showConstraints);
  settings.onChange(mark);
  mark();
  settings.onChange(() => ui.refreshRight());
}

function heading(text: string): HTMLElement {
  return el("div", "pop-heading", text);
}

function toggleRow(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = el("button", `pop-row toggle-row${value ? " on" : ""}`);
  row.append(el("span", "", label), el("span", "switch"));
  row.addEventListener("click", () => {
    const next = !row.classList.contains("on");
    row.classList.toggle("on", next);
    onChange(next);
  });
  return row;
}

/** A slider with its value beside it (set while dragging). */
function sliderRow(label: string, min: number, max: number, step: number, value: number, onChange: (v: number) => void, show: (v: number) => string): HTMLElement {
  const row = el("label", "pop-row slider-row");
  const out = el("span", "slider-value", show(value));
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    out.textContent = show(Number(input.value));
    onChange(Number(input.value));
  });
  row.append(el("span", "slider-label", label), input, out);
  return row;
}

function fmtLen(mm: number): string {
  const v = +mm.toPrecision(2);
  return v >= 1000 ? `${v / 1000} m` : `${v} mm`;
}

function choiceRow(label: string, active: boolean, run: () => void): HTMLElement {
  const row = el("button", `pop-row choice-row${active ? " active" : ""}`, label);
  row.addEventListener("click", run);
  return row;
}

function fmtStep(mm: number): string {
  // (In the unit in use: 10 mm was said as "1 cm" in a project of millimetres.)
  return lenText(mm, 4);
}
