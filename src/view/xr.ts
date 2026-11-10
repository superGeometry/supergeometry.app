// The model in the headset, as a real thing in your room (passthrough where
// the headset has it, else a dark room). A viewer: nothing is edited here.
//
// Right trigger: put the model down where the ray meets a table or the floor.
// Grip: pick it up, move and turn it (both grips: pull apart / together to
// size it; it stops at real size on the way). A: real size / hand size.
// B: bring it back in front of you. Y: X-Ray. Hold X: the wheel (Real size,
// Hand size, Bring here, X-Ray, Edges, Exit) - tilt the stick to a button and
// let go, or point the right hand at it and pull the trigger. A tap on X:
// bring it here. Left stick up / down: raise / lower it. Right stick: turn
// it (left / right), size it (up / down).
import { BufferGeometry, CanvasTexture, Color, DoubleSide, Euler, Group, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, RingGeometry, Scene, SRGBColorSpace, Vector3, type WebGLRenderer, type XRTargetRaySpace } from "three";
import { icons, type IconName } from "../ui/icons";

type Vec3 = [number, number, number];

export interface VRItem {
  label: string;
  icon?: IconName;
  disabled?: boolean;
  run(): void;
}

export interface XRHost {
  renderer: WebGLRenderer;
  /** The page's scene (z up, millimetres): carried into the headset's room as it is. */
  scene: Scene;
  /** The model's box, in the scene's own units. */
  bounds(): { min: Vec3; max: Vec3 } | null;
  /** X-Ray on / off; returns what to say ("X-Ray", "Shaded"). */
  xray(): string;
  /** Edges shown / hidden; returns what to say. */
  edges(): string;
  /** The look buttons' labels now ("X-Ray" or "Shaded", "Show Edges" or "Hide Edges"). */
  looks(): { xray: string; edges: string };
  /** Before each frame in the headset (the page's own per-frame work). */
  beforeFrame(): void;
  onEnter(): void;
  onExit(): void;
}

type XRSystemLike = { isSessionSupported(mode: string): Promise<boolean>; requestSession(mode: string, init?: object): Promise<XRSession> };
const xrSystem = (): XRSystemLike | undefined => (navigator as Navigator & { xr?: XRSystemLike }).xr;

