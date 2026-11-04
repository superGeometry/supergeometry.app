import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  DirectionalLight,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
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
  private hover = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: 0x3d8bff, transparent: true, opacity: 0.55, depthTest: false }));
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(PX, PX, false);

    const cube = new Group();
    for (const f of FACES) {
      const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshLambertMaterial({ map: labelTexture(f.label) }));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(basis(f.u, f.up, f.n).setPosition(new Vector3(...f.n).multiplyScalar(0.5)));
      cube.add(mesh);
      this.faces.push(mesh);
    }
    const edges = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), new LineBasicMaterial({ color: 0x8b93a3 }));
    cube.add(edges);
    // Small world axes at the cube's corner.
    for (const [d, c] of [[[1, 0, 0], 0xe0584f], [[0, 1, 0], 0x5fbf5a], [[0, 0, 1], 0x4f8ce0]] as [Vec3, number][]) {
      const g = new BoxGeometry(d[0] ? 0.55 : 0.025, d[1] ? 0.55 : 0.025, d[2] ? 0.55 : 0.025);
      const m = new Mesh(g, new MeshBasicMaterial({ color: c }));
      m.position.set(-0.5 + d[0] * 0.275, -0.5 + d[1] * 0.275, -0.5 + d[2] * 0.275);
      cube.add(m);
    }
    this.hover.visible = false;
    this.hover.matrixAutoUpdate = false;
    this.hover.renderOrder = 5;
    this.scene.add(cube, this.hover, new AmbientLight(0xffffff, 1.6));
    const light = new DirectionalLight(0xffffff, 1.2);
    light.position.set(0.5, -1, 2);
    this.camera.add(light);
    this.scene.add(this.camera);

    const rollL = button("⟲", "Rotate view 90° left", () => view.cam.rollBy(Math.PI / 2));
    const rollR = button("⟳", "Rotate view 90° right", () => view.cam.rollBy(-Math.PI / 2));
    rollL.className = "vc-roll left";
    rollR.className = "vc-roll right";
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
    this.hover.visible = !!zone;
    this.canvas.style.cursor = zone ? "pointer" : "grab";
    if (zone) {
      // A small tile at the zone, on the face of the axis with a ±1 that faces us most.
      const n = new Vector3(...zone);
      const dir = new Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
      const axes = [0, 1, 2].filter((i) => zone[i] !== 0).sort((a, b) => Math.abs(dir.getComponent(b)) - Math.abs(dir.getComponent(a)));
      const k = axes[0];
      const f = FACES.find((x) => x.n[k] === zone[k])!;
      // Matches zoneAt(): the middle 0.6 of each axis is "face", the outer 0.2 "edge".
      const size = [0, 1, 2].map((i) => (zone[i] === 0 ? 0.6 : 0.2));
      const center = n.clone().multiplyScalar(0.4);
      center.setComponent(k, zone[k] * 0.502);
      const u = new Vector3(...f.u);
      const up = new Vector3(...f.up);
      const su = Math.abs(u.dot(new Vector3(size[0], size[1], size[2])));
      const sv = Math.abs(up.dot(new Vector3(size[0], size[1], size[2])));
      this.hover.matrix.copy(basis(f.u, f.up, f.n).multiply(new Matrix4().makeScale(su, sv, 1)).setPosition(center));
    }
    this.lastKey = "";
  }

  private render(): void {
    const main = this.view.camera;
    const key = main.quaternion.toArray().map((x) => x.toFixed(4)).join() + this.hover.visible + this.hover.matrix.elements[12];
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

function labelTexture(text: string): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#4a505c";
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = "#6b7383";
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 122);
  // Zone borders: the middle is the face view, the outer bands edges (45°), the corners iso views.
  g.strokeStyle = "rgba(160, 170, 190, 0.35)";
  g.lineWidth = 2;
  for (const v of [25.6, 102.4]) {
    g.beginPath();
    g.moveTo(v, 0);
    g.lineTo(v, 128);
    g.moveTo(0, v);
    g.lineTo(128, v);
    g.stroke();
  }
  g.fillStyle = "#e9ecf1";
  g.font = `600 ${text.length > 5 ? 22 : 26}px system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 66);
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
