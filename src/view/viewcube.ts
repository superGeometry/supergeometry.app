import { icons } from "../ui/icons";
import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  DirectionalLight,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Vec3 } from "../doc/types";
import type { Viewport } from "./viewport";

const PX = 110;

interface FaceDef {
  label: string;
  n: Vec3;
  /** Screen-right and screen-up directions when looking at the face (Z-up world). */
  u: Vec3;
  up: Vec3;
}

const FACES: FaceDef[] = [
  { label: "TOP", n: [0, 0, 1], u: [1, 0, 0], up: [0, 1, 0] },
  { label: "BOTTOM", n: [0, 0, -1], u: [1, 0, 0], up: [0, -1, 0] },
  { label: "FRONT", n: [0, -1, 0], u: [1, 0, 0], up: [0, 0, 1] },
  { label: "BACK", n: [0, 1, 0], u: [-1, 0, 0], up: [0, 0, 1] },
  { label: "RIGHT", n: [1, 0, 0], u: [0, 1, 0], up: [0, 0, 1] },
  { label: "LEFT", n: [-1, 0, 0], u: [0, -1, 0], up: [0, 0, 1] },
];

/**
 * View cube rendered with its own tiny three.js scene, rotated with the main
 * camera. Click a face, edge or corner (26 zones) to look from there; drag to orbit.
 */
export class ViewCube {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(-1.05, 1.05, 1.05, -1.05, 0.1, 10);
  private faces: Mesh[] = [];
  /** The zone under the pointer, lit on every face it's on (an edge: two, a corner: three) - one button. */
  private hovers = [0, 1, 2].map(() => new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.5, depthTest: false })));
  private raycaster = new Raycaster();
  private lastKey = "";
  private dragged = false;

  constructor(private view: Viewport) {
    this.el = document.createElement("div");
    this.el.id = "viewcube";
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = this.canvas.style.height = `${PX}px`;
    this.el.append(this.canvas);
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    // Drawn at least twice its size and scaled down: smooth edges and lettering
    // on every screen (it was jagged at 1×).
    this.renderer.setPixelRatio(Math.min(3, Math.max(2, window.devicePixelRatio * 1.5)));
    this.renderer.setSize(PX, PX, false);

    const cube = new Group();
    const aniso = this.renderer.capabilities.getMaxAnisotropy();
    for (const f of FACES) {
      const map = labelTexture(f.label);
      map.anisotropy = aniso;
      const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshLambertMaterial({ map }));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(basis(f.u, f.up, f.n).setPosition(new Vector3(...f.n).multiplyScalar(0.5)));
      cube.add(mesh);
      this.faces.push(mesh);
    }
    // Small world axes at the cube's corner.
    for (const [d, c] of [[[1, 0, 0], 0xe0584f], [[0, 1, 0], 0x5fbf5a], [[0, 0, 1], 0x4f8ce0]] as [Vec3, number][]) {
      const g = new BoxGeometry(d[0] ? 0.55 : 0.025, d[1] ? 0.55 : 0.025, d[2] ? 0.55 : 0.025);
      const m = new Mesh(g, new MeshBasicMaterial({ color: c }));
      m.position.set(-0.5 + d[0] * 0.275, -0.5 + d[1] * 0.275, -0.5 + d[2] * 0.275);
      cube.add(m);
    }
    for (const h of this.hovers) {
      h.visible = false;
      h.matrixAutoUpdate = false;
      h.renderOrder = 5;
    }
    // Soft light: the sides a little darker than the face turned to you, like the panels' greys.
    this.scene.add(cube, ...this.hovers, new AmbientLight(0xffffff, 2.1));
    const light = new DirectionalLight(0xffffff, 0.75);
    light.position.set(0.5, -1, 2);
    this.camera.add(light);
    this.scene.add(this.camera);

    const rollL = button("⟲", "Rotate view 90° left", () => view.cam.rollBy(Math.PI / 2));
    const rollR = button("⟳", "Rotate view 90° right", () => view.cam.rollBy(-Math.PI / 2));
    rollL.className = "vc-roll left";
    rollR.className = "vc-roll right";
    // Drawn icons, the same size and weight as the orbit-centre and views buttons below the cube.
    rollL.innerHTML = icons.undo;
    rollR.innerHTML = icons.redo;
    this.el.append(rollL, rollR);
    this.wire();
    view.frameHooks.add(() => this.render());
  }

  private wire(): void {
    let last: { x: number; y: number } | null = null;
    this.canvas.addEventListener("pointerdown", (e) => {
      last = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (last) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        if (Math.abs(dx) + Math.abs(dy) > 1) this.dragged = true;
        if (this.dragged) {
          this.view.cam.orbit(dx * 2, dy * 2);
          this.view.requestRender();
        }
        last = { x: e.clientX, y: e.clientY };
        return;
      }
      this.setHover(this.zoneAt(e));
    });
    this.canvas.addEventListener("pointerleave", () => this.setHover(null));
    this.canvas.addEventListener("pointerup", (e) => {
      last = null;
      if (this.dragged) return;
      const zone = this.zoneAt(e);
      if (!zone) return;
      const face = FACES.find((f) => f.n.every((v, i) => v === zone[i]));
      const n = new Vector3(...zone).normalize().toArray() as Vec3;
      // Faces get an upright view; edges/corners keep the current spin.
      this.view.cam.lookAlong(n, face?.u);
      this.view.requestRender();
    });
  }

  /** Zone under the pointer as a vector of -1/0/1 per axis (face, edge or corner). */
  private zoneAt(e: PointerEvent): Vec3 | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.faces, false)[0];
    if (!hit) return null;
    const p = hit.point;
    // Matches the texture: outer 0.2 of each face is an edge/corner band.
    const z = (v: number) => (v > 0.3 ? 1 : v < -0.3 ? -1 : 0);
    return [z(p.x), z(p.y), z(p.z)];
  }

  private setHover(zone: Vec3 | null): void {
    this.canvas.style.cursor = zone ? "pointer" : "grab";
    // A tile on each face the zone touches: a face's middle, both halves of an
    // edge, all three squares of a corner - they're one button, so they light together.
    const on = zone ? [0, 1, 2].filter((k) => zone[k] !== 0) : [];
    this.hovers.forEach((h, j) => {
      const k = on[j];
      h.visible = k !== undefined;
      if (k === undefined || !zone) return;
      const f = FACES.find((x) => x.n[k] === zone[k])!;
      // Matches zoneAt(): the middle 0.6 of each axis is "face", the outer 0.2 "edge".
      const size = new Vector3(...[0, 1, 2].map((i) => (zone[i] === 0 ? 0.6 : 0.2)));
      const center = new Vector3(...zone).multiplyScalar(0.4);
      center.setComponent(k, zone[k] * 0.502);
      const su = Math.abs(new Vector3(...f.u).dot(size));
      const sv = Math.abs(new Vector3(...f.up).dot(size));
      h.matrix.copy(basis(f.u, f.up, f.n).multiply(new Matrix4().makeScale(su, sv, 1)).setPosition(center));
    });
    this.lastKey = "";
  }

  private render(): void {
    const main = this.view.camera;
    const key = main.quaternion.toArray().map((x) => x.toFixed(4)).join() + this.hovers.map((h) => (h.visible ? h.matrix.elements.slice(12, 15).join() : "-")).join();
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.camera.quaternion.copy(main.quaternion);
    this.camera.position.set(0, 0, 3).applyQuaternion(main.quaternion);
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
  }
}

