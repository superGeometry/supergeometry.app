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
  showEdges: boolean;
  showHiddenEdges: boolean;
  showPinned: boolean;
  /** Sketch mode: show the constraint column. */
  showConstraints: boolean;
  /** Sketch: add Horizontal/Vertical/Coincident automatically while drawing. */
  autoConstrain: boolean;
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
  showEdges: true,
  showHiddenEdges: false,
  showPinned: true,
  degrees: "decimal",
  showConstraints: true,
  autoConstrain: true,
  showConstraintGlyphs: true,
  // On by default on touch screens (phones, tablets, headsets).
  numpad: isTouchDevice,
  showHints: true,
  version: 3,
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
