// Immersive VR (WebXR): the model floats in front of you at arm's length.
// Trigger: pick a face (it's selected, as a tap would). Grip: grab the model -
// it moves and turns with the hand; both grips: pull apart / together to size
// it. Left stick up / down: the model goes up / down. Right stick up / down:
// bigger / smaller. B or Y, or the headset's own exit, comes back to the page.
import { BufferGeometry, Color, Group, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, Quaternion, Scene, SphereGeometry, Vector3, type Object3D, type WebGLRenderer, type XRTargetRaySpace } from "three";

type Vec3 = [number, number, number];

export interface XRHost {
  renderer: WebGLRenderer;
  /** The page's scene (z up, millimetres): carried into the headset's room as it is. */
  scene: Scene;
  /** The model's box, in the scene's own units. */
  bounds(): { min: Vec3; max: Vec3 } | null;
  /** What the ray from `origin` along `dir` (the scene's own coordinates) hits first: a face, or nothing. */
  rayPick(origin: Vec3, dir: Vec3): { kind: "face"; body: string; face: number; point: Vec3 } | null;
  /** Something was picked (null: the trigger pointed at nothing). */
  onPick(hit: { kind: "face"; body: string; face: number; point: Vec3 } | null): void;
  /** Before each frame in the headset (the page's own per-frame work). */
  beforeFrame(): void;
  /** Into the headset. */
  onEnter(): void;
  /** Back on the page. */
  onExit(): void;
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

export class VRMode {
  private room = new Scene();
  /** Holds the page's scene: placed, turned and sized in the room. */
  private holder = new Group();
  private hands: { ray: XRTargetRaySpace; line: Line; squeezing: boolean; grabFrom: Matrix4 | null }[] = [];
  private grabStart: Matrix4 | null = null;
  private pinch: { d0: number; s0: number } | null = null;
  private session: XRSession | null = null;
  /** The last frame's time (ms): the sticks move by time, not by frame. */
  private last = 0;
  private dot = new Mesh(new SphereGeometry(0.006, 12, 8), new MeshBasicMaterial({ color: 0x4f8cff }));

  constructor(private host: XRHost) {
    this.room.add(this.holder, this.dot);
    this.dot.visible = false;
  }

  get active(): boolean {
    return !!this.session;
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
  private place(): void {
    const b = this.host.bounds();
    const min = b?.min ?? [-50, -50, -50];
    const max = b?.max ?? [50, 50, 50];
    const size = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
    const k = 0.4 / size;
    const mid = new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    // Where the middle lands once turned y up and scaled.
    const turned = mid.clone().applyEuler(this.host.scene.rotation).multiplyScalar(k);
    this.holder.scale.setScalar(k);
    this.holder.quaternion.identity();
    this.holder.position.set(-turned.x, 1.1 - turned.y, -0.5 - turned.z);
  }

  private addHand(i: number): void {
    const ray = this.host.renderer.xr.getController(i);
    const line = new Line(new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -1)]), new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    line.scale.z = 2;
    ray.add(line);
    this.room.add(ray);
    const hand = { ray, line, squeezing: false, grabFrom: null as Matrix4 | null };
    this.hands.push(hand);
    ray.addEventListener("selectstart", () => this.host.onPick(this.cast(ray)?.hit ?? null));
    ray.addEventListener("squeezestart", () => {
      hand.squeezing = true;
      this.startGrab();
    });
    ray.addEventListener("squeezeend", () => {
      hand.squeezing = false;
      this.startGrab();
    });
  }

  /** (Re)start a grab from where the hands and the model are now. */
  private startGrab(): void {
    const held = this.hands.filter((h) => h.squeezing);
    this.grabStart = this.holder.matrix.clone();
    for (const h of this.hands) h.grabFrom = h.squeezing ? h.ray.matrixWorld.clone() : null;
    this.pinch = held.length === 2 ? { d0: held[0].ray.position.distanceTo(held[1].ray.position), s0: this.holder.scale.x } : null;
  }

  private cast(ray: Object3D): { hit: NonNullable<ReturnType<XRHost["rayPick"]>>; at: Vector3 } | null {
    ray.updateMatrixWorld();
    const o = new Vector3().setFromMatrixPosition(ray.matrixWorld);
    const d = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(ray.matrixWorld)).normalize();
    // Into the page scene's own coordinates.
    const inv = this.host.scene.matrixWorld.clone().invert();
    const lo = o.clone().applyMatrix4(inv);
    const ld = o.clone().add(d).applyMatrix4(inv).sub(lo).normalize();
    const hit = this.host.rayPick(lo.toArray() as Vec3, ld.toArray() as Vec3);
    if (!hit) return null;
    return { hit, at: new Vector3(...hit.point).applyMatrix4(this.host.scene.matrixWorld) };
  }

  private frame(t: number): void {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0;
    this.last = t;
    const held = this.hands.filter((h) => h.squeezing);
    if (held.length === 1 && this.grabStart && held[0].grabFrom) {
      // One hand: the model follows it (moves and turns).
      const m = held[0].ray.matrixWorld.clone().multiply(held[0].grabFrom.clone().invert()).multiply(this.grabStart);
      m.decompose(this.holder.position, this.holder.quaternion, this.holder.scale);
    } else if (held.length === 2 && this.pinch && this.pinch.d0 > 1e-3) {
      // Two hands: apart / together sizes it.
      const d = held[0].ray.position.distanceTo(held[1].ray.position);
      this.holder.scale.setScalar(this.pinch.s0 * (d / this.pinch.d0));
    }
    // Sticks (pushed up reads negative): left moves the model up / down (half a metre a
    // second at full tilt), right sizes it (about doubles in a second).
    for (const src of this.session?.inputSources ?? []) {
      const y = src.gamepad?.axes[3] ?? 0;
      if (Math.abs(y) > 0.15) {
        if (src.handedness === "left") this.holder.position.y -= y * 0.5 * dt;
        else this.holder.scale.multiplyScalar(Math.pow(2, -y * dt));
      }
      // B or Y (the upper face button): back to the page.
      if (src.gamepad?.buttons[5]?.pressed) this.exit();
    }
    // Each ray ends where it meets the model; a dot marks the right hand's.
    this.dot.visible = false;
    for (const h of this.hands) {
      const c = this.cast(h.ray);
      h.line.scale.z = c ? Math.max(0.02, c.at.distanceTo(new Vector3().setFromMatrixPosition(h.ray.matrixWorld))) : 2;
      if (c && h === this.hands[0]) (this.dot.position.copy(c.at), (this.dot.visible = true));
    }
    this.host.beforeFrame();
    this.host.renderer.render(this.room, this.host.renderer.xr.getCamera());
  }

  private leave(): void {
    const { renderer, scene } = this.host;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    for (const h of this.hands) (h.ray.removeFromParent(), h.line.geometry.dispose());
    this.hands = [];
    this.grabStart = null;
    this.pinch = null;
    scene.removeFromParent();
    scene.rotation.set(0, 0, 0);
    scene.updateMatrixWorld(true);
    this.session = null;
    this.host.onExit();
  }
}
