// Right column popovers: snapping, units & grid, views, display modes, screenshot, history.

import type { SavedView, Units, Vec3 } from "../doc/types";
import type { DocStore } from "../doc/store";
import { settings, type Settings } from "../settings";
import { UNIT_LABEL, units } from "../units";
import type { Viewport } from "../view/viewport";
import type { UI } from "./ui";
import { el } from "./ui";

export function setupRightColumn(ui: UI, view: Viewport, store: DocStore, onUnits: (u: Units) => void): void {
  ui.addRight("fit", "fit", "Zoom to fit (F)", () => view.fitAll(), () => "Fit");
  ui.addRight("snap", "magnet", "Snapping", (host) => {
    const s = settings.value;
    host.append(heading("Snap to"));
    const snapRow = (key: keyof Settings["snap"], label: string) =>
      toggleRow(label, s.snap[key], (v) => settings.set("snap", { ...settings.value.snap, [key]: v }));
    host.append(snapRow("grid", "Grid"), snapRow("guideLines", "Sketch guide lines"), snapRow("guidePoints", "Sketch guide points"), snapRow("points3d", "3D guide points"), snapRow("distantEdges", "Distant edges"));
    host.append(heading("Show"));
    host.append(toggleRow("Guide points", s.showGuidePoints, (v) => settings.set("showGuidePoints", v)), toggleRow("Snapping hints", s.showSnapHints, (v) => settings.set("showSnapHints", v)));
    host.append(el("div", "pop-note", "Hold Shift while drawing to place a point without snapping."));
  });

  ui.addRight(
    "units",
    "ruler",
    "Units & grid",
    (host) => {
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
      host.append(toggleRow(`Lock grid size (${s.gridStep} mm)`, s.gridLocked, (v) => settings.set("gridLocked", v)));
      const stepRow = el("label", "pop-row");
      stepRow.append(el("span", "", "Locked size (mm)"));
      const input = document.createElement("input");
      input.className = "pop-input";
      input.value = String(s.gridStep);
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (v > 0) settings.set("gridStep", v);
      });
      stepRow.append(input);
      host.append(stepRow);
      host.append(el("div", "pop-note", `Tip: the grid adapts to zoom (now ${fmtStep(view.grid.step)} per square).`));
      host.append(heading("Degree format"));
      host.append(choiceRow("Decimal (27.15°)", s.degrees === "decimal", () => settings.set("degrees", "decimal")), choiceRow("Fractional (27° 15′)", s.degrees === "fractional", () => settings.set("degrees", "fractional")));
    },
    () => UNIT_LABEL[units()],
  );

  // Appearance (camera, projection, grid, axes): back in the right-hand column.
  ui.addRight("appearance", "eye", "Appearance", (host) => {
    const s = settings.value;
    host.append(
      heading("Appearance"),
      toggleRow("Animate camera", s.animateCamera, (v) => settings.set("animateCamera", v)),
      toggleRow("Orthographic", s.ortho, (v) => settings.set("ortho", v)),
      toggleRow("Show grid", s.showGrid, (v) => settings.set("showGrid", v)),
      toggleRow("Show world axes", s.showAxes, (v) => settings.set("showAxes", v)),
    );
  });

  // Views (standard and saved): the button at the view cube's bottom right.
  const cube = document.getElementById("viewcube")!;
  ui.addRight("views", "views", "Views (tap to open / close)", (host) => {
    const body = el("div", "");
    host.append(heading("Views"), body);
    const showViews = () => {
      body.innerHTML = "";
      // Picking a view closes the list (it would only cover the view picked).
      const go = (label: string, n: Vec3, x?: Vec3) => choiceRow(label, false, () => (view.cam.lookAlong(n, x), ui.closePopover()));
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
  }, () => ({ shaded: "Shaded", wireframe: "Wire", xray: "X-Ray" })[settings.value.shader]);

  ui.addRight("shot", "camera", "Screenshot", () => {
    void view.screenshot().then((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${store.doc.name} ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      ui.toast("Screenshot saved");
    });
  });

  // On-screen numpad: one tap on, one tap off (lit while on).
  const pad = ui.addRight("numpad", "numpad", "On-screen numpad for typing values (tap to switch on / off)", () => {
    settings.set("numpad", !settings.value.numpad);
    ui.toast(settings.value.numpad ? "On-screen numpad on" : "On-screen numpad off");
  }, () => "NumPad");
  const markPad = () => pad.classList.toggle("on", settings.value.numpad);
  settings.onChange(() => (markPad(), ui.refreshRight()));
  markPad();
  ui.addRight("history", "history", "History", () => ui.toggleHistory());
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

function choiceRow(label: string, active: boolean, run: () => void): HTMLElement {
  const row = el("button", `pop-row choice-row${active ? " active" : ""}`, label);
  row.addEventListener("click", run);
  return row;
}

function fmtStep(mm: number): string {
  return mm >= 1000 ? `${mm / 1000} m` : mm >= 10 ? `${mm / 10} cm` : `${mm} mm`;
}
