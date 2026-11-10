// Immersive VR (WebXR): the model floats in front of you at arm's length.
//
// Each hand has a wheel: hold A (right) or X (left), tilt the stick toward a
// button, let go - or point the other hand at a button and pull its trigger.
// Right wheel: the tools for what's picked (a running tool: Done, Cancel).
// Left wheel: Undo, Redo, Recenter, X-Ray, Edges, Deselect, Exit VR.
//
// Trigger: pick what the ray is on (corner, edge, face - it lights up first).
// Grip: grab the model (both grips: pull apart / together to size it).
// Left stick up / down: the model goes up / down. Right stick up / down:
// bigger / smaller - while a tool runs, its number instead (left / right: the
// next number). A tap: Done. B: Cancel, or Undo. Y: Redo. X tap: Recenter.
import { BufferGeometry, CanvasTexture, Color, DoubleSide, Group, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Scene, SphereGeometry, SRGBColorSpace, Vector3, type WebGLRenderer, type XRTargetRaySpace } from "three";
import type { PickHit } from "./viewport";
import type { VRField, VRItem } from "../tools/tool";
import { icons, type IconName } from "../ui/icons";

type Vec3 = [number, number, number];
type Kinds = { faces?: boolean; edges?: boolean; vertices?: boolean };

export interface XRHost {
  renderer: WebGLRenderer;
  /** The page's scene (z up, millimetres): carried into the headset's room as it is. */
  scene: Scene;
  /** The model's box, in the scene's own units. */
  bounds(): { min: Vec3; max: Vec3 } | null;
  /** What a ray (the scene's own coordinates) hits: a corner or edge within `tol`, else a face. */
  rayPick(origin: Vec3, dir: Vec3, tol: number, kinds: Kinds): PickHit | null;
  /** What may be picked now (a tool waiting for an edge: not faces). */
  kinds(): Kinds;
  /** The ray is on this (null: nothing): light it up. */
  onHover(hit: PickHit | null): void;
  /** The trigger picked this (null: pointed at nothing). Returns what to say ("Edge selected"). */
  onTrigger(hit: PickHit | null): string;
  /** A wheel's buttons, now. */
  wheel(hand: "left" | "right"): VRItem[];
  /** The running tool: its name, numbers and problem (null: none running). */
  tool(): VRTool | null;
  undo(): void;
  redo(): void;
  /** Before each frame in the headset (the page's own per-frame work). */
  beforeFrame(): void;
  onEnter(): void;
  onExit(): void;
}

export interface VRTool {
  title: string;
  fields: VRField[];
  error: string | null;
  done(): void;
  cancel(): void;
}

