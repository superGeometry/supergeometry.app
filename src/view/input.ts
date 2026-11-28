import { mouseChord, mouseDrag, settings } from "../settings";
import { isHeadset, pickTolerance } from "../device";
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
  /**
   * A finger or pen pressed and held still: return true to take hold of what
   * is under it (it is picked now) - moved from here, the same touch drags
   * it (`dragStart`); lifted, it stays picked. False: the hold is the
   * right-click (`context`).
   */
  grab?(p: ToolPointer): boolean;
  /** Box (window) selection with mouse/pen; `final` on release. */
  box?(a: { x: number; y: number }, b: { x: number; y: number }, final: boolean, add: boolean): void;
  /** A finger's drag on empty space draws the box too (instead of orbiting): a phone has no mouse to draw one. */
  boxByFinger?: boolean;
}

const TAP_SLOP = { mouse: 4, pen: 6, touch: 10 };
/** Press and hold this long (ms), still, for the right-click menu. */
const HOLD_MS = 550;
const DOUBLE_TAP_MS = 350;
/** Fingers down together and all lifted again within this long (ms), none having moved: a tap of two or three fingers. */
const FINGER_TAP_MS = 350;
/** Two fingers move this far (px) before they move the view: under it they may be a tap, and the view stays still. */
const PINCH_SLOP = 8;
/**
 * Two fingers turn this far (rad, 20°) before the view rolls with them: fingers that pinch or slide turn a little
 * too. (It was 12°: one finger moved a little rolled the view.)
 */
const TWIST_START = 0.35;
/**
 * ...and each has gone at least this far (px) round the point between them. An angle alone says little when the
 * fingers are close together: 20° of two fingers a thumb's width apart is a few millimetres of one of them.
 */
const TWIST_REACH = 32;

interface Tracked {
  id: number;
  type: ToolPointer["type"];
  x0: number;
  y0: number;
  x: number;
  y: number;
  button: number;
  shift: boolean;
  /** When the finger touched (the event's own time). */
  at: number;
}

export class InputRouter {
  handler: PointerHandler = {};
  private pointers = new Map<number, Tracked>();
  private mode: "idle" | "pending" | "captured" | "orbit" | "pan" | "zoom" | "pinch" | "box" | "ended" | "rpending" = "idle";

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
  private lastPinch: { d: number; cx: number; cy: number; a: number } | null = null;
  /**
   * Two fingers tapped on the view together (2), or three (3): Undo and Redo, as drawing apps on a tablet have
   * them. Set by the app.
   */
  fingerTap: ((fingers: number) => void) | null = null;
  /**
   * Several fingers on the view: when the first of them came down, the most there were at once, whether any has
   * moved (then they move the view, and are no tap), how far the first two have turned about each other, and
   * whether the view rolls with them by now.
   */
  private many: { t0: number; most: number; moved: boolean; turned: number; rolling: boolean } | null = null;
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
      // A hover still queued for the next frame would bring back what this clears.
      this.hoverAt = null;
      if (e.pointerType !== "touch" && this.mode === "idle") this.handler.hover?.(null);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    // Pressing the wheel: no browser autoscroll (on Windows it kept sliding the
    // view while the wheel was held). Middle-drag pans instead.
    el.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
    el.addEventListener("auxclick", (e) => e.button === 1 && e.preventDefault());
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
    const t: Tracked = { id: e.pointerId, type, x0: x, y0: y, x, y, button: e.button, shift: e.shiftKey, at: e.timeStamp };
    this.pointers.set(e.pointerId, t);

    if (type === "touch" && this.pointers.size === 2) {
      // Second finger: abandon whatever the first finger was doing and pinch.
      if (this.mode === "captured") {
        if (this.handler.breakOff) this.handler.breakOff();
        else this.handler.up?.(this.tp(t));
      }
      this.mode = "pinch";
      this.lastPinch = this.pinchState();
      const first = [...this.pointers.values()][0];
      this.many = { t0: first.at, most: 2, moved: Math.hypot(first.x - first.x0, first.y - first.y0) >= PINCH_SLOP, turned: 0, rolling: false };
      return;
    }
    if (this.pointers.size > 1) {
      if (type === "touch" && this.many) this.many.most = Math.max(this.many.most, this.pointers.size);
      return;
    }