function basis(u: Vec3, up: Vec3, n: Vec3): Matrix4 {
  return new Matrix4().makeBasis(new Vector3(...u), new Vector3(...up), new Vector3(...n));
}

/** A face of the cube in the app's greys and lettering, drawn large (sharp when scaled down). */
function labelTexture(text: string): CanvasTexture {
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  // The face: the panels' grey, a slightly lighter rim where the faces meet.
  g.fillStyle = "#3a3e46";
  g.fillRect(0, 0, S, S);
  g.fillStyle = "#454a54";
  const rim = S * 0.035;
  g.beginPath();
  // (Older browsers have no roundRect: a square one then.)
  if (g.roundRect) g.roundRect(rim, rim, S - 2 * rim, S - 2 * rim, S * 0.06);
  else g.rect(rim, rim, S - 2 * rim, S - 2 * rim);
  g.fill();
  // Zone borders (faint): the middle is the face view, the bands edges (45°), the corners iso views.
  g.strokeStyle = "rgba(255, 255, 255, 0.07)";
  g.lineWidth = S * 0.008;
  for (const v of [0.2 * S, 0.8 * S]) {
    g.beginPath();
    g.moveTo(v, rim);
    g.lineTo(v, S - rim);
    g.moveTo(rim, v);
    g.lineTo(S - rim, v);
    g.stroke();
  }
  // The outline where the faces meet: the line colour of the panels.
  g.strokeStyle = "rgba(255, 255, 255, 0.16)";
  g.lineWidth = S * 0.012;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, S - g.lineWidth, S - g.lineWidth);
  g.fillStyle = "#e8e9ec";
  g.font = `650 ${Math.round(S * (text.length > 5 ? 0.15 : 0.17))}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, S / 2, S * 0.515);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function button(text: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}
