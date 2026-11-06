import { pickTolerance } from "../device";
// One input model for mouse, touch and pen (see docs/ARCHITECTURE.md §5).

import type { Viewport } from "./viewport";

export interface ToolPointer {
  x: number;
  y: number;
  type: "mouse" | "pen" | "touch";
  shift: boolean;
  /** Ctrl/Cmd/Shift held at press: add to the selection. */
  add?: boolean;
  /** Pick tolerance in px; fingers are fat. */
  tol: number;
}

export interface PointerHandler {
  /** Return true to capture the drag (e.g. grabbed a handle, started drawing). */
  down?(p: ToolPointer): boolean;
  drag?(p: ToolPointer): void;
  up?(p: ToolPointer): void;
  /** The captured drag was broken off (a second finger came down to pinch): undo it, place nothing. */
  breakOff?(): void;
  tap?(p: ToolPointer, count: number): void;
  hover?(p: ToolPointer | null): void;
  /** Right-click without dragging (e.g. end a line chain). */
  context?(p: ToolPointer): void;
  /**
   * The pointer moved past the tap slop without `down` capturing it: return
   * true to take this as a drag of what was under the press (`from`), so a
   * plain tap on the same thing still selects it.
   */
  dragStart?(from: ToolPointer): boolean;
  /** Box (window) selection with mouse/pen; `final` on release. */
  box?(a: { x: number; y: number }, b: { x: number; y: number }, final: boolean, add: boolean): void;
}

const TAP_SLOP = { mouse: 4, pen: 6, touch: 10 };
const DOUBLE_TAP_MS = 350;

interface Tracked {
  id: number;
  type: ToolPointer["type"];
  x0: number;
  y0: number;
  x: number;
  y: number;
  button: number;
  shift: boolean;
}

export class InputRouter {
  handler: PointerHandler = {};
  private pointers = new Map<number, Tracked>();
  private mode: "idle" | "pending" | "captured" | "orbit" | "pan" | "pinch" | "box" | "ended" | "rpending" = "idle";

  /** A tool is holding a drag (keys typed now go to it). */
  get dragging(): boolean {
    return this.mode === "captured";
  }

  /** The drag was finished from the keyboard: ignore the rest until release. */
  endDrag(): void {
    if (this.mode === "captured") this.mode = "ended";
  }
  private marquee = document.createElement("div");
  private modifiers = false;
  private penDown = false;
  private lastPinch: { d: number; cx: number; cy: number } | null = null;
  private lastTap = { t: 0, x: 0, y: 0, count: 0 };

  constructor(private view: Viewport) {
    const el = view.canvas;
    el.style.touchAction = "none";
    this.marquee.id = "marquee";
    this.marquee.hidden = true;
    document.body.append(this.marquee);
    el.addEventListener("pointerdown", (e) => this.onDown(e));
    el.addEventListener("pointermove", (e) => this.onMove(e));
    el.addEventListener("pointerup", (e) => this.onUp(e));
    el.addEventListener("pointercancel", (e) => this.onCancel(e));
    el.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "touch" && this.mode === "idle") this.handler.hover?.(null);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // Stop iPad Safari's own gestures (Scribble, magnifier, page zoom) on the canvas.
    el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    el.addEventListener("gesturestart", (e) => e.preventDefault());
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.view.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private tp(t: Tracked): ToolPointer {
    return { x: t.x, y: t.y, type: t.type, shift: t.shift, add: this.modifiers, tol: pickTolerance(t.type) };
  }

  private onDown(e: PointerEvent): void {
    const type = e.pointerType as ToolPointer["type"];
    // Palm rejection: while the pen touches the screen, ignore fingers.
    if (type === "touch" && this.penDown) return;
    if (type === "pen") this.penDown = true;
    try {
      this.view.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic/expired pointers can't be captured; tracking still works.
    }
    const [x, y] = this.local(e);
    const t: Tracked = { id: e.pointerId, type, x0: x, y0: y, x, y, button: e.button, shift: e.shiftKey };
    this.pointers.set(e.pointerId, t);

    if (type === "touch" && this.pointers.size === 2) {
      // Second finger: abandon whatever the first finger was doing and pinch.
      if (this.mode === "captured") {
        if (this.handler.breakOff) this.handler.breakOff();
        else this.handler.up?.(this.tp(t));
      }
      this.mode = "pinch";
      this.lastPinch = this.pinchState();
      return;
    }
    if (this.pointers.size > 1) return;

    // Mouse: right-drag orbits, middle-drag (or shift+right) pans, alt+left orbits (trackpads).
    if (type === "mouse" && (e.button === 1 || (e.button === 2 && e.shiftKey))) {
      this.mode = "pan";
      return;
    }
    // Right button: a drag orbits, a click is a "context" action (decided on move/up).
    if (type === "mouse" && e.button === 2) {
      this.mode = "rpending";
      return;
    }
    if (type === "mouse" && e.button === 0 && e.altKey) {
      this.mode = "orbit";
      return;
    }
    this.modifiers = e.ctrlKey || e.metaKey || e.shiftKey;
    if (this.handler.down?.(this.tp(t))) {
      this.mode = "captured";
      return;
    }
    this.mode = "pending";
  }