/** Whether this browser can open the headset view (a headset's browser, or a PC with a headset). */
export async function vrSupported(): Promise<boolean> {
  const xr = xrSystem();
  if (!xr) return false;
  for (const mode of ["immersive-ar", "immersive-vr"])
    try {
      if (await xr.isSessionSupported(mode)) return true;
    } catch {
      /* try the next */
    }
  return false;
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


/**
 * The model's scale as a moving tape: real size (1:1) is the zero, each mark
 * up is twice as big (2:1, 4:1), each mark down half (1:2, 1:4). The tape
 * slides under a fixed pointer; the number on top is the scale now.
 */
class Tape {
  readonly board = new Board(300, 560, 0.06);
  private key = "";
  draw(ratio: number): void {
    const v = Math.log2(Math.max(1e-6, ratio));
    const key = `${ratioText(ratio)}|${v.toFixed(2)}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.board.clear();
    g.fillStyle = GLASS;
    g.beginPath();
    g.roundRect(4, 4, 292, 552, 48);
    g.fill();
    g.strokeStyle = LINE;
    g.lineWidth = 3;
    g.stroke();
    // The number now.
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#fff";
    g.font = `600 64px ${FONT}`;
    g.fillText(ratioText(ratio), 150, 72);
    g.fillStyle = "rgba(235,235,245,0.55)";
    g.font = `500 26px ${FONT}`;
    g.fillText(Math.abs(v) < 0.005 ? "real size" : v > 0 ? "bigger" : "smaller", 150, 122);
    // The tape: one mark a doubling, 80 px apart, the pointer in the middle of the window.
    const top = 156;
    const bottom = 540;
    const mid = (top + bottom) / 2;
    const step = 80;
    g.save();
    g.beginPath();
    g.rect(0, top, 300, bottom - top);
    g.clip();
    for (let k = Math.floor(v) - 3; k <= Math.ceil(v) + 3; k++)
      for (const half of [0, 0.5]) {
        const y = mid - (k + half - v) * step;
        if (y < top - 20 || y > bottom + 20) continue;
        const zero = k === 0 && !half;
        g.strokeStyle = zero ? ACCENT : half ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.6)";
        g.lineWidth = zero ? 5 : 3;
        g.beginPath();
        g.moveTo(40, y);
        g.lineTo(half ? 72 : 96, y);
        g.stroke();
        if (half) continue;
        g.textAlign = "left";
        g.fillStyle = zero ? ACCENT : "rgba(235,235,245,0.8)";
        g.font = `${zero ? 700 : 500} 34px ${FONT}`;
        g.fillText(k >= 0 ? `${2 ** k}:1` : `1:${2 ** -k}`, 116, y);
      }
    g.restore();
    // The pointer: where the model is now.
    g.fillStyle = "#fff";
    g.beginPath();
    g.moveTo(12, mid - 14);
    g.lineTo(34, mid);
    g.lineTo(12, mid + 14);
    g.fill();
    g.strokeStyle = "#fff";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(34, mid);
    g.lineTo(104, mid);
    g.stroke();
    this.board.show();
  }
  reset(): void {
    this.key = "";
  }
}

/** A scale as people write it: 1:1, 2:1, 1:4, 1:2.5 (a tenth when it's not whole, under ten). */
function ratioText(r: number): string {
  const one = (n: number) => (n >= 10 || Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));
  return r >= 1 ? `${one(r)}:1` : `1:${one(1 / r)}`;
}

// --------------------------------------------------------------- the mode

/** One millimetre, in the room's metres: real size. */
const REAL = 0.001;

interface Hand {
  side: "left" | "right";
  ray: XRTargetRaySpace;
  line: Line;
  wheel: Wheel;
  squeezing: boolean;
  grabFrom: Matrix4 | null;
  /** Face buttons last frame: [A/X, B/Y]. */
  was: [boolean, boolean];
  heldSince: number;
  /** Where real surfaces are along this hand's ray (the headset's own room scan), when it offers that. */
  hits: XRHitTestSource | null;
  /** The controller the room scan was asked for. */
  asked: XRInputSource | null;
}

export class VRMode {
  private room = new Scene();
  /** Holds the page's scene: placed, turned and sized in the room. */
  private holder = new Group();
  private hands: Hand[] = [];
  private grabStart: Matrix4 | null = null;
  private pinch: { d0: number; s0: number; snapped: boolean } | null = null;
  private session: XRSession | null = null;
  private passthrough = false;
  private clear = { color: new Color(), alpha: 1 };
  /** Where the model would go: a ring on the table or floor the right hand points at. */
  private reticle = new Mesh(new RingGeometry(0.035, 0.045, 48).rotateX(-Math.PI / 2), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
  /** A soft shadow under the model while it stands on something. */
  private shadow = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }));
  /** The card above the right hand: a short message. */
  private card = new Board(640, 200, 0.15);
  /** The scale above the left hand: 1:1 in the middle, bigger up, smaller down. */
  private tape = new Tape();
  /** The right stick stopped at real size: it sizes again once let go. */
  private stickHeld = false;
  private toast: { text: string; until: number } | null = null;
  private cardKey = "";
  /** The model's bottom middle, in the holder's own (y up, millimetres) coordinates. */
  private base = new Vector3();
  /** The model's size (millimetres, its longest diagonal). */
  private size = 100;
  private glide: { from: Vector3; to: Vector3; qFrom: Quaternion; qTo: Quaternion; t0: number } | null = null;
  private placed = false;
  private needsFirstPlace = true;
  private last = 0;

  constructor(private host: XRHost) {
    this.room.add(this.holder, this.reticle);
    this.reticle.visible = false;
    this.reticle.renderOrder = 30;
    this.shadow.renderOrder = -1;
    this.card.mesh.visible = false;
  }

  get active(): boolean {
    return !!this.session;
  }

  /** Pictures of the wheel (the stick on button `hot`) and of the card saying `text`, as the headset shows them (to check their look). */
  snapshot(hot = -1, text = "X-Ray", ratio = 1): { wheel: string; card: string; tape: string } {
    const w = new Wheel();
    w.items = this.items();
    w.title = "View";
    w.hot = hot;
    w.draw();
    this.say(text);
    this.cardKey = "";
    this.drawCard();
    this.toast = null;
    this.cardKey = "";
    const t = new Tape();
    t.draw(ratio);
    return { wheel: w.board.g.canvas.toDataURL(), card: this.card.g.canvas.toDataURL(), tape: t.board.g.canvas.toDataURL() };
  }

  async enter(): Promise<void> {
    const xr = xrSystem();
    if (!xr || this.session) return;
    // Passthrough first (the model in your real room), else a plain dark room.
    let session: XRSession | null = null;
    this.passthrough = false;
    try {
      if (await xr.isSessionSupported("immersive-ar")) {
        session = await xr.requestSession("immersive-ar", { optionalFeatures: ["local-floor", "hit-test"] });
        this.passthrough = true;
      }
    } catch {
      session = null;
    }
    if (!session) session = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor"] });
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
    renderer.getClearColor(this.clear.color);
    this.clear.alpha = renderer.getClearAlpha();
    if (this.passthrough) {
      this.room.background = null;
      renderer.setClearColor(0x000000, 0);
    } else this.room.background = scene.background instanceof Color ? scene.background.clone() : new Color(0x2b2d31);
    // The page's scene is z up in millimetres; the room is y up in metres.
    this.holder.add(scene, this.shadow);
    scene.rotation.set(-Math.PI / 2, 0, 0);
    this.measure();
    // Real size, unless it's bigger than a room (then about half a metre).
    this.holder.scale.setScalar(this.size * REAL > 2.5 ? 0.5 / this.size : REAL);
    this.holder.quaternion.identity();
    this.holder.position.set(0, -100, 0);
    this.placed = false;
    this.needsFirstPlace = true;
    this.host.onEnter();
    for (const i of [0, 1]) this.addHand(i);
    session.addEventListener("end", () => this.leave());
    this.last = 0;
    renderer.setAnimationLoop((t: number, frame?: XRFrame) => this.frame(t, frame));
  }

  exit(): void {
    void this.session?.end();
  }

  private get real(): boolean {
    return Math.abs(this.holder.scale.x / REAL - 1) < 1e-3;
  }

  /** The wheel's buttons. */
  private items(): VRItem[] {
    const looks = this.host.looks();
    return [
      { label: "Real size", icon: "ruler", disabled: this.real, run: () => this.resize(REAL) },
      { label: "Hand size", icon: "scale", run: () => this.resize(0.25 / this.size) },
      { label: "Bring here", icon: "fit", run: () => this.bringHere() },
      { label: looks.xray, icon: "display", run: () => this.say(this.host.xray()) },
      { label: looks.edges, icon: looks.edges.startsWith("Hide") ? "eyeOff" : "eye", run: () => this.say(this.host.edges()) },
      { label: "Exit", icon: "exit", run: () => this.exit() },
    ];
  }

  /** The model's bottom middle and size, from what's shown now. */
  private measure(): void {
    const b = this.host.bounds();
    const min = b?.min ?? [-50, -50, 0];
    const max = b?.max ?? [50, 50, 100];
    this.size = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
    // z up (the page) to y up (the room): (x, y, z) -> (x, z, -y).
    this.base.set((min[0] + max[0]) / 2, min[2], -(min[1] + max[1]) / 2);
    this.shadow.scale.set(Math.max(1, (max[0] - min[0]) * 1.5), 1, Math.max(1, (max[1] - min[1]) * 1.5));
    this.shadow.position.set(this.base.x, this.base.y + 0.2, this.base.z);
  }

  /** Where the model's bottom middle is in the room. */
  private baseInRoom(): Vector3 {
    this.holder.updateMatrix();
    return this.base.clone().applyMatrix4(this.holder.matrix);
  }

  /** Stand the model upright with its bottom middle at `at`, its front toward `face` (gliding there). */
  private putAt(at: Vector3, face: Vector3, glide = true): void {
    const yaw = Math.atan2(face.x - at.x, face.z - at.z);
    const q = new Quaternion().setFromEuler(new Euler(0, yaw, 0));
    const s = this.holder.scale.x;
    const to = at.clone().sub(this.base.clone().multiplyScalar(s).applyQuaternion(q));
    if (glide) this.glide = { from: this.holder.position.clone(), to, qFrom: this.holder.quaternion.clone(), qTo: q, t0: performance.now() };
    else {
      this.glide = null;
      this.holder.position.copy(to);
      this.holder.quaternion.copy(q);
    }
  }

  /** In front of you: at table height if it's small, on the floor if it's big. */
  private bringHere(glide = true): void {
    const cam = this.host.renderer.xr.getCamera();
    const head = new Vector3().setFromMatrixPosition(cam.matrixWorld);
    const look = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(cam.matrixWorld));
    look.y = 0;
    if (look.lengthSq() < 1e-6) look.set(0, 0, -1);
    look.normalize();
    const big = this.size * this.holder.scale.x;
    const at = head.clone().addScaledVector(look, Math.max(0.55, 0.35 + big * 0.7));
    at.y = big > 0.9 ? 0 : Math.max(0, head.y - 0.55);
    this.putAt(at, head, glide);
    this.placed = at.y === 0;
  }

  /** A new size, keeping the model's bottom middle where it is. */
  private resize(s: number, say?: string): void {
    const keep = this.baseInRoom();
    this.holder.scale.setScalar(s);
    this.holder.position.add(keep.sub(this.baseInRoom()));
    if (this.glide) this.glide = null;
    if (say) this.say(say);
  }

  private addHand(i: number): void {
    const ray = this.host.renderer.xr.getController(i);
    const line = new Line(new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -1)]), new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    line.scale.z = 2;
    ray.add(line);
    const wheel = new Wheel();
    ray.add(wheel.board.mesh);
    this.room.add(ray);
    const hand: Hand = { side: i === 0 ? "right" : "left", ray, line, wheel, squeezing: false, grabFrom: null, was: [false, false], heldSince: 0, hits: null, asked: null };
    // The card rides above the right hand, the scale above the left (which hand is which comes with the controller).
    const placeCard = () => {
      if (hand.side === "right") {
        ray.add(this.card.mesh);
        this.card.mesh.position.set(0, 0.06, -0.1);
        this.card.mesh.rotation.x = -0.6;
      } else {
        ray.add(this.tape.board.mesh);
        this.tape.board.mesh.position.set(0, 0.06, -0.07);
        this.tape.board.mesh.rotation.x = -0.6;
      }
    };
    ray.addEventListener("connected", (e) => {
      const src = (e as unknown as { data?: XRInputSource }).data;
      if (src?.handedness === "left" || src?.handedness === "right") hand.side = src.handedness;
      placeCard();
    });
    ray.addEventListener("disconnected", () => {
      hand.hits?.cancel();
      hand.hits = null;
      hand.asked = null;
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

  /** The trigger: a button of the open wheel, else put the model down where the ring is. */
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
    if (hand.side !== "right" || !this.reticle.visible) return;
    const head = new Vector3().setFromMatrixPosition(this.host.renderer.xr.getCamera().matrixWorld);
    this.putAt(this.reticle.position.clone(), head);
    this.placed = true;
    this.buzz(hand, 0.4, 30);
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
    if (item && !item.disabled) item.run();
  }

  private startGrab(): void {
    const held = this.hands.filter((h) => h.squeezing);
    this.glide = null;
    this.holder.updateMatrix();
    this.grabStart = this.holder.matrix.clone();
    for (const h of this.hands) h.grabFrom = h.squeezing ? h.ray.matrixWorld.clone() : null;
    this.pinch = held.length === 2 ? { d0: held[0].ray.position.distanceTo(held[1].ray.position), s0: this.holder.scale.x, snapped: false } : null;
    if (held.length) this.placed = false;
  }

  private rayOf(hand: Hand): { o: Vector3; d: Vector3 } {
    hand.ray.updateMatrixWorld();
    const o = new Vector3().setFromMatrixPosition(hand.ray.matrixWorld);
    const d = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(hand.ray.matrixWorld)).normalize();
    return { o, d };
  }

  private buzz(hand: Hand, strength: number, ms: number): void {
    const src = [...(this.session?.inputSources ?? [])].find((s) => s.handedness === hand.side);
    const act = (src?.gamepad as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): void }[] }) | undefined)?.hapticActuators?.[0];
    act?.pulse(strength, ms);
  }

  private say(text: string): void {
    if (text) this.toast = { text, until: performance.now() + 1500 };
  }

  private frame(t: number, frame?: XRFrame): void {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    // The first frame knows where your head is: the model goes in front of you.
    if (this.needsFirstPlace && frame) {
      const space = this.host.renderer.xr.getReferenceSpace();
      const pose = space ? frame.getViewerPose(space) : null;
      if (pose) {
        const cam = this.host.renderer.xr.getCamera();
        cam.matrixWorld.fromArray(pose.transform.matrix);
        this.bringHere(false);
        this.needsFirstPlace = false;
      }
    }
    if (this.glide) {
      const k = Math.min(1, (performance.now() - this.glide.t0) / 260);
      const e = 1 - Math.pow(1 - k, 3);
      this.holder.position.lerpVectors(this.glide.from, this.glide.to, e);
      this.holder.quaternion.slerpQuaternions(this.glide.qFrom, this.glide.qTo, e);
      if (k >= 1) this.glide = null;
    }
    const held = this.hands.filter((h) => h.squeezing);
    if (held.length === 1 && this.grabStart && held[0].grabFrom) {
      const m = held[0].ray.matrixWorld.clone().multiply(held[0].grabFrom.clone().invert()).multiply(this.grabStart);
      m.decompose(this.holder.position, this.holder.quaternion, this.holder.scale);
    } else if (held.length === 2 && this.pinch && this.pinch.d0 > 1e-3) {
      const d = held[0].ray.position.distanceTo(held[1].ray.position);
      let s = this.pinch.s0 * (d / this.pinch.d0);
      // Real size holds for a moment on the way (a little click in the hands).
      const near = Math.abs(s / REAL - 1) < 0.07;
      if (near) s = REAL;
      if (near && !this.pinch.snapped) for (const h of held) this.buzz(h, 0.5, 30);
      this.pinch.snapped = near;
      if (s !== this.holder.scale.x) this.resize(s);
    }
    for (const src of this.session?.inputSources ?? []) {
      const hand = this.hands.find((h) => h.side === src.handedness);
      if (!hand) continue;
      if (hand.asked !== src) this.askScan(hand, src);
      if (src.gamepad) this.buttons(hand, src.gamepad, t, dt);
    }
    this.aim(frame);
    this.shadow.visible = this.placed && !held.length;
    this.drawCard();
    this.tape.draw(this.holder.scale.x / REAL);
    this.host.beforeFrame();
    this.host.renderer.render(this.room, this.host.renderer.xr.getCamera());
  }

  /** The headset's own scan of the room (tables, floor) along this hand's ray, when it offers that. */
  private askScan(hand: Hand, src: XRInputSource): void {
    hand.asked = src;
    const s = this.session as (XRSession & { requestHitTestSource?(o: { space: XRSpace }): Promise<XRHitTestSource> | undefined }) | null;
    s?.requestHitTestSource?.({ space: src.targetRaySpace })
      ?.then((h) => {
        if (hand.asked !== src || !this.session) return void h.cancel();
        hand.hits?.cancel();
        hand.hits = h;
      })
      .catch(() => {});
  }

  /** One hand's buttons and stick this frame. */
  private buttons(hand: Hand, pad: Gamepad, t: number, dt: number): void {
    const sx = pad.axes[2] ?? 0;
    const sy = pad.axes[3] ?? 0;
    const ax = !!pad.buttons[4]?.pressed;
    const by = !!pad.buttons[5]?.pressed;
    if (hand.side === "left") {
      // X held: the wheel opens; the stick chooses; letting go runs it. A tap: bring it here.
      if (ax && !hand.was[0]) hand.heldSince = t;
      if (ax && !hand.wheel.open && t - hand.heldSince > 140) {
        hand.wheel.items = this.items();
        hand.wheel.title = "View";
        hand.wheel.hot = -1;
        hand.wheel.board.mesh.visible = true;
        this.tape.board.mesh.visible = false;
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
        const item = hand.wheel.open ? hand.wheel.items[hand.wheel.hot] : undefined;
        hand.wheel.board.mesh.visible = false;
        this.tape.board.mesh.visible = true;
        if (item) this.run(item);
        else if (t - hand.heldSince < 300) this.bringHere();
      }
      // Y: X-Ray on / off.
      if (by && !hand.was[1]) this.say(this.host.xray());
      if (!hand.wheel.open && Math.abs(sy) > 0.15) {
        this.glide = null;
        this.holder.position.y -= sy * 0.5 * dt;
        this.placed = false;
      }
    } else {
      // A: real size or hand size. B: back in front of you.
      if (ax && !hand.was[0]) {
        this.resize(this.real ? 0.25 / this.size : REAL);
      }
      if (by && !hand.was[1]) this.bringHere();
      // Stick: left / right turns it about its middle, up / down sizes it.
      if (Math.abs(sx) > 0.2 && Math.abs(sx) > Math.abs(sy)) {
        this.glide = null;
        const keep = this.baseInRoom();
        this.holder.quaternion.premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -sx * 1.6 * dt));
        this.holder.position.add(keep.sub(this.baseInRoom()));
      } else if (Math.abs(sy) > 0.2 && !this.stickHeld) {
        // Up: bigger, down: smaller; it stops at real size on the way (let go and push again to go on).
        const s = this.holder.scale.x;
        let next = s * Math.pow(2, -sy * dt);
        if (!this.real && (s - REAL) * (next - REAL) <= 0) {
          next = REAL;
          this.stickHeld = true;
          this.buzz(hand, 0.5, 30);
        }
        this.resize(next);
      } else if (Math.abs(sy) < 0.15) this.stickHeld = false;
    }
    hand.was = [ax, by];
  }

  /** The ring where the right hand points: a table or the floor (only things that face up). */
  private aim(frame?: XRFrame): void {
    const hand = this.hands.find((h) => h.side === "right");
    if (!hand) return;
    const { o, d } = this.rayOf(hand);
    let at: Vector3 | null = null;
    const space = this.host.renderer.xr.getReferenceSpace();
    if (frame && hand.hits && space) {
      for (const r of frame.getHitTestResults(hand.hits)) {
        const pose = r.getPose(space);
        if (!pose) continue;
        const q = pose.transform.orientation;
        const up = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
        if (up.y < 0.8) continue;
        const p = pose.transform.position;
        at = new Vector3(p.x, p.y, p.z);
        break;
      }
    }
    // No room scan (or none there yet): the floor.
    if (!at && d.y < -0.05) at = o.clone().addScaledVector(d, -o.y / d.y);
    if (at && at.distanceTo(o) > 8) at = null;
    this.reticle.visible = !!at && !this.hands.some((h) => h.wheel.open || h.squeezing);
    if (at) this.reticle.position.set(at.x, at.y + 0.002, at.z);
    hand.line.scale.z = at ? Math.max(0.02, at.distanceTo(o)) : 2;
  }

  /** The card: a short message for a moment. */
  private drawCard(): void {
    const toast = this.toast && performance.now() < this.toast.until ? this.toast.text : "";
    if (toast === this.cardKey) return;
    this.cardKey = toast;
    this.card.mesh.visible = !!toast;
    if (!toast) return;
    const g = this.card.clear();
    g.fillStyle = GLASS;
    g.beginPath();
    g.roundRect(4, 4, 632, 192, 44);
    g.fill();
    g.strokeStyle = LINE;
    g.lineWidth = 3;
    g.stroke();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#fff";
    g.font = `600 52px ${FONT}`;
    wrap(g, toast, 320, 100, 560, 58);
    this.card.show();
  }

  private leave(): void {
    const { renderer, scene } = this.host;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    renderer.setClearColor(this.clear.color, this.clear.alpha);
    for (const h of this.hands) {
      h.hits?.cancel();
      h.asked = null;
      h.ray.removeFromParent();
      h.line.geometry.dispose();
    }
    this.hands = [];
    this.grabStart = null;
    this.pinch = null;
    this.glide = null;
    this.toast = null;
    this.cardKey = "";
    this.card.mesh.removeFromParent();
    this.tape.board.mesh.removeFromParent();
    this.tape.reset();
    this.stickHeld = false;
    this.shadow.removeFromParent();
    scene.removeFromParent();
    scene.rotation.set(0, 0, 0);
    scene.updateMatrixWorld(true);
    this.session = null;
    this.host.onExit();
  }
}

/** A soft round shadow (dark in the middle, gone at the edge). */
function shadowTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(0,0,0,0.42)");
  r.addColorStop(0.55, "rgba(0,0,0,0.22)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}
