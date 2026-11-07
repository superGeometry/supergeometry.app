import { uniqueEnds } from "./corners";
import { isHeadset } from "../device";
import {
  CanvasTexture,
  AmbientLight,
  BackSide,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  FrontSide,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Path,
  Plane,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { ImageFeature, PlaneDef, SketchEntity, SketchFeature, Vec2, Vec3 } from "../doc/types";
import { bodyColor } from "../doc/types";
import { FRONT, GROUND, RIGHT, planeY } from "../geom";
import type { BodyMesh, ConstructionInfo, EdgeInfo, FaceInfo } from "../kernel/protocol";
import { settings } from "../settings";
import { pointsOf } from "../sketch/constraints";
import { entityPolylines } from "../sketch/curves";
import { arrangement } from "../sketch/regions";
import { CameraController, type Insets } from "./camera";
import { AdaptiveGrid } from "./grid";

export type PickHit =
  | { kind: "face"; body: string; face: number; point: Vec3 }
  | { kind: "edge"; body: string; edge: number; point: Vec3 }
  | { kind: "vertex"; body: string; vertex: number; point: Vec3 }
  | { kind: "profile"; sketch: string; region: number; point: Vec3 }
  | { kind: "curve"; sketch: string; entity: string; point: Vec3 }
  | { kind: "point"; sketch: string; entity: string; p: string; point: Vec3 }
  | { kind: "image"; id: string; point: Vec3 }
  | { kind: "plane"; id: string; point: Vec3 }
  | { kind: "axis"; id: string; point: Vec3 };

export type Highlight =
  | { kind: "face"; body: string; face: number }
  | { kind: "edge"; body: string; edge: number }
  | { kind: "vertex"; body: string; vertex: number }
  | { kind: "body"; body: string }
  | { kind: "profile"; sketch: string; region: number }
  | { kind: "curve"; sketch: string; entity: string }
  | { kind: "point"; sketch: string; entity: string; p: string }
  | { kind: "image"; id: string }
  | { kind: "plane"; id: string }
  | { kind: "axis"; id: string };

const WORLD_AXIS_DIRS: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** Round dots for points (three.js draws points as squares; squares are kept for midpoints). */
let dotTexture: CanvasTexture | null = null;
export function dotMaterial(opts: { color: number; size: number; depthTest?: boolean; opacity?: number }): PointsMaterial {
  if (!dotTexture) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(32, 32, 30, 0, Math.PI * 2);
    g.fill();
    dotTexture = new CanvasTexture(c);
  }
  return new PointsMaterial({ color: opts.color, size: opts.size, sizeAttenuation: false, depthTest: opts.depthTest ?? false, map: dotTexture, alphaTest: 0.5, transparent: true, opacity: opts.opacity ?? 1 });
}

export interface PickOptions {
  edgeTolPx?: number;
  profiles?: boolean;
  bodies?: boolean;
  edges?: boolean;
  curves?: boolean | string;
  planes?: boolean;
  axes?: boolean;
  /** The world X/Y/Z axes count as axes (ids "X", "Y", "Z") — for axis/direction slots. */
  worldAxes?: boolean;
  vertices?: boolean;
  images?: boolean;
  /** Planes win even when a body is in front (picking a sketch/section plane). */
  planesFirst?: boolean;
}

/** A sketch as drawn: its own curves plus the face outline it sits on (if any). */
export type SketchView = SketchFeature & { boundary?: SketchEntity[] };

/** The three origin planes, addressable like construction planes. */
export const ORIGIN_PLANES: Record<string, PlaneDef> = { XY: GROUND, XZ: FRONT, YZ: RIGHT };

const COLORS = {
  body: 0xb9bec7,
  edge: 0x23262b,
  hover: 0x7fb2ff,
  select: 0x2f7bff,
  sketch: 0xe8e8e8,
  sketchActive: 0xffc23d,
  construction: 0x9aa3b5,
  profile: 0x4d8dff,
  plane: 0x8fb4ff,
  cap: 0xff8fb8,
};