/** Whether this browser can open an immersive VR session (a headset's browser, or a PC with a headset). */
export async function vrSupported(): Promise<boolean> {
  const xr = (navigator as Navigator & { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
  if (!xr) return false;
  try {
    return await xr.isSessionSupported("immersive-vr");
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- drawing

const FONT = '-apple-system, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif';
const ACCENT = "#0a84ff";
const GLASS = "rgba(28, 28, 30, 0.82)";
const LINE = "rgba(255, 255, 255, 0.14)";

/** White icon pictures, made once each (drawn on canvases). */
const iconPics = new Map<string, HTMLImageElement>();
function iconPic(name: IconName, onLoad: () => void): HTMLImageElement | null {
  const have = iconPics.get(name);
  if (have) return have.complete && have.naturalWidth ? have : null;
  const img = new Image();
  const svg = icons[name].replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" ').split("currentColor").join("#ffffff");
  img.onload = onLoad;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  iconPics.set(name, img);
  return null;
}

/** A flat picture in the room: a canvas on a plane `w` metres wide. Redrawn only when asked. */
class Board {
  readonly mesh: Mesh;
  readonly g: CanvasRenderingContext2D;
  private tex: CanvasTexture;
  constructor(
    readonly px: number,
    readonly py: number,
    readonly w: number,
  ) {
    const c = document.createElement("canvas");
    c.width = px;
    c.height = py;
    this.g = c.getContext("2d")!;
    this.tex = new CanvasTexture(c);
    this.tex.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(new PlaneGeometry(w, (w * py) / px), new MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: false, side: DoubleSide }));
    this.mesh.renderOrder = 20;
  }
  clear(): CanvasRenderingContext2D {
    this.g.clearRect(0, 0, this.px, this.py);
    return this.g;
  }
  show(): void {
    this.tex.needsUpdate = true;
  }
}

/** A wheel of round buttons above one controller. */
class Wheel {
  readonly board = new Board(768, 768, 0.2);
  items: VRItem[] = [];
  hot = -1;
  title = "";
  constructor() {
    this.board.mesh.visible = false;
    // Above the controller, tilted toward you.
    this.board.mesh.position.set(0, 0.07, -0.06);
    this.board.mesh.rotation.x = -0.75;
  }
  get open(): boolean {
    return this.board.mesh.visible;
  }
  /** Where button i sits (canvas pixels): round the ring from the top, clockwise. */
  private at(i: number): [number, number] {
    const n = Math.max(this.items.length, 1);
    const a = (i / n) * Math.PI * 2;
    return [384 + Math.sin(a) * 250, 384 - Math.cos(a) * 250];
  }
  /** The button at a stick angle (0: up, clockwise), or -1. */
  slotAt(x: number, y: number): number {
    if (Math.hypot(x, y) < 0.55 || !this.items.length) return -1;
    const a = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2);
    const n = this.items.length;
    return Math.round((a / (Math.PI * 2)) * n) % n;
  }
  /** The button under a point of the board (-1..1 across, -1..1 up), or -1. */
  slotAtPoint(u: number, v: number): number {
    const px = 384 + u * 384;
    const py = 384 - v * 384;
    let best = -1;
    let bd = 80;
    this.items.forEach((_, i) => {
      const [x, y] = this.at(i);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) ((bd = d), (best = i));
    });
    return best;
  }
  draw(): void {
    const g = this.board.clear();
    g.fillStyle = GLASS;
    g.beginPath();
    g.arc(384, 384, 360, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = LINE;
    g.lineWidth = 3;
    g.stroke();
    this.items.forEach((it, i) => {
      const [x, y] = this.at(i);
      const hot = i === this.hot;
      g.fillStyle = hot ? ACCENT : "rgba(255,255,255,0.08)";
      g.beginPath();
      g.arc(x, y, hot ? 74 : 66, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = it.disabled ? 0.35 : 1;
      const pic = it.icon ? iconPic(it.icon, () => this.draw()) : null;
      if (pic) g.drawImage(pic, x - 34, y - 34, 68, 68);
      else {
        g.fillStyle = "#fff";
        g.font = `600 30px ${FONT}`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(it.label.slice(0, 2), x, y);
      }
      g.globalAlpha = 1;
    });
    // The middle: what the chosen button does (or the wheel's name).
    const text = this.items[this.hot] ? this.items[this.hot].label : this.items.length ? this.title : "Pick a face, edge or corner first";
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `600 ${text.length > 16 ? 30 : 38}px ${FONT}`;
    wrap(g, text, 384, 384, 230, 42);
    this.board.show();
  }
}

/** Text in at most two lines, centred on (x, y). */
function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, max: number, lh: number): void {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 2);
  shown.forEach((l, i) => g.fillText(l, x, y + (i - (shown.length - 1) / 2) * lh));
}

// --------------------------------------------------------------- the mode

interface Hand {
  side: "left" | "right";
  ray: XRTargetRaySpace;
  line: Line;
  wheel: Wheel;
  squeezing: boolean;
  grabFrom: Matrix4 | null;
  /** Face buttons' state last frame: [A/X, B/Y]. */
  was: [boolean, boolean];
  /** When A/X went down (ms). */
  heldSince: number;
  /** The stick was flicked left / right already (one number per flick). */
  flicked: boolean;
}

export class VRMode {
  private room = new Scene();
  /** Holds the page's scene: placed, turned and sized in the room. */
  private holder = new Group();
  private hands: Hand[] = [];
  private grabStart: Matrix4 | null = null;
  private pinch: { d0: number; s0: number } | null = null;
  private session: XRSession | null = null;
  private dot = new Mesh(new SphereGeometry(0.005, 12, 8), new MeshBasicMaterial({ color: 0x0a84ff, depthTest: false }));
  /** The card above the right hand: the running tool, or a short message. */
  private card = new Board(640, 240, 0.17);
  private cardKey = "";
  private toast: { text: string; until: number } | null = null;
  /** Which of the tool's numbers the stick sets, and its value while the stick moves it. */
  private field = 0;
  private live: { value: number; sent: number; dirty: boolean } | null = null;
  private last = 0;
  /** The hover pick is redone only when the right hand moved (frame work stays small). */
  private lastRay: { o: Vector3; d: Vector3 } | null = null;
  private lastHover = "";