  private onMove(e: PointerEvent): void {
    const [x, y] = this.local(e);
    const t = this.pointers.get(e.pointerId);
    if (!t) {
      if (e.pointerType !== "touch" && this.mode === "idle") {
        // At most one hover pick per frame: mice report far more often than the screen redraws.
        this.hoverAt = { x, y, type: e.pointerType as ToolPointer["type"], shift: e.shiftKey, tol: pickTolerance(e.pointerType) };
        this.hoverFrame ||= requestAnimationFrame(() => {
          this.hoverFrame = 0;
          if (this.hoverAt && this.mode === "idle") {
            // Hovering (not a tap): picks skip the slower near-miss search.
            this.view.hovering = true;
            try {
              this.handler.hover?.(this.hoverAt);
            } finally {
              this.view.hovering = false;
            }
          }
        });
      }
      return;
    }
    const dx = x - t.x;
    const dy = y - t.y;
    t.x = x;
    t.y = y;
    t.shift = e.shiftKey;

    switch (this.mode) {
      case "rpending":
        if (Math.hypot(x - t.x0, y - t.y0) >= TAP_SLOP.mouse) this.mode = "orbit";
        return;
      case "pending": {
        if (Math.hypot(x - t.x0, y - t.y0) < TAP_SLOP[t.type]) return;
        if (this.handler.dragStart?.({ ...this.tp(t), x: t.x0, y: t.y0 })) {
          this.mode = "captured";
          this.handler.drag?.(this.tp(t));
          return;
        }
        // Mouse/pen drag on empty space = box selection; a finger orbits.
        this.mode = t.type !== "touch" && this.handler.box ? "box" : "orbit";
        return;
      }
      case "box": {
        const a = { x: t.x0, y: t.y0 };
        const b = { x, y };
        const r = this.view.canvas.getBoundingClientRect();
        Object.assign(this.marquee.style, {
          left: `${r.left + Math.min(a.x, b.x)}px`,
          top: `${r.top + Math.min(a.y, b.y)}px`,
          width: `${Math.abs(b.x - a.x)}px`,
          height: `${Math.abs(b.y - a.y)}px`,
        });
        this.marquee.hidden = false;
        this.handler.box?.(a, b, false, this.modifiers);
        return;
      }
      case "captured":
        this.handler.drag?.(this.tp(t));
        return;
      case "orbit":
        this.view.cam.orbit(dx, dy);
        this.view.requestRender();
        return;
      case "pan":
        this.view.cam.pan(dx, dy, this.view.height);
        this.view.requestRender();
        return;
      case "pinch": {
        const s = this.pinchState();
        if (!s || !this.lastPinch) return;
        this.view.cam.pan(s.cx - this.lastPinch.cx, s.cy - this.lastPinch.cy, this.view.height);
        if (s.d > 0 && this.lastPinch.d > 0) {
          this.view.cam.zoom(this.lastPinch.d / s.d, this.view.worldUnder(s.cx, s.cy));
        }
        this.lastPinch = s;
        this.view.requestRender();
        return;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    const t = this.pointers.get(e.pointerId);
    if (e.pointerType === "pen") this.penDown = false;
    if (!t) return;
    this.pointers.delete(e.pointerId);
    if (this.mode === "pinch") {
      // Lifting one finger of a pinch must not orbit with the remaining one.
      if (this.pointers.size === 0) this.mode = "idle";
      else this.lastPinch = null;
      return;
    }
    if (this.pointers.size > 0) return;
    const mode = this.mode;
    this.mode = "idle";
    if (mode === "captured") this.handler.up?.(this.tp(t));
    if (mode === "pending") this.emitTap(t);
    if (mode === "rpending") this.handler.context?.(this.tp(t));
    if (mode === "box") {
      this.marquee.hidden = true;
      this.handler.box?.({ x: t.x0, y: t.y0 }, { x: t.x, y: t.y }, true, this.modifiers);
    }
  }

  private onCancel(e: PointerEvent): void {
    if (e.pointerType === "pen") this.penDown = false;
    const t = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      if (this.mode === "captured" && t) this.handler.up?.(this.tp(t));
      this.mode = "idle";
    }
  }

  private hoverAt: ToolPointer | null = null;
  private hoverFrame = 0;

  private emitTap(t: Tracked): void {
    const now = performance.now();
    const near = Math.hypot(t.x - this.lastTap.x, t.y - this.lastTap.y) < 20;
    const count = now - this.lastTap.t < DOUBLE_TAP_MS && near ? this.lastTap.count + 1 : 1;
    this.lastTap = { t: now, x: t.x, y: t.y, count };
    this.handler.tap?.(this.tp(t), count);
  }

  private pinchState(): { d: number; cx: number; cy: number } | null {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const [x, y] = this.local(e);
    if (e.ctrlKey || !isTrackpadPan(e)) {
      // Mouse wheel, or trackpad pinch (reported as ctrl+wheel).
      const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.view.cam.zoom(factor, this.view.worldUnder(x, y));
    } else {
      this.view.cam.pan(-e.deltaX, -e.deltaY, this.view.height);
    }
    this.view.requestRender();
  }
}

/** Trackpads send pixel deltas with horizontal components; wheels send lines or big steps. */
function isTrackpadPan(e: WheelEvent): boolean {
  return e.deltaMode === 0 && e.deltaX !== 0;
}