interface BodyView {
  data: BodyMesh;
  mesh: Mesh;
  cap: Mesh;
  edges: LineSegments;
  hidden: LineSegments;
  /** Unique edge endpoints (the body's vertices). */
  vertices: Vector3[];
}

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly cam: CameraController;
  readonly overlay = new Group();
  readonly grid = new AdaptiveGrid();
  /** Called before each render, e.g. to keep handles a constant screen size. */
  readonly frameHooks = new Set<() => void>();
  private bodiesGroup = new Group();
  private sketchGroup = new Group();
  private constructionGroup = new Group();
  private imageGroup = new Group();
  private highlightGroup = new Group();
  private axesGroup: Object3D;
  private bodies = new Map<string, BodyView>();
  private profileMeshes: Mesh[] = [];
  private curveLines: { sketch: string; entity: string; pts: Vector3[] }[] = [];
  private planeMeshes: Mesh[] = [];
  private axisLines: { id: string; a: Vector3; b: Vector3 }[] = [];
  private raycaster = new Raycaster();
  private dirty = true;
  private light = new DirectionalLight(0xffffff, 1.6);
  private lineMaterials: LineMaterial[] = [];
  private sketches: SketchView[] = [];
  /** The construction planes and axes shown (read: listed by name where a tap would pick one). */
  construction: { planes: ConstructionInfo[]; axes: ConstructionInfo[] } = { planes: [], axes: [] };
  private showOriginPlanes = false;
  private clip: Plane | null = null;
  private bodyMat: MeshStandardMaterial;
  private capMat: MeshBasicMaterial;
  private edgeMat: LineBasicMaterial;
  private hiddenMat: LineDashedMaterial;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    // Headsets render the page into a big virtual screen already: full ratio costs frames for no gain.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isHeadset ? 1.25 : 2));
    this.renderer.localClippingEnabled = true;
    this.cam = new CameraController(1);
    this.scene.background = new Color(0x2b2d31);

    this.scene.add(new HemisphereLight(0xffffff, 0x3a3d44, 1.1));
    this.scene.add(new AmbientLight(0xffffff, 0.25));
    this.scene.add(this.light, this.light.target);

    this.bodyMat = new MeshStandardMaterial({ color: COLORS.body, metalness: 0.05, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: FrontSide });
    // Section caps: back faces seen through the cut, drawn flat — reads as a solid cut.
    this.capMat = hatched(new MeshBasicMaterial({ color: COLORS.cap, side: BackSide }));
    this.edgeMat = new LineBasicMaterial({ color: COLORS.edge });
    this.hiddenMat = new LineDashedMaterial({ color: 0x6b7280, dashSize: 2, gapSize: 2, depthTest: false, transparent: true, opacity: 0.7 });

    this.axesGroup = makeAxes();
    this.scene.add(this.grid.mesh, this.axesGroup, this.imageGroup, this.bodiesGroup, this.constructionGroup, this.sketchGroup, this.highlightGroup, this.overlay);

    settings.onChange(() => this.applySettings());
    this.applySettings();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = (t: number) => {
      if (this.cam.tick(t)) this.dirty = true;
      if (this.tickPulse(t)) this.dirty = true;
      if (this.dirty) this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  get width(): number {
    return this.canvas.clientWidth;
  }
  get height(): number {
    return this.canvas.clientHeight;
  }
  get camera() {
    return this.cam.camera;
  }

  requestRender(): void {
    this.dirty = true;
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.cam.setAspect(w / h);
    this.lineMaterials.forEach((m) => m.resolution.set(w, h));
    this.dirty = true;
  }

  private render(): void {
    this.dirty = false;
    const cam = this.camera;
    this.light.position.copy(cam.position).add(new Vector3(0, 0, this.cam.distance * 0.5));
    this.light.target.position.copy(this.cam.target);
    this.grid.update(this.cam.worldPerPixel(this.height), this.cam.target, this.cam.distance, this.cam.camera.position);
    this.layoutOriginPlanes();
    this.frameHooks.forEach((f) => f());
    this.renderer.render(this.scene, cam);
  }

  private applySettings(): void {
    const s = settings.value;
    this.grid.mesh.visible = s.showGrid;
    this.grid.locked = s.gridLocked;
    this.grid.lockedStep = s.gridStep;
    this.axesGroup.visible = s.showAxes;
    this.cam.animate = s.animateCamera;
    this.cam.setOrtho(s.ortho);
    const xray = s.shader === "xray";
    for (const m of this.allBodyMats()) {
      // A see-through body (Transparency) is seen through in every view; while a
      // new solid is being sized from a sketch, everything is a little see-through.
      const o = ((m.userData.opacity as number | undefined) ?? 1) * (this.ghost ? 0.62 : 1);
      const see = xray || o < 1;
      m.transparent = see;
      m.opacity = (xray ? 0.35 : 1) * o;
      m.depthWrite = !see;
      m.side = see ? DoubleSide : FrontSide;
      m.needsUpdate = true;
    }
    this.applyHidden();
  }

  // ---------------------------------------------------------------- bodies

  private openMats: LineMaterial[] = [];

  /** Body colour → its surface and section-cap materials (copies of the shared ones). */
  private colorMats = new Map<string, { body: MeshStandardMaterial; cap: MeshBasicMaterial }>();
  private bodyColors: Record<string, string> = {};
  private bodyOpacity: Record<string, number> = {};

  private matsFor(id: string): { body: MeshStandardMaterial; cap: MeshBasicMaterial } {
    const hex = bodyColor(this.bodyColors[id]);
    const o = this.bodyOpacity[id] ?? 1;
    if (!hex && o >= 1) return { body: this.bodyMat, cap: this.capMat };
    const key = `${hex ?? "base"}|${o}`;
    let m = this.colorMats.get(key);
    if (!m) {
      const body = this.bodyMat.clone();
      if (hex) body.color.set(hex);
      body.userData.opacity = o;
      // The cut face is the body's colour, a little darker, so it reads as the same part.
      const cap = hatched(this.capMat.clone());
      if (hex) cap.color.set(hex).multiplyScalar(0.72);
      m = { body, cap };
      this.colorMats.set(key, m);
    }
    return m;
  }

  /** Every body surface material (shared + coloured), for settings that apply to all. */
  private allBodyMats(): MeshStandardMaterial[] {
    return [this.bodyMat, ...[...this.colorMats.values()].map((m) => m.body)];
  }

  private ghost = false;

  /** Bodies a little see-through (while sizing a new solid, so its sketch shows through). */
  setGhost(on: boolean): void {
    if (this.ghost === on) return;
    this.ghost = on;
    this.applySettings();
    this.requestRender();
  }

  setBodyColors(colors: Record<string, string>, opacity: Record<string, number> = {}): void {
    this.bodyColors = { ...colors };
    this.bodyOpacity = { ...opacity };
    for (const [id, b] of this.bodies) {
      const m = this.matsFor(id);
      b.mesh.material = m.body;
      b.cap.material = m.cap;
    }
    this.applyClip();
    this.applySettings();
  }

  setBodies(meshes: BodyMesh[]): void {
    for (const b of this.bodies.values()) {
      b.mesh.geometry.dispose();
      b.edges.geometry.dispose();
    }
    this.openMats.forEach((m) => this.releaseLineMaterial(m));
    this.openMats = [];
    this.bodies.clear();
    this.bodiesGroup.clear();
    for (const data of meshes) {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(data.positions, 3));
      g.setAttribute("normal", new BufferAttribute(data.normals, 3));
      g.setIndex(new BufferAttribute(data.indices, 1));
      g.computeBoundingSphere();
      const mats = this.matsFor(data.id);
      const mesh = new Mesh(g, mats.body);
      mesh.userData.body = data.id;
      const cap = new Mesh(g, mats.cap);
      const eg = new BufferGeometry();
      eg.setAttribute("position", new BufferAttribute(data.edgePositions, 3));
      const edges = new LineSegments(eg, this.edgeMat);
      const hidden = new LineSegments(eg, this.hiddenMat);
      hidden.computeLineDistances();
      hidden.renderOrder = 5;
      this.bodiesGroup.add(mesh, cap, edges, hidden);
      const vertices = uniqueEnds(data.edges);
      this.bodies.set(data.id, { data, mesh, cap, edges, hidden, vertices });
      // Open (non-watertight) edges stand out in orange.
      if (data.openEdges?.length) {
        const seg: number[] = [];
        for (const i of data.openEdges) {
          const g = data.edgeGroups.find((x) => x.edge === i);
          if (g) seg.push(...Array.from(data.edgePositions.slice(g.start * 3, (g.start + g.count) * 3)));
        }
        if (seg.length) {
          const mat = this.lineMaterial(0xff9a3d, 3, true);
          this.openMats.push(mat);
          const l = new LineSegments2(new LineSegmentsGeometry().setPositions(seg), mat);
          l.renderOrder = 3;
          this.bodiesGroup.add(l);
        }
      }
    }
    this.applyClip();
    this.applySettings();
    this.applyHidden();
  }

  // ------------------------------------------------------- hidden/isolate

  private hiddenIds = new Set<string>();

  /** Bodies hidden from Items or by Isolate: not drawn, not pickable. */
  setHidden(ids: Iterable<string>): void {
    this.hiddenIds = new Set(ids);
    this.applyHidden();
  }

  isHidden(id: string): boolean {
    return this.hiddenIds.has(id);
  }

  private applyHidden(): void {
    for (const [id, b] of this.bodies) {
      const vis = !this.hiddenIds.has(id);
      b.mesh.visible = vis && settings.value.shader !== "wireframe";
      b.cap.visible = vis && !!this.clip && settings.value.shader === "shaded";
      b.edges.visible = vis && (settings.value.showEdges || settings.value.shader === "wireframe");
      b.hidden.visible = vis && (settings.value.showHiddenEdges || settings.value.shader === "wireframe");
    }
    this.dirty = true;
  }

  private visibleBodies(): BodyView[] {
    return [...this.bodies.entries()].filter(([id]) => !this.hiddenIds.has(id)).map(([, b]) => b);
  }

  vertexOf(body: string, i: number): Vec3 | undefined {
    return this.bodies.get(body)?.vertices[i]?.toArray() as Vec3 | undefined;
  }

  body(id: string): BodyMesh | undefined {
    return this.bodies.get(id)?.data;
  }

  get bodyList(): BodyMesh[] {
    return [...this.bodies.values()].map((b) => b.data);
  }

  /** Zoom to fit everything shown, in the part of the screen the tools leave free. */
  fitAll(animate = true): void {
    this.cam.fit(this.bounds(), animate, this.coveredInsets());
  }

  /**
   * How much of each side of the canvas the tool columns and bars cover: a
   * column hugging the left or right edge, a bar along the top or bottom.
   * Panels that cover most of the screen (History on a phone) don't count —
   * the model would have nowhere left to go.
   */
  coveredInsets(): Insets {
    const W = this.width, H = this.height;
    const cv = this.canvas.getBoundingClientRect();
    const ins = { left: 0, right: 0, top: 0, bottom: 0 };
    if (!W || !H) return ins;
    const cols: DOMRect[] = [];
    for (const id of ["topbar", "toolbar", "right-col", "undo-dock", "bottom-left", "panel", "items", "history"]) {
      const el = document.getElementById(id);
      // (Not offsetParent: it is null for fixed-position bars, which these are.)
      if (!el || el.hidden || !el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const t = r.top - cv.top, b = cv.bottom - r.bottom;
      // A column: clearly taller than wide (a tablet's tool menu is under a quarter of the height).
      const wide = r.width > W * 0.5, tall = r.height > Math.min(H * 0.25, r.width * 1.8);
      // A panel over most of the screen (History on a phone): nowhere left to put the model — ignored.
      if (wide && r.height > H * 0.6) continue;
      if (tall && !wide) cols.push(r);
      // Bars: wide along the top or bottom (a phone's tool card can be tall as well as wide).
      else if (t < H * 0.2 && (wide || r.height < H * 0.12)) ins.top = Math.max(ins.top, (r.bottom - cv.top) / H);
      else if (b < H * 0.2 && wide) ins.bottom = Math.max(ins.bottom, (cv.bottom - r.top) / H);
    }
    // Columns from each edge inwards, side by side: Items, then the tool column
    // just right of it (a phone on its side) all count as the left side.
    let lpx = 0, rpx = 0;
    for (const r of [...cols].sort((a, b) => a.left - b.left)) if (r.left - cv.left <= Math.max(W * 0.04, lpx + 24) && r.right - cv.left < W * 0.65) lpx = Math.max(lpx, r.right - cv.left);
    for (const r of [...cols].sort((a, b) => b.right - a.right)) if (cv.right - r.right <= Math.max(W * 0.04, rpx + 24) && cv.right - r.left < W * 0.65) rpx = Math.max(rpx, cv.right - r.left);
    ins.left = lpx / W;
    ins.right = rpx / W;
    // Never squeeze the model into less than a third of the screen either way
    // (a tablet held upright with Items and the tool menu open leaves ~40 %).
    const cap = (a: number, b: number) => (a + b > 0.65 ? [(a * 0.65) / (a + b), (b * 0.65) / (a + b)] : [a, b]);
    [ins.left, ins.right] = cap(ins.left, ins.right);
    [ins.top, ins.bottom] = cap(ins.top, ins.bottom);
    return ins;
  }

  bounds(): Box3 {
    const box = new Box3();
    // Each part on its own, so one broken piece (NaN) can't spoil the whole fit.
    const add = (o: Object3D) => {
      const b = new Box3().expandByObject(o);
      if (!b.isEmpty() && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every((v) => Number.isFinite(v) && Math.abs(v) < 1e8)) box.union(b);
    };
    for (const b of this.visibleBodies()) add(b.mesh);
    this.sketchGroup.children.forEach(add);
    // Shapes a tool is still making (a freeform cage) count too: Fit framed an empty scene.
    this.overlay.children.forEach((o) => o.userData.fit && o.visible && add(o));
    this.imageMeshes.forEach((m) => m.visible && add(m));
    return box;
  }

  // --------------------------------------------------------------- section

  /** Cut the view with a plane (keeps the side the normal points away from). */
  setSection(plane: PlaneDef | null): void {
    this.clip = plane ? new Plane().setFromNormalAndCoplanarPoint(new Vector3(...plane.normal).negate(), new Vector3(...plane.origin)) : null;
    this.applyClip();
    this.applySettings();
  }

  private applyClip(): void {
    const planes = this.clip ? [this.clip] : [];
    for (const m of [this.bodyMat, this.capMat, this.edgeMat, this.hiddenMat, ...[...this.colorMats.values()].flatMap((c) => [c.body, c.cap])]) {
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
    this.dirty = true;
  }

  // -------------------------------------------------------------- sketches

  private sketchMats: LineMaterial[] = [];
  private sketchPoints: { sketch: string; entity: string; p: string; pos: Vector3 }[] = [];

  setSketches(sketches: SketchView[], activeId?: string): void {
    this.sketches = sketches;
    this.sketchGroup.traverse((o) => {
      if (o instanceof Mesh || o instanceof Line || o instanceof LineSegments2 || o instanceof Points) o.geometry.dispose();
    });
    this.sketchGroup.clear();
    this.sketchMats.forEach((m) => this.releaseLineMaterial(m));
    this.sketchMats = [];
    this.profileMeshes = [];
    this.curveLines = [];
    this.sketchPoints = [];
    const wpp = this.cam.worldPerPixel(this.height);
    for (const s of sketches) {
      const active = s.id === activeId;
      const m = planeMatrix(s.plane, this.cam.distance * 1e-5);
      // Clean 2px lines; the sketch being edited is brighter and on top.
      const solid: number[] = [];
      const dashed: number[] = [];
      for (const e of s.entities) {
        for (const poly of entityPolylines(e)) {
          const pts = poly.map((p) => new Vector3(p[0], p[1], 0).applyMatrix4(m));
          const into = e.construction ? dashed : solid;
          for (let i = 0; i < pts.length - 1; i++) into.push(...pts[i].toArray(), ...pts[i + 1].toArray());
          this.curveLines.push({ sketch: s.id, entity: e.id, pts });
        }
        if (active) for (const q of pointsOf(e)) this.sketchPoints.push({ sketch: s.id, entity: e.id, p: q.p, pos: new Vector3(q.at[0], q.at[1], 0).applyMatrix4(m) });
      }
      if (solid.length) {
        const mat = this.lineMaterial(active ? 0xffffff : COLORS.sketch, active ? 2.2 : 1.6, !active);
        this.sketchMats.push(mat);
        const l = new LineSegments2(new LineSegmentsGeometry().setPositions(solid), mat);
        l.renderOrder = 2;
        this.sketchGroup.add(l);
      }
      if (dashed.length) {
        const mat = this.lineMaterial(COLORS.construction, 1.4, !active);
        mat.dashed = true;
        mat.dashSize = wpp * 6;
        mat.gapSize = wpp * 4;
        this.sketchMats.push(mat);
        const l = new LineSegments2(new LineSegmentsGeometry().setPositions(dashed), mat);
        l.computeLineDistances();
        l.renderOrder = 2;
        this.sketchGroup.add(l);
      }
      if (active && this.sketchPoints.length) {
        const dots = new Points(new BufferGeometry().setFromPoints(this.sketchPoints.map((q) => q.pos)), dotMaterial({ color: 0xffffff, size: 8 }));
        dots.renderOrder = 4;
        this.sketchGroup.add(dots);
      }
      const fillMat = new MeshBasicMaterial({
        color: COLORS.profile,
        transparent: true,
        opacity: active ? 0.16 : 0.1,
        side: DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      // Regions include the face outline, so a line across a face splits it in two.
      for (const r of arrangement([...s.entities, ...(s.boundary ?? [])]).regions) {
        const shape = new Shape(r.outer.poly.map((p) => new Vector2(p[0], p[1])));
        for (const h of r.holes) shape.holes.push(new Path(h.poly.map((p) => new Vector2(p[0], p[1]))));
        const fill = new Mesh(new ShapeGeometry(shape), fillMat);
        fill.applyMatrix4(m);
        fill.userData = { sketch: s.id, region: r.index, area: r.area };
        fill.renderOrder = 1;
        this.sketchGroup.add(fill);
        this.profileMeshes.push(fill);
      }
    }
    this.dirty = true;
  }

  // ------------------------------------------------ construction + images

  setConstruction(planes: ConstructionInfo[], axes: ConstructionInfo[]): void {
    this.construction = { planes, axes };
    this.rebuildPlanes();
  }

  /** Show the XY/XZ/YZ origin planes as pickable squares (sketch/section pick). */
  setOriginPlanesVisible(on: boolean): void {
    this.showOriginPlanes = on;
    this.rebuildPlanes();
  }

  private rebuildPlanes(): void {
    this.constructionGroup.traverse((o) => {
      if (o instanceof Mesh || o instanceof Line) o.geometry.dispose();
    });
    this.constructionGroup.clear();
    this.planeMeshes = [];
    this.axisLines = [];
    // Origin planes (shown only while picking a plane) draw through bodies so they can always be picked.
    const mat = (color: number, o: number, onTop: boolean) => new MeshBasicMaterial({ color, transparent: true, opacity: o, side: DoubleSide, depthWrite: false, depthTest: !onTop });
    // Origin planes take the colour of the axis they face: XY blue (Z), XZ green (Y), YZ red (X).
    const AXIS_TINT: Record<string, number> = { XY: 0x4f8ce0, XZ: 0x5fbf5a, YZ: 0xe0584f };
    const addPlane = (id: string, p: PlaneDef, size: number, origin: boolean) => {
      const color = origin ? (AXIS_TINT[id] ?? COLORS.plane) : COLORS.plane;
      const mesh = new Mesh(new PlaneGeometry(1, 1), mat(color, origin ? 0.35 : 0.16, origin));
      mesh.userData = { plane: id, origin, size };
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(planeMatrix(p).multiply(new Matrix4().makeScale(size, size, 1)));
      // Origin planes (shown only while choosing where to sketch) draw over everything, highlights included.
      mesh.renderOrder = origin ? 60 : 3;
      const border = new LineSegments(
        new BufferGeometry().setFromPoints([[-0.5, -0.5], [0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]].map(([x, y]) => new Vector3(x, y, 0))),
        new LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthTest: !origin }),
      );
      border.renderOrder = mesh.renderOrder;
      mesh.add(border);
      this.constructionGroup.add(mesh);
      this.planeMeshes.push(mesh);
    };
    if (this.showOriginPlanes) for (const [id, p] of Object.entries(ORIGIN_PLANES)) addPlane(id, p, 1, true);
    for (const c of this.construction.planes) addPlane(c.id, c.plane, 1, false);
    for (const a of this.construction.axes) {
      const o = new Vector3(...a.plane.origin);
      const d = new Vector3(...a.plane.normal);
      const L = 1e4;
      const geo = new BufferGeometry().setFromPoints([o.clone().addScaledVector(d, -L), o.clone().addScaledVector(d, L)]);
      const line = new Line(geo, new LineDashedMaterial({ color: 0xffb454, dashSize: 4, gapSize: 3 }));
      line.computeLineDistances();
      this.constructionGroup.add(line);
      this.axisLines.push({ id: a.id, a: o.clone().addScaledVector(d, -L), b: o.clone().addScaledVector(d, L) });
    }
    this.dirty = true;
  }

  private planeSizes = new Map<string, number>();
  private planeCentres = new Map<string, Vec3>();

  /** History hover: what a step works on, as dashed lines seen through everything. */
  private stepGroup = new Group();

  setStepHover(t: { bodies: string[]; lines: Vec3[][] } | null): void {
    this.stepGroup.traverse((o) => {
      if (o instanceof LineSegments || o instanceof Line) {
        o.geometry.dispose();
        (o.material as LineDashedMaterial).dispose();
      }
    });
    this.stepGroup.clear();
    if (t) {
      if (!this.stepGroup.parent) this.scene.add(this.stepGroup);
      const wpp = this.cam.worldPerPixel(this.height);
      const mat = () => new LineDashedMaterial({ color: 0xffa31a, dashSize: wpp * 7, gapSize: wpp * 5, depthTest: false, transparent: true });
      for (const id of t.bodies) {
        const b = this.bodies.get(id);
        if (!b) continue;
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(b.data.edgePositions, 3));
        const ls = new LineSegments(geo, mat());
        ls.computeLineDistances();
        ls.renderOrder = 40;
        this.stepGroup.add(ls);
      }
      for (const pl of t.lines) {
        if (pl.length < 2) continue;
        const ln = new Line(new BufferGeometry().setFromPoints(pl.map((p) => new Vector3(...p))), mat());
        ln.computeLineDistances();
        ln.renderOrder = 40;
        this.stepGroup.add(ln);
      }
    }
    this.requestRender();
  }

  /**
   * On-screen helpers that are alive (handles, gimbals, value boxes, copy
   * toggles). Back in plain selection, any the selection doesn't own are
   * leftovers and get cleared (no ghost arrows or dots).
   */
  readonly helpers = new Set<{ dispose(): void }>();

  clearHelpers(keep: Iterable<unknown>): void {
    const k = new Set(keep);
    for (const h of [...this.helpers]) if (!k.has(h)) h.dispose();
  }

  /** Origin planes stay ~90 px on screen; construction planes keep their first size. */
  private layoutOriginPlanes(): void {
    const wpp = this.cam.worldPerPixel(this.height);
    for (const m of this.planeMeshes) {
      const id = m.userData.plane as string;
      const p = ORIGIN_PLANES[id] ?? this.construction.planes.find((c) => c.id === id)?.plane;
      if (!p) continue;
      // A construction plane keeps the size it was first shown at: it doesn't
      // grow and shrink while the model is edited.
      // Origin planes: big enough to hit easily (fingers, headsets), even with a body in front.
      let size = m.userData.origin ? wpp * 120 : this.planeSizes.get(id);
      let mid = m.userData.origin ? undefined : this.planeCentres.get(id);
      if (size === undefined || (!m.userData.origin && mid === undefined)) {
        const box = this.bounds();
        size = Math.max(wpp * 160, box.getSize(new Vector3()).length() * 0.6);
        this.planeSizes.set(id, size);
        mid = box.isEmpty() ? p.origin : (box.getCenter(new Vector3()).toArray() as Vec3);
        this.planeCentres.set(id, mid);
      }
      // Centred where the middle of the model (as it was) falls on the plane — a
      // plane 92 mm across through a lamp shade 150 mm up was drawn around the
      // floor below it. (Projected each time: the plane may have moved since.)
      let at = p.origin;
      if (mid) {
        const n = new Vector3(...p.normal).normalize();
        const c = new Vector3(...mid);
        at = c.addScaledVector(n, -c.clone().sub(new Vector3(...p.origin)).dot(n)).toArray() as Vec3;
      }
      // Origin planes sit in their quadrant (like a corner), the rest are centred.
      const off = m.userData.origin ? size / 2 : 0;
      const mm = planeMatrix({ ...p, origin: at }).multiply(new Matrix4().makeTranslation(off, off, 0)).multiply(new Matrix4().makeScale(size, size, 1));
      m.matrix.copy(mm);
      m.matrixWorldNeedsUpdate = true;
    }
  }

  planeOf(id: string): PlaneDef | undefined {
    return ORIGIN_PLANES[id] ?? this.construction.planes.find((c) => c.id === id)?.plane;
  }

  axisOf(id: string): ConstructionInfo | undefined {
    const w = WORLD_AXIS_DIRS[id];
    if (w) return { id, name: `${id} axis`, plane: { origin: [0, 0, 0], normal: w, xDir: w[2] ? [1, 0, 0] : [0, 0, 1] } };
    return this.construction.axes.find((a) => a.id === id);
  }

  /** A world axis as a segment long enough to cover the view. */
  private worldAxisLine(id: string): { id: string; a: Vector3; b: Vector3 } | null {
    const w = WORLD_AXIS_DIRS[id];
    if (!w || !settings.value.showAxes) return null;
    const L = Math.max(this.cam.distance * 4, 100);
    const d = new Vector3(...w);
    return { id, a: d.clone().multiplyScalar(-L), b: d.clone().multiplyScalar(L) };
  }

  setImages(images: ImageFeature[]): void {
    this.imageGroup.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose();
    });
    this.imageGroup.clear();
    const loader = new TextureLoader();
    this.imageMeshes = [];
    for (const img of images) {
      // Textures are cached by source so live moves/scales don't reload them.
      let tex = this.textures.get(img.src);
      if (!tex) {
        tex = loader.load(img.src, () => this.requestRender());
        tex.colorSpace = SRGBColorSpace;
        this.textures.set(img.src, tex);
      }
      const mesh = new Mesh(new PlaneGeometry(img.width, img.height), new MeshBasicMaterial({ map: tex, transparent: true, opacity: img.opacity, side: DoubleSide, depthWrite: false }));
      mesh.applyMatrix4(planeMatrix(img.plane, -this.cam.distance * 1e-5));
      mesh.renderOrder = 0;
      mesh.userData.image = img.id;
      this.imageGroup.add(mesh);
      this.imageMeshes.push(mesh);
    }
    this.dirty = true;
  }

  private imageMeshes: Mesh[] = [];
  private textures = new Map<string, import("three").Texture>();

  // ------------------------------------------------------------ highlights

  private lastSelKey = "";
  private pulse: { t0: number; mats: { m: MeshBasicMaterial | LineMaterial | PointsMaterial; base: number }[] } | null = null;

  setHighlights(selected: Highlight[], hover: Highlight | null): void {
    this.highlightGroup.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments2) o.geometry.dispose();
    });
    this.highlightGroup.clear();
    const selKey = JSON.stringify(selected);
    const fresh = selKey !== this.lastSelKey && selected.length > 0;
    this.lastSelKey = selKey;
    this.lineMaterials = this.lineMaterials.filter((m) => m.userData.keep);
    let width = 4;
    const fatLines = (pts: number[], color: number) => {
      const geo = new LineSegmentsGeometry().setPositions(pts);
      const mat = new LineMaterial({ color, linewidth: width, depthTest: false });
      mat.resolution.set(this.width, this.height);
      this.lineMaterials.push(mat);
      const line = new LineSegments2(geo, mat);
      line.renderOrder = 4;
      this.highlightGroup.add(line);
    };
    const add = (h: Highlight, color: number, opacity: number) => {
      if (h.kind === "profile") {
        const src = this.profileMeshes.find((m) => m.userData.sketch === h.sketch && m.userData.region === h.region);
        if (!src) return;
        const m = new Mesh(src.geometry.clone(), overlayMat(color, opacity + 0.15));
        m.applyMatrix4(src.matrix);
        m.renderOrder = 3;
        this.highlightGroup.add(m);
        return;
      }
      if (h.kind === "curve") {
        const pts: number[] = [];
        for (const c of this.curveLines.filter((c) => c.sketch === h.sketch && c.entity === h.entity)) {
          for (let i = 0; i < c.pts.length - 1; i++) pts.push(...c.pts[i].toArray(), ...c.pts[i + 1].toArray());
        }
        if (pts.length) fatLines(pts, color);
        return;
      }
      if (h.kind === "point") {
        const q = this.sketchPoints.find((s) => s.sketch === h.sketch && s.entity === h.entity && s.p === h.p);
        if (!q) return;
        const dot = new Points(new BufferGeometry().setFromPoints([q.pos]), dotMaterial({ color, size: 13 }));
        dot.renderOrder = 6;
        this.highlightGroup.add(dot);
        return;
      }
      if (h.kind === "image") {
        const src = this.imageMeshes.find((m) => m.userData.image === h.id);
        if (!src) return;
        const box = new LineSegments(new EdgesGeometry(src.geometry), new LineBasicMaterial({ color, depthTest: false }));
        box.applyMatrix4(src.matrix);
        box.renderOrder = 6;
        this.highlightGroup.add(box);
        const m = new Mesh(src.geometry.clone(), overlayMat(color, opacity * 0.5));
        m.applyMatrix4(src.matrix);
        this.highlightGroup.add(m);
        return;
      }
      if (h.kind === "plane") {
        const src = this.planeMeshes.find((m) => m.userData.plane === h.id);
        if (!src) return;
        // Just a tint (the plane stays see-through), so it doesn't cover the model.
        const mat = overlayMat(color, Math.min(0.22, opacity * 0.5));
        // Planes are picked through bodies, so their highlight must show through too.
        mat.depthTest = false;
        const m = new Mesh(src.geometry.clone(), mat);
        m.matrixAutoUpdate = false;
        m.matrix.copy(src.matrix);
        m.renderOrder = src.userData.origin ? 61 : 9;
        this.highlightGroup.add(m);
        return;
      }
      if (h.kind === "axis") {
        const a = this.axisLines.find((x) => x.id === h.id) ?? this.worldAxisLine(h.id);
        if (a) fatLines([...a.a.toArray(), ...a.b.toArray()], color);
        return;
      }
      const b = this.bodies.get(h.body);
      if (!b) return;
      if (h.kind === "vertex") {
        const v = b.vertices[h.vertex];
        if (!v) return;
        const dot = new Points(new BufferGeometry().setFromPoints([v]), dotMaterial({ color, size: 12 }));
        dot.renderOrder = 6;
        this.highlightGroup.add(dot);
        return;
      }
      if (h.kind === "body" || h.kind === "face") {
        const groups = h.kind === "body" ? b.data.faceGroups : b.data.faceGroups.filter((g) => g.face === h.face);
        const idx: number[] = [];
        for (const g of groups) for (let i = g.start; i < g.start + g.count; i++) idx.push(b.data.indices[i]);
        const geo = new BufferGeometry();
        geo.setAttribute("position", b.mesh.geometry.getAttribute("position"));
        geo.setIndex(idx);
        const m = new Mesh(geo, overlayMat(color, opacity));
        m.renderOrder = 3;
        this.highlightGroup.add(m);
        // Outline the face/body with its edges so it reads clearly.
        const outline: number[] = [];
        b.data.edges.forEach((e, i) => {
          if (h.kind === "face" && !edgeOnFace(e, b.data.faces[h.face])) return;
          const g = b.data.edgeGroups.find((x) => x.edge === i);
          if (g) outline.push(...Array.from(b.data.edgePositions.slice(g.start * 3, (g.start + g.count) * 3)));
        });
        const w = width;
        width = 2;
        if (outline.length) fatLines(outline, color);
        width = w;
      } else {
        const g = b.data.edgeGroups.find((e) => e.edge === h.edge);
        if (g) fatLines(Array.from(b.data.edgePositions.slice(g.start * 3, (g.start + g.count) * 3)), color);
      }
    };
    width = 5;
    if (hover) add(hover, COLORS.hover, 0.3);
    width = 4;
    const firstSel = this.highlightGroup.children.length;
    for (const s of selected) add(s, COLORS.select, 0.42);
    // A newly selected thing flashes briefly, so it's obvious what was picked.
    if (fresh) {
      const mats: { m: MeshBasicMaterial | LineMaterial | PointsMaterial; base: number }[] = [];
      this.highlightGroup.children.slice(firstSel).forEach((o) => {
        const m = (o as Mesh).material as MeshBasicMaterial | LineMaterial | PointsMaterial;
        if (!m) return;
        m.transparent = true;
        mats.push({ m, base: m.opacity });
      });
      this.pulse = { t0: performance.now(), mats };
    }
    this.dirty = true;
  }

  /** Advance the selection flash; returns true while it runs. */
  private tickPulse(now: number): boolean {
    const p = this.pulse;
    if (!p) return false;
    const k = Math.min(1, (now - p.t0) / 420);
    const boost = Math.sin(k * Math.PI) * 0.5;
    for (const { m, base } of p.mats) m.opacity = Math.min(1, base + boost);
    if (k >= 1) this.pulse = null;
    return true;
  }

  // --------------------------------------------------------------- picking

  private setRay(x: number, y: number): void {
    const ndc = new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /** Set while the pointer only hovers: picking skips the near-miss search that taps get. */
  hovering = false;

  /** Pick what's under the pointer. Edges and curves win within the tolerance. */
  pick(x: number, y: number, opts: PickOptions = {}): PickHit | null {
    const { edgeTolPx = 8, profiles = true, bodies = true, edges = true, curves = false, planes = true, axes = true, vertices = edges, planesFirst = false } = opts;
    this.setRay(x, y);
    if (planes && planesFirst) {
      const hit = this.raycaster.intersectObjects(this.planeMeshes.filter((m) => m.userData.origin), false)[0];
      if (hit) return { kind: "plane", id: hit.object.userData.plane, point: hit.point.toArray() as Vec3 };
    }
    const visibleBodies = bodies && settings.value.shader !== "wireframe";
    const meshes = visibleBodies ? this.visibleBodies().map((b) => b.mesh) : [];
    const faceHit = this.raycaster.intersectObjects(meshes, false).find((h) => !this.clip || this.clip.distanceToPoint(h.point) >= 0);
    const faceDist = faceHit ? faceHit.distance : Infinity;
    const near = this.cam.distance * 1e-3;

    if (bodies && vertices) {
      const v = this.pickVertex(x, y, edgeTolPx, faceDist);
      if (v) return v;
    }
    if (curves) {
      const only = typeof curves === "string" ? curves : undefined;
      // Points first: endpoints sit on curves, and are what you usually mean.
      let bestPt: { d: number; q: { sketch: string; entity: string; p: string; pos: Vector3 } } | null = null;
      const proj = this.projector();
      const s = new Float64Array(2);
      for (const q of this.sketchPoints) {
        if (only && q.sketch !== only) continue;
        if (!proj(q.pos.x, q.pos.y, q.pos.z, s)) continue;
        const d = Math.hypot(s[0] - x, s[1] - y);
        if (d < edgeTolPx && (!bestPt || d < bestPt.d)) bestPt = { d, q };
      }
      if (bestPt) return { kind: "point", sketch: bestPt.q.sketch, entity: bestPt.q.entity, p: bestPt.q.p, point: bestPt.q.pos.toArray() as Vec3 };
      const c = this.pickCurve(x, y, edgeTolPx, only);
      if (c) return c;
    }
    if (profiles) {
      const ph = this.raycaster.intersectObjects(this.profileMeshes, false).filter((h) => h.distance <= faceDist + near);
      if (ph.length) {
        // Smallest region under the pointer at the nearest depth.
        const d0 = ph[0].distance;
        const best = ph.filter((h) => Math.abs(h.distance - d0) < near).sort((a, b) => a.object.userData.area - b.object.userData.area)[0];
        return { kind: "profile", sketch: best.object.userData.sketch, region: best.object.userData.region, point: best.point.toArray() as Vec3 };
      }
    }
    if (bodies && edges) {
      // Over a face, an edge has to be nearer to win (else small faces are
      // hard to hit between their edges when zoomed out).
      const edge = this.pickEdge(x, y, faceHit ? Math.max(5, edgeTolPx * 0.6) : edgeTolPx, faceDist);
      if (edge) return edge;
    }
    if (faceHit && faceHit.faceIndex != null) {
      const body = faceHit.object.userData.body as string;
      const data = this.bodies.get(body)!.data;
      const tri = faceHit.faceIndex * 3;
      const g = data.faceGroups.find((g) => tri >= g.start && tri < g.start + g.count);
      if (g) return { kind: "face", body, face: g.face, point: faceHit.point.toArray() as Vec3 };
    }
    // Nothing right under the tap: a corner, edge or curve just beside it is what
    // was meant (a finger, or a quick click, is rarely exactly on a thin line).
    if (!faceHit && edgeTolPx > 0 && !this.hovering) {
      const wide = Math.min(28, edgeTolPx * 1.6);
      if (bodies && vertices) {
        const v = this.pickVertex(x, y, wide * 0.8, Infinity);
        if (v) return v;
      }
      if (curves) {
        const c = this.pickCurve(x, y, wide, typeof curves === "string" ? curves : undefined);
        if (c) return c;
      }
      if (bodies && edges) {
        const e = this.pickEdge(x, y, wide, Infinity);
        if (e) return e;
      }
    }
    if (opts.images !== false) {
      const hit = this.raycaster.intersectObjects(this.imageMeshes, false)[0];
      if (hit && hit.distance <= faceDist) return { kind: "image", id: hit.object.userData.image, point: hit.point.toArray() as Vec3 };
    }
    if (axes) {
      // World axes in short pieces: a far end behind the camera has no screen position.
      const world: { id: string; a: Vector3; b: Vector3 }[] = [];
      for (const id of opts.worldAxes ? ["X", "Y", "Z"] : []) {
        const w = this.worldAxisLine(id);
        if (!w) continue;
        const n = 64;
        for (let k = 0; k < n; k++) world.push({ id, a: w.a.clone().lerp(w.b, k / n), b: w.a.clone().lerp(w.b, (k + 1) / n) });
      }
      for (const a of [...this.axisLines, ...world]) {
        const sa = this.toScreen(a.a);
        const sb = this.toScreen(a.b);
        if (sa && sb && distToSeg(x, y, sa, sb) < edgeTolPx) return { kind: "axis", id: a.id, point: a.a.toArray() as Vec3 };
      }
    }
    if (planes) {
      const hit = this.raycaster.intersectObjects(this.planeMeshes, false)[0];
      if (hit && hit.distance <= faceDist) return { kind: "plane", id: hit.object.userData.plane, point: hit.point.toArray() as Vec3 };
    }
    return null;
  }

  private pickCurve(x: number, y: number, tol: number, onlySketch?: string): PickHit | null {
    let best: { d: number; c: { sketch: string; entity: string; pts: Vector3[] }; p: Vector3 } | null = null;
    const proj = this.projector();
    const S = new Float64Array(2);
    const sa: [number, number] = [0, 0];
    const sb: [number, number] = [0, 0];
    for (const c of this.curveLines) {
      if (onlySketch && c.sketch !== onlySketch) continue;
      for (let i = 0; i < c.pts.length - 1; i++) {
        const A = c.pts[i];
        const B = c.pts[i + 1];
        if (!proj(A.x, A.y, A.z, S)) continue;
        ((sa[0] = S[0]), (sa[1] = S[1]));
        if (!proj(B.x, B.y, B.z, S)) continue;
        ((sb[0] = S[0]), (sb[1] = S[1]));
        const d = distToSeg(x, y, sa, sb);
        if (d < tol && (!best || d < best.d)) best = { d, c, p: c.pts[i] };
      }
    }
    return best ? { kind: "curve", sketch: best.c.sketch, entity: best.c.entity, point: best.p.toArray() as Vec3 } : null;
  }

  /** Distance of a point along the view direction (works for ortho and perspective). */
  private depthOf(w: Vector3): number {
    return this.cam.ortho ? w.clone().sub(this.camera.position).dot(this.cam.viewDir()) : w.distanceTo(this.camera.position);
  }

  /**
   * World → screen for many points at once: one matrix, the canvas size read
   * once, nothing allocated (picking projects every corner and edge piece of
   * every body — 10–14 ms a pick for a ruler's 11 000 edges).
   */
  private projector(): (x: number, y: number, z: number, out: Float64Array) => boolean {
    const m = new Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).elements;
    const W = this.width;
    const H = this.height;
    return (x, y, z, out) => {
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      const pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
      if (pz > 1 || pz < -1) return false;
      out[0] = (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2) * W;
      out[1] = ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2) * H;
      return true;
    };
  }

  private pickVertex(x: number, y: number, tolPx: number, faceDist: number): PickHit | null {
    const cands: { d: number; body: string; vertex: number; p: Vector3 }[] = [];
    const proj = this.projector();
    const s = new Float64Array(2);
    for (const [id, b] of this.bodies) {
      if (this.hiddenIds.has(id)) continue;
      b.vertices.forEach((v, i) => {
        if (this.clip && this.clip.distanceToPoint(v) < 0) return;
        if (!proj(v.x, v.y, v.z, s)) return;
        const d = Math.hypot(s[0] - x, s[1] - y);
        if (d > tolPx) return;
        if (this.depthOf(v) > faceDist + this.cam.distance * 0.01) return;
        cands.push({ d, body: id, vertex: i, p: v });
      });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    // The nearest corner nothing covers: the depth allowance above lets a
    // point just behind a thin wall through (the end of a stem 2 mm above the
    // inside of a lamp shade was picked through it).
    const hit = cands.slice(0, 6).find((c) => this.uncovered(c.p)) ?? null;
    this.setRay(x, y);
    return hit ? { kind: "vertex", body: hit.body, vertex: hit.vertex, point: hit.p.toArray() as Vec3 } : null;
  }

  private pickEdge(x: number, y: number, tolPx: number, faceDist: number): PickHit | null {
    // The nearest point of each edge near the pointer.
    const per = new Map<string, { d: number; body: string; edge: number; point: Vector3 }>();
    const a = new Vector3();
    const b = new Vector3();
    const camPos = this.camera.position;
    const viewDir = this.cam.viewDir();
    const proj = this.projector();
    const S = new Float64Array(2);
    const sa: [number, number] = [0, 0];
    const sb: [number, number] = [0, 0];
    for (const [id, { data }] of this.bodies) {
      if (this.hiddenIds.has(id)) continue;
      const p = data.edgePositions;
      for (const g of data.edgeGroups) {
        for (let i = g.start; i < g.start + g.count; i += 2) {
          if (!proj(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], S)) continue;
          ((sa[0] = S[0]), (sa[1] = S[1]));
          if (!proj(p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5], S)) continue;
          ((sb[0] = S[0]), (sb[1] = S[1]));
          // Nowhere near the pointer: skip before anything else.
          if ((sa[0] < x - tolPx && sb[0] < x - tolPx) || (sa[0] > x + tolPx && sb[0] > x + tolPx) || (sa[1] < y - tolPx && sb[1] < y - tolPx) || (sa[1] > y + tolPx && sb[1] > y + tolPx)) continue;
          a.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
          b.set(p[i * 3 + 3], p[i * 3 + 4], p[i * 3 + 5]);
          if (this.clip && this.clip.distanceToPoint(a) < 0 && this.clip.distanceToPoint(b) < 0) continue;
          const t = segParam(x, y, sa, sb);
          const d = Math.hypot(sa[0] + (sb[0] - sa[0]) * t - x, sa[1] + (sb[1] - sa[1]) * t - y);
          const key = `${id} ${g.edge}`;
          const was = per.get(key);
          if (d > tolPx || (was && d >= was.d)) continue;
          const w = a.clone().lerp(b, t);
          // Hidden edges (behind the face under the pointer) are not pickable.
          const depth = this.cam.ortho ? w.clone().sub(camPos).dot(viewDir) : w.distanceTo(camPos);
          if (depth > faceDist + this.cam.distance * 0.01) continue;
          per.set(key, { d, body: id, edge: g.edge, point: w });
        }
      }
    }
    // The nearest one nothing covers (the allowance above lets an edge just
    // behind a thin wall through).
    const best = [...per.values()].sort((p, q) => p.d - q.d).slice(0, 6).find((c) => this.uncovered(c.point));
    this.setRay(x, y);
    return best ? { kind: "edge", body: best.body, edge: best.edge, point: best.point.toArray() as Vec3 } : null;
  }

  /** Nothing drawn lies in front of this point (a few pixels' slack). Moves the ray. */
  private uncovered(p: Vector3): boolean {
    if (settings.value.shader === "wireframe") return true;
    const q = this.toScreen(p);
    if (!q) return false;
    this.setRay(q[0], q[1]);
    const front = this.raycaster.intersectObjects(this.visibleBodies().map((b) => b.mesh), false).find((h) => !this.clip || this.clip.distanceToPoint(h.point) >= 0);
    return !front || front.distance >= this.raycaster.ray.origin.distanceTo(p) - this.cam.worldPerPixel(this.height) * 2;
  }

  /** Intersection of the pointer ray with a plane, or null if parallel. */
  /** The ray from the eye through a point of the canvas (origin, unit direction). */
  pointerRay(x: number, y: number): { o: Vec3; d: Vec3 } {
    this.setRay(x, y);
    const r = this.raycaster.ray;
    return { o: r.origin.toArray() as Vec3, d: r.direction.clone().normalize().toArray() as Vec3 };
  }

  rayToPlane(x: number, y: number, plane: PlaneDef): Vec3 | null {
    this.setRay(x, y);
    const n = new Vector3(...plane.normal);
    const o = new Vector3(...plane.origin);
    const r = this.raycaster.ray;
    const denom = n.dot(r.direction);
    if (Math.abs(denom) < 1e-9) return null;
    const t = o.sub(r.origin).dot(n) / denom;
    if (t < 0 && !this.cam.ortho) return null;
    return r.origin.clone().addScaledVector(r.direction, t).toArray() as Vec3;
  }

  /** World point → CSS pixel coords, or null when behind the camera. */
  toScreen(v: Vector3 | Vec3): [number, number] | null {
    const p = Array.isArray(v) ? new Vector3(...v) : v.clone();
    p.project(this.camera);
    if (p.z > 1 || p.z < -1) return null;
    return [((p.x + 1) / 2) * this.width, ((1 - p.y) / 2) * this.height];
  }

  /** Point under the pointer for zooming: model surface, else ground, else target depth. */
  worldUnder(x: number, y: number): Vector3 {
    this.setRay(x, y);
    const hit = this.raycaster.intersectObjects([...this.bodies.values()].map((b) => b.mesh), false)[0];
    if (hit) return hit.point;
    const g = this.rayToPlane(x, y, GROUND);
    if (g && new Vector3(...g).distanceTo(this.camera.position) < this.cam.distance * 20) return new Vector3(...g);
    const r = this.raycaster.ray;
    return r.origin.clone().addScaledVector(r.direction, this.cam.target.clone().sub(r.origin).dot(r.direction));
  }

  /** Line material that tracks viewport resolution (for overlays). */
  lineMaterial(color: number, width: number, depthTest = false): LineMaterial {
    const m = new LineMaterial({ color, linewidth: width, depthTest });
    m.resolution.set(this.width, this.height);
    m.userData.keep = true;
    this.lineMaterials.push(m);
    return m;
  }

  releaseLineMaterial(m: LineMaterial): void {
    this.lineMaterials = this.lineMaterials.filter((x) => x !== m);
    m.dispose();
  }

  /** PNG of the current view. */
  screenshot(): Promise<Blob | null> {
    this.render();
    return new Promise((resolve) => this.canvas.toBlob(resolve, "image/png"));
  }

  get sketchList(): SketchView[] {
    return this.sketches;
  }
}