  constructor(private host: XRHost) {
    this.room.add(this.holder, this.dot);
    this.dot.visible = false;
    this.dot.renderOrder = 30;
    this.card.mesh.visible = false;
  }

  get active(): boolean {
    return !!this.session;
  }

  /** Pictures of a wheel (the stick on button `hot`) and of the card, as the headset would show them (to check their look). */
  snapshot(side: "left" | "right", hot = -1): { wheel: string; card: string } {
    const w = new Wheel();
    w.items = this.host.wheel(side);
    w.title = side === "right" ? "Tools" : "View";
    w.hot = hot;
    w.draw();
    this.cardKey = "";
    this.drawCard(this.host.tool());
    return { wheel: w.board.g.canvas.toDataURL(), card: this.card.g.canvas.toDataURL() };
  }

  async enter(): Promise<void> {
    const xr = (navigator as Navigator & { xr?: { requestSession(mode: string, init?: object): Promise<XRSession> } }).xr;
    if (!xr || this.session) return;
    const session = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
    const { renderer, scene } = this.host;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    try {
      await renderer.xr.setSession(session);
    } catch (err) {
      renderer.xr.enabled = false;
      void session.end().catch(() => {});
      throw err;
    }
    this.session = session;
    this.room.background = scene.background instanceof Color ? scene.background.clone() : new Color(0x2b2d31);
    // The page's scene is z up in millimetres; the room is y up in metres.
    this.holder.add(scene);
    scene.rotation.set(-Math.PI / 2, 0, 0);
    this.place();
    this.host.onEnter();
    for (const i of [0, 1]) this.addHand(i);
    session.addEventListener("end", () => this.leave());
    this.last = 0;
    renderer.setAnimationLoop((t: number) => this.frame(t));
  }

  exit(): void {
    void this.session?.end();
  }

  /** The model about 40 cm across, its middle at chest height half a metre ahead. */
  recenter(): void {
    this.place();
    this.say("Recentered");
  }

  private place(): void {
    const b = this.host.bounds();
    const min = b?.min ?? [-50, -50, -50];
    const max = b?.max ?? [50, 50, 50];
    const size = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
    const k = 0.4 / size;
    const mid = new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const turned = mid.clone().applyEuler(this.host.scene.rotation).multiplyScalar(k);
    this.holder.scale.setScalar(k);
    this.holder.quaternion.identity();
    this.holder.position.set(-turned.x, 1.1 - turned.y, -0.5 - turned.z);
  }