    // Mouse: which drags turn, move and zoom the view is a setting (Settings > Mouse). As it comes: right-drag
    // orbits, middle-drag (or shift+right) pans, alt+left orbits (trackpads).
    const nav = type === "mouse" ? mouseDrag(settings.value.mouse, e.button, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }) : null;
    if (nav) {
      // Right button: a drag orbits, a click is a "context" action (decided on move/up).
      this.mode = nav === "right" ? "rpending" : nav;
      this.navBase = nav === "right" ? null : nav;
      return;
    }
    this.modifiers = e.ctrlKey || e.metaKey || e.shiftKey;
    if (this.handler.down?.(this.tp(t))) {
      this.mode = "captured";
      return;
    }
    this.mode = "pending";
    this.held = false;
    // Fingers, pens and a headset's controller have no right button: press
    // and hold still is the right-click (the same menu). (A headset's browser
    // may report its controller as a mouse.)
    if (!this.plainTaps && (type !== "mouse" || isHeadset) && this.handler.context) {
      clearTimeout(this.holdTimer);
      this.holdTimer = setTimeout(() => {
        if (this.mode !== "pending" || this.pointers.get(t.id) !== t || this.pointers.size !== 1) return;
        if (Math.hypot(t.x - t.x0, t.y - t.y0) >= TAP_SLOP[t.type]) return;
        // Taken hold of: the touch goes on (a move from here drags it, a lift leaves it picked).
        if (this.handler.grab?.(this.tp(t))) {
          this.held = true;
          navigator.vibrate?.(12);
          return;
        }
        this.mode = "ended";
        navigator.vibrate?.(12);
        this.handler.context?.(this.tp(t));
      }, HOLD_MS);
    }
  }

  /**
   * Press-and-hold is not looked for: a press however long is a tap when it lifts. The tutorial's - a beginner
   * presses slowly and waits, and a hold (which takes hold of what is under it, or opens its menu) was no tap:
   * the lit spot did nothing.
   */
  plainTaps = false;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  /** This touch took hold of what was under it (see `grab`): lifted without moving, it is not a tap. */
  private held = false;

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

    // A middle drag with another button held too (some programs' way to turn or zoom): what the preset says for
    // it, and back to the middle button's own once that button is let go.
    if (t.type === "mouse" && t.button === 1 && this.navBase && (this.mode === "orbit" || this.mode === "pan" || this.mode === "zoom")) {
      this.mode = mouseChord(settings.value.mouse, e.buttons) ?? this.navBase;
    }
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
        this.mode = (t.type !== "touch" || this.handler.boxByFinger) && this.handler.box ? "box" : "orbit";
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
        // Right to left takes whatever it touches: drawn dashed.
        this.marquee.classList.toggle("touching", b.x < a.x);
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
      case "zoom":
        // Dragged down: further away. About where the drag began.
        this.view.cam.zoom(Math.exp(dy * 0.01), this.view.worldUnder(t.x0, t.y0));
        this.view.requestRender();
        return;
      case "pinch": {
        const m = this.many;
        // Fingers that have not moved yet may be a tap (Undo, Redo): the view stays still under them. Once one has
        // moved they move the view, from where they are by then - not at a jump.
        if (m && !m.moved) {
          if (![...this.pointers.values()].some((q) => Math.hypot(q.x - q.x0, q.y - q.y0) >= PINCH_SLOP)) return;
          m.moved = true;
          this.lastPinch = this.pinchState();
          // (How far they have turned is counted from where they came down, not from here.)
          const [a, b] = [...this.pointers.values()];
          const turn = (this.lastPinch?.a ?? 0) - Math.atan2(b.y0 - a.y0, b.x0 - a.x0);
          if (this.lastPinch) m.turned = Math.atan2(Math.sin(turn), Math.cos(turn));
          return;
        }
        const s = this.pinchState();
        if (!s || !this.lastPinch) return;
        this.view.cam.pan(s.cx - this.lastPinch.cx, s.cy - this.lastPinch.cy, this.view.height);
        if (s.d > 0 && this.lastPinch.d > 0) {
          this.view.cam.zoom(this.lastPinch.d / s.d, this.view.worldUnder(s.cx, s.cy));
        }
        // Twisted: the view rolls with the fingers, about the point between them, as paper turned under them. Only
        // a twist meant as one - fingers that pinch or slide turn a little as they go.
        if (m) {
          let da = s.a - this.lastPinch.a;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          m.turned += da;
          if (!m.rolling && Math.abs(m.turned) > TWIST_START && Math.abs(m.turned) * (s.d / 2) > TWIST_REACH) {
            m.rolling = true;
            // (From here on: it does not jump to catch up with what was turned before it was taken for a twist.)
            da = 0;
          }
          if (m.rolling && da) this.view.cam.twist(da, s.cx - this.view.width / 2, s.cy - this.view.height / 2, this.view.height);
        }
        this.lastPinch = s;
        this.view.requestRender();
        return;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    clearTimeout(this.holdTimer);
    const t = this.pointers.get(e.pointerId);
    if (e.pointerType === "pen") this.penDown = false;
    if (!t) return;
    this.pointers.delete(e.pointerId);
    if (this.mode === "pinch") {
      // Lifting one finger of a pinch must not orbit with the remaining one.
      if (this.pointers.size > 0) {
        this.lastPinch = null;
        return;
      }
      this.mode = "idle";
      const m = this.many;
      this.many = null;
      if (!m) return;
      // All of them up again at once, none having moved: a tap of two fingers or of three. (Not in the tutorial:
      // its taps are the lit ones.)
      if (!m.moved && (m.most === 2 || m.most === 3) && e.timeStamp - m.t0 < FINGER_TAP_MS && !this.plainTaps) this.fingerTap?.(m.most);
      // A view rolled by hand and let go near level, or near a quarter turn, goes there.
      else if (m.rolling) {
        this.view.cam.settleRoll();
        this.view.requestRender();
      }
      return;
    }
    if (this.pointers.size > 0) return;
    const mode = this.mode;
    this.mode = "idle";
    if (mode === "captured") this.handler.up?.(this.tp(t));
    if (mode === "pending" && !this.held) this.emitTap(t);
    // Held still on a face, an edge or a sketch's shape (it took hold of it: picked, ready to be dragged) and
    // lifted where it was: the right-click's menu for it, by the finger - a press and hold was the right-click
    // everywhere but on these.
    else if (mode === "pending" && this.held) this.handler.context?.(this.tp(t));
    this.held = false;
    if (mode === "rpending") {
      // The browser's own menu comes after the release, aimed at whatever is under the pointer by then: the
      // tool list just opened there, not the canvas. Swallow that one.
      const swallow = (ev: Event) => ev.preventDefault();
      document.addEventListener("contextmenu", swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("contextmenu", swallow, { capture: true }), 500);
      this.handler.context?.(this.tp(t));
    }
    if (mode === "box") {
      this.marquee.hidden = true;
      // (On a touch screen every tap adds to what's picked: a box does too.)
      this.handler.box?.({ x: t.x0, y: t.y0 }, { x: t.x, y: t.y }, true, this.modifiers || t.type === "touch");
    }
  }

  private onCancel(e: PointerEvent): void {
    clearTimeout(this.holdTimer);
    if (e.pointerType === "pen") this.penDown = false;
    const t = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      if (this.mode === "captured" && t) this.handler.up?.(this.tp(t));
      this.mode = "idle";
      this.many = null;
    }
  }

  /** What the press that began this drag of the view does by itself (see the chord above). */
  private navBase: "orbit" | "pan" | "zoom" | null = null;
  private hoverAt: ToolPointer | null = null;
  private hoverFrame = 0;

  private emitTap(t: Tracked): void {
    // By when the finger came down, not when the tap is handled: the first tap
    // of a double tap can open a tool that takes a while (Extrude on a shape),
    // and the second, handled after it, counted as a tap on its own.
    const now = t.at;
    const near = Math.hypot(t.x - this.lastTap.x, t.y - this.lastTap.y) < 20;
    const count = now - this.lastTap.t < DOUBLE_TAP_MS && near ? this.lastTap.count + 1 : 1;
    this.lastTap = { t: now, x: t.x, y: t.y, count };
    this.handler.tap?.(this.tp(t), count);
  }

  /** The first two fingers: how far apart, the point between them, and which way the second lies from the first (rad, clockwise on the screen). */
  private pinchState(): { d: number; cx: number; cy: number; a: number } | null {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, a: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Wheel held down (panning): a press on the wheel can tilt it, and a tilted
    // wheel repeats sideways scrolls for as long as it's held - the view slid
    // off to one side without stopping. Only the drag pans meanwhile.
    if (e.buttons & 4 || this.mode === "pan" || this.mode === "orbit" || this.mode === "zoom") return;
    const [x, y] = this.local(e);
    if (e.ctrlKey || !isTrackpadPan(e)) {
      // Mouse wheel, or trackpad pinch (reported as ctrl+wheel).
      // (The wheel's way round is a setting; a trackpad's pinch is not a wheel.)
      const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : settings.value.wheelReverse ? -0.0015 : 0.0015));
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