/** Matrix taking sketch-local (u, v, w) into world space. */
export function planeMatrix(p: PlaneDef, lift = 0): Matrix4 {
  const x = new Vector3(...p.xDir);
  const y = new Vector3(...planeY(p));
  const z = new Vector3(...p.normal);
  const o = new Vector3(...p.origin).addScaledVector(z, lift);
  return new Matrix4().makeBasis(x, y, z).setPosition(o);
}

export function sketchToWorld(p: PlaneDef, uv: Vec2, lift = 0): Vector3 {
  return new Vector3(uv[0], uv[1], 0).applyMatrix4(planeMatrix(p, lift));
}

/** Does an edge lie on a face? (flat faces: all three sample points on its plane). */
export function edgeOnFace(e: EdgeInfo, f: FaceInfo): boolean {
  if (!f.plane) {
    // Curved faces: an edge belongs if its midpoint is close to the face centre region.
    return false;
  }
  return [e.start, e.end, e.mid].every((p) => Math.abs((p[0] - f.center[0]) * f.normal[0] + (p[1] - f.center[1]) * f.normal[1] + (p[2] - f.center[2]) * f.normal[2]) < 1e-5 * (1 + Math.sqrt(f.area)));
}

function overlayMat(color: number, opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
}

function segParam(x: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-9) return 0;
  return Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
}