  private addHand(i: number): void {
    const ray = this.host.renderer.xr.getController(i);
    const line = new Line(new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -1)]), new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    line.scale.z = 2;
    ray.add(line);
    const wheel = new Wheel();
    ray.add(wheel.board.mesh);
    this.room.add(ray);
    const hand: Hand = { side: i === 0 ? "right" : "left", ray, line, wheel, squeezing: false, grabFrom: null, was: [false, false], heldSince: 0, flicked: false };
    // Which hand it is comes with the controller; the card rides above the right one.
    const placeCard = () => {
      if (hand.side !== "right") return;
      ray.add(this.card.mesh);
      this.card.mesh.position.set(0, 0.06, -0.1);
      this.card.mesh.rotation.x = -0.6;
    };
    ray.addEventListener("connected", (e) => {
      const side = (e as unknown as { data?: XRInputSource }).data?.handedness;
      if (side === "left" || side === "right") hand.side = side;
      placeCard();
    });
    placeCard();
    this.hands.push(hand);
    ray.addEventListener("selectstart", () => this.trigger(hand));
    ray.addEventListener("squeezestart", () => {
      hand.squeezing = true;
      this.startGrab();
    });
    ray.addEventListener("squeezeend", () => {
      hand.squeezing = false;
      this.startGrab();
    });
  }

  /** The trigger: a button of the other hand's open wheel, else a pick. */
  private trigger(hand: Hand): void {
    for (const other of this.hands) {
      if (other === hand || !other.wheel.open) continue;
      const slot = this.wheelUnderRay(hand, other.wheel);
      if (slot >= 0) {
        other.wheel.board.mesh.visible = false;
        this.run(other.wheel.items[slot]);
        return;
      }
    }
    const hit = this.cast(hand)?.hit ?? null;
    this.buzz(hand, hit ? 0.35 : 0.1, 25);
    this.say(this.host.onTrigger(hit));
    this.lastRay = null;
  }

  /** Where a hand's ray meets a wheel: the button there, or -1. */
  private wheelUnderRay(hand: Hand, wheel: Wheel): number {
    const { o, d } = this.rayOf(hand);
    const m = wheel.board.mesh;
    m.updateMatrixWorld();
    const n = new Vector3(0, 0, 1).applyQuaternion(m.getWorldQuaternion(new Quaternion()));
    const c = new Vector3().setFromMatrixPosition(m.matrixWorld);
    const den = n.dot(d);
    if (Math.abs(den) < 1e-6) return -1;
    const t = c.clone().sub(o).dot(n) / den;
    if (t < 0) return -1;
    const local = o.clone().addScaledVector(d, t).applyMatrix4(m.matrixWorld.clone().invert());
    const half = wheel.board.w / 2;
    return wheel.slotAtPoint(local.x / half, local.y / half);
  }

  private run(item: VRItem | undefined): void {
    if (!item || item.disabled) return;
    item.run();
    this.say(item.label);
    this.field = 0;
    this.live = null;
    this.lastRay = null;
  }

  private startGrab(): void {
    const held = this.hands.filter((h) => h.squeezing);
    this.grabStart = this.holder.matrix.clone();
    for (const h of this.hands) h.grabFrom = h.squeezing ? h.ray.matrixWorld.clone() : null;
    this.pinch = held.length === 2 ? { d0: held[0].ray.position.distanceTo(held[1].ray.position), s0: this.holder.scale.x } : null;
  }

  private rayOf(hand: Hand): { o: Vector3; d: Vector3 } {
    hand.ray.updateMatrixWorld();
    const o = new Vector3().setFromMatrixPosition(hand.ray.matrixWorld);
    const d = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(hand.ray.matrixWorld)).normalize();
    return { o, d };
  }

  private cast(hand: Hand): { hit: PickHit; at: Vector3 } | null {
    const { o, d } = this.rayOf(hand);
    this.host.scene.updateMatrixWorld();
    const inv = this.host.scene.matrixWorld.clone().invert();
    const lo = o.clone().applyMatrix4(inv);
    const ld = o.clone().add(d).applyMatrix4(inv).sub(lo).normalize();
    // A corner or edge within about a centimetre of the ray (more further away), in the model's own size.
    const scale = this.holder.scale.x || 1;
    const reach = Math.max(0.008, 0.015 * o.distanceTo(new Vector3().setFromMatrixPosition(this.holder.matrixWorld)));
    const hit = this.host.rayPick(lo.toArray() as Vec3, ld.toArray() as Vec3, reach / scale, this.host.kinds());
    if (!hit) return null;
    return { hit, at: new Vector3(...hit.point).applyMatrix4(this.host.scene.matrixWorld) };
  }

  private buzz(hand: Hand, strength: number, ms: number): void {
    const src = [...(this.session?.inputSources ?? [])].find((s) => s.handedness === hand.side);
    const act = (src?.gamepad as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): void }[] }) | undefined)?.hapticActuators?.[0];
    act?.pulse(strength, ms);
  }

  private say(text: string): void {
    if (text) this.toast = { text, until: performance.now() + 1600 };
  }

  private frame(t: number): void {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    const tool = this.host.tool();
    const held = this.hands.filter((h) => h.squeezing);
    if (held.length === 1 && this.grabStart && held[0].grabFrom) {
      const m = held[0].ray.matrixWorld.clone().multiply(held[0].grabFrom.clone().invert()).multiply(this.grabStart);
      m.decompose(this.holder.position, this.holder.quaternion, this.holder.scale);
    } else if (held.length === 2 && this.pinch && this.pinch.d0 > 1e-3) {
      const d = held[0].ray.position.distanceTo(held[1].ray.position);
      this.holder.scale.setScalar(this.pinch.s0 * (d / this.pinch.d0));
    }
    for (const src of this.session?.inputSources ?? []) {
      const hand = this.hands.find((h) => h.side === src.handedness);
      const pad = src.gamepad;
      if (!hand || !pad) continue;
      this.buttons(hand, pad, tool, t, dt);
    }
    this.hover();
    this.drawCard(tool);
    this.host.beforeFrame();
    this.host.renderer.render(this.room, this.host.renderer.xr.getCamera());
  }

  /** One hand's buttons and stick this frame. */
  private buttons(hand: Hand, pad: Gamepad, tool: VRTool | null, t: number, dt: number): void {
    const sx = pad.axes[2] ?? 0;
    const sy = pad.axes[3] ?? 0;
    const ax = !!pad.buttons[4]?.pressed;
    const by = !!pad.buttons[5]?.pressed;
    // A / X held: its wheel opens; the stick chooses; letting go runs it (a quick tap: Done / Recenter).
    if (ax && !hand.was[0]) hand.heldSince = t;
    if (ax && !hand.wheel.open && t - hand.heldSince > 140) {
      hand.wheel.items = this.host.wheel(hand.side);
      hand.wheel.title = hand.side === "right" ? (tool ? tool.title : "Tools") : "View";
      hand.wheel.hot = -1;
      hand.wheel.board.mesh.visible = true;
      hand.wheel.draw();
    }
    if (hand.wheel.open && ax) {
      const slot = hand.wheel.slotAt(sx, sy);
      if (slot !== hand.wheel.hot) {
        hand.wheel.hot = slot;
        hand.wheel.draw();
        if (slot >= 0) this.buzz(hand, 0.2, 12);
      }
    }
    if (!ax && hand.was[0]) {
      if (hand.wheel.open) {
        const item = hand.wheel.items[hand.wheel.hot];
        hand.wheel.board.mesh.visible = false;
        this.run(item);
      } else if (t - hand.heldSince < 300) {
        if (hand.side === "right" && tool) {
          tool.done();
          this.say("Done");
        } else if (hand.side === "left") this.recenter();
      }
    }
    // B (right): Cancel the running tool, or Undo. Y (left): Redo.
    if (by && !hand.was[1]) {
      if (hand.side === "left") {
        this.host.redo();
        this.say("Redo");
      } else if (tool) {
        tool.cancel();
        this.say("Cancelled");
      } else {
        this.host.undo();
        this.say("Undo");
      }
      this.lastRay = null;
    }
    hand.was = [ax, by];
    if (hand.wheel.open) return;
    if (hand.side === "left") {
      if (Math.abs(sy) > 0.15) this.holder.position.y -= sy * 0.5 * dt;
    } else if (tool && tool.fields.length) this.stickField(tool.fields, sx, sy, dt, hand);
    else if (Math.abs(sy) > 0.15) this.holder.scale.multiplyScalar(Math.pow(2, -sy * dt));
  }

  /** Right stick while a tool runs: up / down sets its number, a flick left / right moves to the next one. */
  private stickField(fields: VRField[], sx: number, sy: number, dt: number, hand: Hand): void {
    if (Math.abs(sx) > 0.7 && Math.abs(sy) < 0.5) {
      if (!hand.flicked) {
        this.field = (this.field + (sx > 0 ? 1 : -1) + fields.length) % fields.length;
        this.live = null;
        hand.flicked = true;
        this.buzz(hand, 0.2, 12);
      }
    } else if (Math.abs(sx) < 0.3) hand.flicked = false;
    const f = fields[Math.min(this.field, fields.length - 1)];
    if (!f) return;
    const moving = Math.abs(sy) > 0.15;
    if (moving) {
      const v = this.live?.value ?? f.value;
      // Full tilt: lengths and plain numbers change by about their own size a second, angles 45° a second.
      const rate = f.kind === "angle" ? 45 : f.kind === "int" ? 3 : Math.max(1, Math.abs(v));
      let next = v - sy * rate * dt;
      if (f.min !== undefined) next = Math.max(f.min, next);
      this.live = { value: next, sent: this.live?.sent ?? 0, dirty: true };
    }
    // Sent to the tool a few times a second (each one rebuilds the preview), and once more on letting go.
    const now = performance.now();
    if (this.live?.dirty && (now - this.live.sent > 150 || !moving)) {
      f.set(tidy(this.live.value, f.kind));
      this.live.sent = now;
      this.live.dirty = false;
    }
    if (!moving && this.live && !this.live.dirty) this.live = null;
  }

  /** Light up what the right hand points at (only when it moved). */
  private hover(): void {
    const hand = this.hands.find((h) => h.side === "right") ?? this.hands[0];
    if (!hand) return;
    const { o, d } = this.rayOf(hand);
    if (this.lastRay && this.lastRay.o.distanceTo(o) < 0.002 && this.lastRay.d.angleTo(d) < 0.004) return;
    this.lastRay = { o, d };
    const c = this.cast(hand);
    hand.line.scale.z = c ? Math.max(0.02, c.at.distanceTo(o)) : 2;
    this.dot.visible = !!c;
    if (c) this.dot.position.copy(c.at);
    const hit = c?.hit ?? null;
    const key = hit ? `${hit.kind}|${"body" in hit ? hit.body : ""}|${"face" in hit ? hit.face : "edge" in hit ? hit.edge : "vertex" in hit ? hit.vertex : ""}` : "";
    if (key !== this.lastHover) {
      this.lastHover = key;
      this.host.onHover(hit);
      if (hit) this.buzz(hand, 0.06, 8);
    }
  }

  /** The card: a message for a moment, else the running tool and the number the stick sets. */
  private drawCard(tool: VRTool | null): void {
    const toast = this.toast && performance.now() < this.toast.until ? this.toast.text : null;
    const i = tool ? Math.min(this.field, Math.max(0, tool.fields.length - 1)) : 0;
    const f = tool?.fields[i];
    const value = f ? show(this.live?.value ?? f.value, f.kind) : "";
    const key = toast ? `t|${toast}` : tool ? `f|${tool.title}|${f?.label}|${value}|${tool.error}|${i}/${tool.fields.length}` : "";
    if (key === this.cardKey) return;
    this.cardKey = key;
    this.card.mesh.visible = !!key;
    if (!key) return;
    const g = this.card.clear();
    g.fillStyle = GLASS;
    g.beginPath();
    g.roundRect(4, 4, 632, 232, 44);
    g.fill();
    g.strokeStyle = tool?.error && !toast ? "rgba(255,69,58,0.9)" : LINE;
    g.lineWidth = 3;
    g.stroke();
    g.textAlign = "center";
    g.textBaseline = "middle";
    if (toast) {
      g.fillStyle = "#fff";
      g.font = `600 46px ${FONT}`;
      wrap(g, toast, 320, 120, 560, 54);
    } else if (tool) {
      g.font = `500 30px ${FONT}`;
      g.fillStyle = "rgba(235,235,245,0.6)";
      g.fillText(f ? `${tool.title}  ·  ${f.label}${tool.fields.length > 1 ? `  ${i + 1}/${tool.fields.length}` : ""}` : tool.title, 320, 52);
      g.fillStyle = "#fff";
      g.font = `600 64px ${FONT}`;
      g.fillText(f ? value : "Pick what it needs", 320, 122);
      g.font = `500 26px ${FONT}`;
      g.fillStyle = tool.error ? "#ff453a" : "rgba(235,235,245,0.55)";
      if (tool.error) {
        // The first part of the message (the reason), in up to two lines.
        g.font = `500 23px ${FONT}`;
        wrap(g, tool.error.split(/ - |\. /)[0], 320, 192, 580, 28);
      } else g.fillText("Stick: set  ·  A: Done  ·  B: Cancel", 320, 190);
    }
    this.card.show();
  }

  private leave(): void {
    const { renderer, scene } = this.host;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    for (const h of this.hands) {
      h.ray.removeFromParent();
      h.line.geometry.dispose();
    }
    this.hands = [];
    this.grabStart = null;
    this.pinch = null;
    this.lastRay = null;
    this.lastHover = "";
    this.host.onHover(null);
    scene.removeFromParent();
    scene.rotation.set(0, 0, 0);
    scene.updateMatrixWorld(true);
    this.session = null;
    this.host.onExit();
  }
}

/** A number as the stick leaves it: lengths to a tenth, angles to a degree, counts whole. */
function tidy(v: number, kind: VRField["kind"]): number {
  if (kind === "int" || kind === "angle") return Math.round(v);
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
}

function show(v: number, kind: VRField["kind"]): string {
  const n = tidy(v, kind);
  return kind === "angle" ? `${n}°` : kind === "length" ? `${n} mm` : String(n);
}
