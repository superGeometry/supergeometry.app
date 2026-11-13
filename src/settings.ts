// Per-device preferences (not part of the project file).

import { isTouchDevice } from "./device";

const KEY = "supergeometry.settings.v1";
const OLD_KEY = "tessel.settings.v1";

export interface Settings {
  snap: {
    grid: boolean;
    guidePoints: boolean;
    guideLines: boolean;
    points3d: boolean;
    distantEdges: boolean;
  };
  showGuidePoints: boolean;
  showSnapHints: boolean;
  gridLocked: boolean;
  /** Grid step (mm) used when the grid is locked. */
  gridStep: number;
  showGrid: boolean;
  showAxes: boolean;
  animateCamera: boolean;
  ortho: boolean;
  shader: "shaded" | "wireframe" | "xray";
  /** Surface analysis on the bodies (Display modes): zebra stripes or a curvature map. */
  analysis: "none" | "zebra" | "curvature";
  zebraStripes: number;
  zebraDirection: "vertical" | "horizontal";
  /** Curvature map: a curve this tight (radius, mm) shows fully red (domed) or blue (hollow). */
  curvatureRadius: number;
  showEdges: boolean;
  showHiddenEdges: boolean;
  showPinned: boolean;
  /** Sketch mode: show the constraint column. */
  showConstraints: boolean;
  /** Sketch: add Horizontal/Vertical/Coincident automatically while drawing. */
  autoConstrain: boolean;
  /** Sketch: when a constraint joins two things, the first or the last picked stays put (the anchored one). */
  sketchAnchor: "first" | "last";
  /** Sketch: draw the constraint badges (H, V, ∥, dimensions…) on the geometry. */
  showConstraintGlyphs: boolean;
  /** Bumped when defaults change for everyone (see the constructor). */
  version: number;
  /** Angle display: decimal degrees or degrees + minutes. */
  degrees: "decimal" | "fractional";
  /** Value boxes use the on-screen numpad instead of the system keyboard. */
  numpad: boolean;
  /** The guide text (what to tap next) - switched in More. */
  showHints: boolean;
  /** Offline mode: the app's files are kept on this device (More → Offline mode). */
  offline: boolean;
  /**
   * The tool wheel: the tools come up in a ring round the pointer where the
   * model is tapped, in place of the column. Always on - it is the only way to
   * the tools (kept as a setting for the code that asks).
   */
  wheel: boolean;
}

const DEFAULTS: Settings = {
  snap: { grid: true, guidePoints: true, guideLines: true, points3d: true, distantEdges: false },
  showGuidePoints: true,
  showSnapHints: true,
  gridLocked: false,
  gridStep: 1,
  showGrid: true,
  showAxes: true,
  animateCamera: true,
  ortho: true,
  shader: "shaded",
  analysis: "none",
  zebraStripes: 16,
  zebraDirection: "vertical",
  curvatureRadius: 10,
  showEdges: true,
  showHiddenEdges: false,
  showPinned: true,
  degrees: "decimal",
  // The Constraints column (Auto constrain, Show constraints): closed - the
  // constraints themselves are in the card of what's selected.
  showConstraints: false,
  autoConstrain: true,
  sketchAnchor: "first",
  showConstraintGlyphs: true,
  // On by default on touch screens (phones, tablets, headsets).
  numpad: isTouchDevice,
  showHints: true,
  offline: false,
  wheel: true,
  version: 5,
};

type Listener = (s: Settings) => void;

class SettingsStore {
  value: Settings;
  private listeners = new Set<Listener>();

  constructor() {
    let saved: Partial<Settings> = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY) ?? "{}");
    } catch {
      // Unavailable storage just means defaults.
    }
    this.value = { ...DEFAULTS, ...saved, snap: { ...DEFAULTS.snap, ...(saved.snap ?? {}) } };
    // v2: orthographic view and the sketch constraint column are on by default -
    // also for anyone whose saved preferences still hold the old defaults.
    if ((saved.version ?? 1) < 2) this.value = { ...this.value, ortho: true, showConstraints: true, version: 2 };
    // v3: the on-screen numpad starts on for phones, tablets and headsets (off on computers).
    if ((saved.version ?? 1) < 3) this.value = { ...this.value, numpad: isTouchDevice, version: 3 };
    // v4: the Constraints column starts closed (it got in the way; the Constraints button opens it).
    if ((saved.version ?? 1) < 4) this.value = { ...this.value, showConstraints: false, version: 4 };
    // v5: the tool wheel is how the app is worked.
    if ((saved.version ?? 1) < 5) this.value = { ...this.value, wheel: true, version: 5 };
    // The wheel is the only way to the tools now (More no longer turns it off): on for
    // anyone who had turned it off before.
    this.value.wheel = true;
  }

  set<K extends keyof Settings>(key: K, v: Settings[K]): void {
    this.value = { ...this.value, [key]: v };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      // Ignore: preferences are a convenience.
    }
    this.listeners.forEach((fn) => fn(this.value));
  }

  onChange(fn: Listener): void {
    this.listeners.add(fn);
  }

  offChange(fn: Listener): void {
    this.listeners.delete(fn);
  }
}

export const settings = new SettingsStore();