function distToSeg(x: number, y: number, a: [number, number], b: [number, number]): number {
  const t = segParam(x, y, a, b);
  return Math.hypot(a[0] + (b[0] - a[0]) * t - x, a[1] + (b[1] - a[1]) * t - y);
}

function makeAxes(): Object3D {
  const g = new Group();
  const L = 1e6;
  const axis = (to: Vec3, color: number) => {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute([0, 0, 0, ...to], 3));
    // Transparent + later render order so the axes draw over the coplanar grid.
    const line = new LineSegments(geo, new LineBasicMaterial({ color, transparent: true }));
    line.renderOrder = 1;
    return line;
  };
  g.add(axis([L, 0, 0], 0xe0584f), axis([0, L, 0], 0x5fbf5a), axis([0, 0, L], 0x4f8ce0));
  return g;
}

/**
 * Section caps get thin diagonal lines (fixed on screen), so a cut reads as a
 * cut and not as another face of the body.
 */
function hatched<M extends MeshBasicMaterial>(m: M): M {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>
      float hatchK = mod(gl_FragCoord.x + gl_FragCoord.y, 9.0);
      if (hatchK < 1.6) gl_FragColor.rgb *= 0.62;`,
    );
  };
  m.customProgramCacheKey = () => "hatched";
  return m;
}

