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
  analysis: "none" | "zebra" | "curvature" | "overhang";
  /** Overhang check: how far a face may lean out from upright (degrees) before it needs support to print. */
  overhangAngle: number;
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
  /**
   * Quick buttons: the round buttons beside what is picked, and a tool's own beside the face it works on (Extrude's
   * Add and Cut). Off: none are shown, and the line at the bottom is where the tools are.
   */
  quickButtons: boolean;
  /** The guide text (what to tap next) - switched in More. */
  showHints: boolean;
  /** Offline mode: the app's files are kept on this device (More → Offline mode). */
  offline: boolean;
  /**
   * The sentence bar: a line at the bottom that says what is picked and what
   * can be done with it. Always on - it is the only way to the tools (kept as a
   * setting for the code that asks).
   */
  sentence: boolean;
  /**
   * Direct touch: what is picked is dragged by itself, not only by its arrow
   * or dot - a face pulled, a shape pulled up, an edge rounded - and a finger
   * pressed and held on one picks it and pulls in the same touch. Always on
   * (kept as a setting for the code that asks).
   */
  direct: boolean;
  /**
   * Which mouse drags turn, move and zoom the view (Settings > Mouse): the app's own way, or the way of another
   * CAD program, for hands used to it (see MOUSE_PRESETS). In all of them the wheel zooms, Alt + left drag turns,
   * and a right drag turns too unless the preset uses it for something else.
   */
  mouse: string;
  /** The wheel rolled forward zooms out (it zooms in otherwise). */
  wheelReverse: boolean;
}

export type MouseNav = "orbit" | "pan" | "zoom";

/**
 * A way of working the view with a mouse. `middle` and `right`: what a drag with that button does, by the keys
 * held (`plain`, `shift`, `ctrl`, `both` for Ctrl + Shift; one not given falls back to `plain`). `chord`: what
 * the middle button's drag becomes while another button is held with it (CATIA, NX, FreeCAD).
 */
export interface MousePreset {
  id: string;
  /** The programs that work this way (the row in Settings). */
  apps: string;
  /** What it does, in words. */
  text: string;
  middle: { plain: MouseNav; shift?: MouseNav; ctrl?: MouseNav; both?: MouseNav };
  right?: { shift?: MouseNav; ctrl?: MouseNav };
  chord?: { left?: MouseNav; right?: MouseNav };
}

/**
 * The presets. Each as its program's own
 * help gives it (2026-11); programs that work the same way share a row. The wheel's way round is its own switch
 * (programs differ, and each lets it be turned over).
 */
export const MOUSE_PRESETS: MousePreset[] = [
  {
    id: "default",
    apps: "superGeometry, Onshape, Tinkercad",
    text: "Right drag turns the view. Middle drag moves it (also Shift or Ctrl + right drag).",
    middle: { plain: "pan" },
    right: { shift: "pan", ctrl: "pan" },
  },
  {
    id: "fusion",
    apps: "Fusion, Inventor, Revit, AutoCAD",
    text: "Shift + middle drag turns the view. Middle drag moves it. Ctrl + Shift + middle drag zooms.",
    middle: { plain: "pan", shift: "orbit", both: "zoom" },
    right: { shift: "pan" },
  },
  {
    id: "solidworks",
    apps: "SolidWorks",
    text: "Middle drag turns the view. Ctrl + middle drag moves it. Shift + middle drag zooms.",
    middle: { plain: "orbit", ctrl: "pan", shift: "zoom" },
    right: { shift: "pan" },
  },
  {
    id: "creo",
    apps: "Creo, Solid Edge, Blender, SketchUp",
    text: "Middle drag turns the view. Shift + middle drag moves it. Ctrl + middle drag zooms.",
    middle: { plain: "orbit", shift: "pan", ctrl: "zoom" },
    right: { shift: "pan" },
  },
  {
    id: "nx",
    apps: "NX",
    text: "Middle drag turns the view. Middle + right drag (or Shift + middle) moves it. Middle + left drag (or Ctrl + middle) zooms.",
    middle: { plain: "orbit", shift: "pan", ctrl: "zoom" },
    right: { shift: "pan" },
    chord: { right: "pan", left: "zoom" },
  },
  {
    id: "catia",
    apps: "CATIA, FreeCAD",
    text: "Middle drag moves the view. Hold the middle button and press the left or right one too: the drag turns it. Ctrl + middle drag zooms.",
    middle: { plain: "pan", ctrl: "zoom" },
    right: { shift: "pan" },
    chord: { left: "orbit", right: "orbit" },
  },
  {
    id: "rhino",
    apps: "Rhino",
    text: "Right drag turns the view. Shift + right drag moves it. Ctrl + right drag zooms. Middle drag moves it too.",
    middle: { plain: "pan" },
    right: { shift: "pan", ctrl: "zoom" },
  },
];

/** The preset in use (one not known - an older setting - is the app's own). */
export function mousePreset(id: string): MousePreset {
  return MOUSE_PRESETS.find((m) => m.id === id) ?? MOUSE_PRESETS[0];
}

/** What a mouse press on the view does to the view, in a preset: null, nothing (the press is for the tools). */
export function mouseDrag(id: string, button: number, keys: { shift: boolean; ctrl: boolean; alt: boolean }): MouseNav | "right" | null {
  const preset = mousePreset(id);
  if (button === 0) return keys.alt ? "orbit" : null;
  // The right button: a drag turns the view, a click is the right-click (told apart as it moves) - with a key, what the preset says.
  if (button === 2) return (keys.ctrl ? preset.right?.ctrl : keys.shift ? preset.right?.shift : undefined) ?? "right";
  if (button !== 1) return null;
  const m = preset.middle;
  return (keys.ctrl && keys.shift ? (m.both ?? m.ctrl ?? m.shift) : keys.ctrl ? m.ctrl : keys.shift ? m.shift : undefined) ?? m.plain;
}

/** A middle drag while other buttons are held with it (`buttons` as a pointer event gives them): what it becomes, or null. */
export function mouseChord(id: string, buttons: number): MouseNav | null {
  const chord = mousePreset(id).chord;
  if (!chord || !(buttons & 4)) return null;
  return (buttons & 1 ? chord.left : undefined) ?? (buttons & 2 ? chord.right : undefined) ?? null;
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
  overhangAngle: 45,
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
  // On by default, on a computer too (its keyboard types into the box as ever, the pad open beside it).
  numpad: true,
  quickButtons: true,
  showHints: true,
  offline: false,
  sentence: true,
  direct: true,
  mouse: "default",
  wheelReverse: false,
  version: 6,
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
    // v6: the on-screen numpad starts on for everyone, on computers too (it was off there) - also for anyone
    // whose saved preferences hold it off: a computer's could not say whether that was chosen. Its switch in
    // Settings puts it off again.
    if ((saved.version ?? 1) < 6) this.value = { ...this.value, numpad: true, version: 6 };
    // The sentence bar is the only way to the tools (its switch in More is gone): on for everyone.
    this.value.sentence = true;
    // Direct touch is how the app is worked too (it had a switch in More for a while: one saved as off is on again).
    this.value.direct = true;
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
