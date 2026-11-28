import { uniqueEnds } from "./corners";
import { isHeadset } from "../device";
import {
  GreaterDepth,
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
  Sprite,
  SpriteMaterial,
  AlwaysStencilFunc,
  DecrementWrapStencilOp,
  IncrementWrapStencilOp,
  NotEqualStencilFunc,
  ReplaceStencilOp,
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
import { entityPolylines, splineHeights, splineHeightSamples } from "../sketch/curves";
import { arrangement } from "../sketch/regions";
import { CameraController, type Insets } from "./camera";
import { AdaptiveGrid } from "./grid";
import { analysisMaterial, curvatureOf } from "./analysis";

export type PickHit =
  | { kind: "face"; body: string; face: number; point: Vec3 }
  | { kind: "edge"; body: string; edge: number; point: Vec3 }
  | { kind: "vertex"; body: string; vertex: number; point: Vec3 }
  | { kind: "profile"; sketch: string; region: number; point: Vec3 }
  | { kind: "curve"; sketch: string; entity: string; point: Vec3 }
  | { kind: "point"; sketch: string; entity: string; p: string; point: Vec3 }
  | { kind: "image"; id: string; point: Vec3 }
  | { kind: "plane"; id: string; point: Vec3 }
  | { kind: "axis"; id: string; point: Vec3 }
  /** The world origin, 0, 0, 0 (point picks only: PickOptions.origin). */
  | { kind: "origin"; point: Vec3 };

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
  | { kind: "axis"; id: string }
  | { kind: "origin" };

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
  /** The world X/Y/Z axes count as axes (ids "X", "Y", "Z") - for axis/direction slots. */
  worldAxes?: boolean;
  vertices?: boolean;
  images?: boolean;
  /** Planes win even when a body is in front (picking a sketch/section plane). */
  planesFirst?: boolean;
  /** The world origin (0, 0, 0) can be picked, near where the X / Y / Z axes cross. */
  origin?: boolean;
}

/** A sketch as drawn: its own curves plus the face outline it sits on (if any). */
export type SketchView = SketchFeature & { boundary?: SketchEntity[]; /** The sketch being edited: its curves the constraints hold completely (drawn green). */ defined?: ReadonlySet<string> };

/** The three origin planes, addressable like construction planes. */
export const ORIGIN_PLANES: Record<string, PlaneDef> = { XY: GROUND, XZ: FRONT, YZ: RIGHT };

const COLORS = {
  body: 0xb9bec7,
  edge: 0x23262b,
  hover: 0x7fb2ff,
  select: 0x2f7bff,
  sketch: 0xe8e8e8,
  sketchActive: 0xffc23d,
  // (A sketch's construction lines: an orange that stands out on a body's grey, a plane's blue and the dark floor
  // alike. They were a thin grey - the body's own colour, all but - and could hardly be seen drawn on a face.)
  construction: 0xf26b00,
  linked: 0xc79bff,
  profile: 0x4d8dff,
  plane: 0x8fb4ff,
  cap: 0xff8fb8,
};

interface BodyView {
  data: BodyMesh;
  mesh: Mesh;
  /** Section cap: a plane on the cut, drawn only inside the body (stencil). */
  cap: Mesh;
  /** The two passes that mark "inside the body" for the cap. */
  capStencil: Mesh[];
  /** The cut's outline, drawn thick. */
  outline: LineSegments2 | null;
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
  /** Closed shapes of the sketches on show, ready to pull into 3D. */
  /** The closed shapes of the sketches shown (outside the sketch being drawn): which, and the corners of each in the world. */
  profileList(): { sketch: string; region: number; points: Vec3[] }[] {
    return this.profileMeshes
      .filter((m) => m.visible && m.parent?.visible !== false)
      .map((m) => {
        let pts = m.userData.world as Vec3[] | undefined;
        if (!pts) {
          const pos = m.geometry.getAttribute("position");
          const v = new Vector3();
          pts = [];
          for (let i = 0; i < pos.count; i++) pts.push(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrix).toArray() as Vec3);
          m.userData.world = pts;
        }
        return { sketch: m.userData.sketch as string, region: m.userData.region as number, points: pts };
      });
  }

  get profileCount(): number {
    return this.profileMeshes.length;
  }
  private curveLines: { sketch: string; entity: string; pts: Vector3[] }[] = [];
  private planeMeshes: Mesh[] = [];
  private axisLines: { id: string; a: Vector3; b: Vector3 }[] = [];
  private raycaster = new Raycaster();
  private dirty = true;
  private light = new DirectionalLight(0xffffff, 1.6);
  private lineMaterials: LineMaterial[] = [];
  private sketches: SketchView[] = [];
  /** The sketch being edited and the sketches shown whole, as last given (to draw them again when a curve is picked). */
  private activeSketch: string | undefined;
  private freshSketches: ReadonlySet<string> = new Set();
  /**
   * The curves picked in the sketch being edited. A spline shows its two ends;
   * the points between (the ones it is shaped by) come up once it is picked -
   * a curve projected from an edge, offset, or a text's outline was a row of
   * dots otherwise.
   */
  private openCurves = new Set<string>();
  /** The construction planes and axes shown (read: listed by name where a tap would pick one). */
  construction: { planes: ConstructionInfo[]; axes: ConstructionInfo[] } = { planes: [], axes: [] };
  private showOriginPlanes = false;
  private clip: Plane | null = null;
  private bodyMat: MeshStandardMaterial;
  private capMat: MeshBasicMaterial;
  private stencilMats: MeshBasicMaterial[] = [];
  /** Section caps, their stencil passes and outlines (apart: not part of the model's size). */
  private capGroup = new Group();
  private capPlaneGeo = new PlaneGeometry(1, 1);
  private edgeMat: LineBasicMaterial;
  private hiddenMat: LineDashedMaterial;
  /** Hidden edges on a dark body: light, where the dark ones could not be seen. */
  private hiddenLightMat: LineDashedMaterial;
  /** The zoom the hidden edges' dashes were last sized for (they keep their size on screen). */
  private hiddenWpp = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    // (The drawing buffer isn't kept between frames: the browser shows each one the
    // quick way. The two places that read the canvas - the library's picture and
    // the screenshot - draw the view right before they do.)
    this.renderer = new WebGLRenderer({ canvas, antialias: true, stencil: true });
    // Headsets render the page into a big virtual screen already: full ratio costs frames for no gain.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, isHeadset ? 1.25 : 2));
    this.renderer.localClippingEnabled = true;
    this.cam = new CameraController(1);
    this.scene.background = new Color(0x2b2d31);

    this.scene.add(new HemisphereLight(0xffffff, 0x3a3d44, 1.1));
    this.scene.add(new AmbientLight(0xffffff, 0.25));
    this.scene.add(this.light, this.light.target);

    this.bodyMat = new MeshStandardMaterial({ color: COLORS.body, metalness: 0.05, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: FrontSide });
    // Section caps: a plane on the cut, drawn only where the body is cut (a
    // stencil marks the inside) - solid: what's behind it doesn't show through
    // (the far wall's inside was drawn flat before, its edges and all).
    this.capMat = hatched(new MeshBasicMaterial({ color: COLORS.cap, side: DoubleSide, stencilWrite: true, stencilRef: 0, stencilFunc: NotEqualStencilFunc, stencilFail: ReplaceStencilOp, stencilZFail: ReplaceStencilOp, stencilZPass: ReplaceStencilOp }));
    this.stencilMats = [BackSide, FrontSide].map(
      (side) =>
        new MeshBasicMaterial({
          side,
          colorWrite: false,
          depthWrite: false,
          depthTest: false,
          stencilWrite: true,
          stencilFunc: AlwaysStencilFunc,
          ...(side === BackSide
            ? { stencilFail: IncrementWrapStencilOp, stencilZFail: IncrementWrapStencilOp, stencilZPass: IncrementWrapStencilOp }
            : { stencilFail: DecrementWrapStencilOp, stencilZFail: DecrementWrapStencilOp, stencilZPass: DecrementWrapStencilOp }),
        }),
    );
    this.edgeMat = new LineBasicMaterial({ color: COLORS.edge });
    // Hidden edges: dashed, and only where an edge really is behind something (drawn where the depth already
    // there is nearer). They were drawn over every edge, the ones in plain sight too, in a grey close to the
    // body's own - on a lit face they could not be seen, and the edges in front looked broken.
    const hiddenOf = (color: number) => new LineDashedMaterial({ color, dashSize: 2, gapSize: 2, depthTest: true, depthFunc: GreaterDepth, depthWrite: false, transparent: true, opacity: 0.85 });
    this.hiddenMat = hiddenOf(0x14161a);
    this.hiddenLightMat = hiddenOf(0xf2f4f8);

    this.axesGroup = makeAxes();
    this.scene.add(this.grid.mesh, this.axesGroup, this.imageGroup, this.bodiesGroup, this.capGroup, this.constructionGroup, this.sketchGroup, this.highlightGroup, this.overlay);

    settings.onChange(() => this.applySettings());
    this.applySettings();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    const loop = (t: number) => {
      if (this.cam.tick(t)) this.dirty = true;
      if (this.tickPulse(t)) this.dirty = true;
      // (In a headset the headset's own loop draws: see xr.ts.)
      if (this.dirty && !this.renderer.xr.isPresenting) this.render();
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
    // Hidden edges' dashes keep their size on screen (they were 2 mm whatever the zoom: dots far out, bars close up).
    if (settings.value.showHiddenEdges) {
      const wpp = this.cam.worldPerPixel(this.height);
      if (Math.abs(wpp - this.hiddenWpp) > this.hiddenWpp * 0.03) {
        this.hiddenWpp = wpp;
        for (const m of [this.hiddenMat, this.hiddenLightMat]) {
          m.dashSize = wpp * 6;
          m.gapSize = wpp * 4;
        }
      }
    }
    if (this.anaMat && settings.value.analysis !== "none") {
      this.anaMat.uniforms.uOrtho.value = this.cam.ortho;
      this.anaMat.uniforms.uViewDir.value.copy(this.cam.viewDir());
    }
    this.frameHooks.forEach((f) => f());
    this.renderer.render(this.scene, cam);
    this.afterDraw?.();
  }

  /** Called right after each frame is drawn, while the picture is still there to copy (a recording). */
  afterDraw: (() => void) | null = null;

  /**
   * No grid for now (a recording: scaled to the video's size, its fine lines turn to a shimmer that the video's
   * compression then smears - on a big screen the whole picture crawled).
   */
  private plain = false;
  plainGround(on: boolean): void {
    this.plain = on;
    this.applySettings();
    this.dirty = true;
  }

  private applySettings(): void {
    const s = settings.value;
    this.grid.mesh.visible = s.showGrid && !this.plain;
    this.grid.locked = s.gridLocked;
    this.grid.lockedStep = s.gridStep;
    this.axesGroup.visible = s.showAxes;
    this.cam.animate = s.animateCamera;
    // A 2D section is always seen straight on, without perspective.
    // (Orthographic chosen in Settings: no longer only flat for a view of the cube's.)
    if (s.ortho) this.cam.flatForNow = false;
    this.cam.setOrtho(s.ortho || (this.sectionStyle === "flat" && !!this.clip) || this.cam.flatForNow);
    // Select Through shows what's behind (X-ray), since that's what it picks.
    const xray = s.shader === "xray" || this.selectThrough;
    for (const m of this.allBodyMats()) {
      // A see-through body (Fade) is seen through in every view; while a
      // new solid is being sized from a sketch, everything is a little see-through.
      const o = ((m.userData.opacity as number | undefined) ?? 1) * (this.ghost ? 0.62 : 1);
      const see = xray || o < 1;
      m.transparent = see;
      m.opacity = (xray ? 0.35 : 1) * o;
      m.depthWrite = !see;
      m.side = see ? DoubleSide : FrontSide;
      m.needsUpdate = true;
    }
    this.applyAnalysis();
    this.applyHidden();
  }

  /** Select Through (Ctrl+Shift+S): picking ignores the faces in front. */
  selectThrough = false;

  setSelectThrough(on: boolean): void {
    this.selectThrough = on;
    this.applySettings();
  }

  /** Zebra stripes / curvature map (Display modes): every body wears it while on. */
  private anaMat: ReturnType<typeof analysisMaterial> | null = null;

  private applyAnalysis(): void {
    const s = settings.value;
    // A 2D section's lines are light (on the dark background), a 3D model's dark (on its grey faces). Wireframe
    // has no faces: its lines are light too (dark on the dark background, only the dashes over them showed).
    this.edgeMat.color.set((this.sectionStyle === "flat" && this.clip) || s.shader === "wireframe" ? 0xd8dbe2 : COLORS.edge);
    if (this.sectionStyle === "flat" && this.clip) {
      const m = (this.flatMat ??= new MeshBasicMaterial({ color: (this.scene.background as Color).clone(), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      m.clippingPlanes = [this.clip];
      m.needsUpdate = true;
      for (const b of this.bodies.values()) b.mesh.material = m;
      this.dirty = true;
      return;
    }
    if (s.analysis === "none") {
      for (const [id, b] of this.bodies) if (b.mesh.material === this.anaMat || b.mesh.material === this.flatMat) b.mesh.material = this.matsFor(id).body;
      return;
    }
    const m = (this.anaMat ??= analysisMaterial());
    m.uniforms.uKind.value = s.analysis === "zebra" ? 0 : s.analysis === "overhang" ? 2 : 1;
    if (s.analysis === "overhang") {
      // Printed upwards from the floor: the lowest point of what is on show is on the bed.
      let bed = Infinity;
      for (const b of this.visibleBodies()) {
        const p = b.data.positions;
        for (let i = 2; i < p.length; i += 3) if (p[i] < bed) bed = p[i];
      }
      m.uniforms.uLean.value = Math.sin((Math.max(1, Math.min(89, s.overhangAngle)) * Math.PI) / 180);
      m.uniforms.uBed.value = Number.isFinite(bed) ? bed : 0;
    }
    m.uniforms.uStripes.value = s.zebraStripes;
    m.uniforms.uHorizontal.value = s.zebraDirection === "horizontal" ? 1 : 0;
    m.uniforms.uScale.value = 1 / Math.max(s.curvatureRadius, 1e-3);
    m.clippingPlanes = this.clip ? [this.clip] : [];
    m.needsUpdate = true;
    for (const b of this.bodies.values()) {
      const g = b.mesh.geometry;
      if (!g.getAttribute("curv")) g.setAttribute("curv", new BufferAttribute(curvatureOf(b.data.positions, b.data.normals, b.data.indices), 1));
      b.mesh.material = m;
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------- bodies

  private openMats: LineMaterial[] = [];

  /** Body colour → its surface and section-cap materials (copies of the shared ones). */
  private colorMats = new Map<string, { body: MeshStandardMaterial; cap: MeshBasicMaterial }>();
  private bodyColors: Record<string, string> = {};
  private bodyOpacity: Record<string, number> = {};

  /** The hidden-edge lines for a body: dark on a light body, light on a dark one. */
  private hiddenFor(id: string): LineDashedMaterial {
    const hex = bodyColor(this.bodyColors[id]);
    if (!hex) return this.hiddenMat;
    const c = new Color(hex);
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b < 0.18 ? this.hiddenLightMat : this.hiddenMat;
  }

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
      // The cut face is the same for every body, whatever its colour: pink with its dark diagonal lines - a cut
      // reads as a cut. (It was the body's colour, a little darker.)
      m = { body, cap: this.capMat };
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
      b.hidden.material = this.hiddenFor(id);
    }
    this.applyClip();
    this.applySettings();
  }

  setBodies(meshes: BodyMesh[]): void {
    // A body the step didn't change (same mesh key): what was drawn for it stays
    // (its triangles went to the graphics card once, not again on every rebuild).
    const was = new Map(this.bodies);
    const keep = new Set(meshes.filter((m) => was.get(m.id)?.data.key === m.key).map((m) => m.id));
    for (const [id, b] of was) {
      b.outline?.geometry.dispose();
      b.outline = null;
      if (keep.has(id)) continue;
      b.mesh.geometry.dispose();
      b.edges.geometry.dispose();
    }
    this.openMats.forEach((m) => this.releaseLineMaterial(m));
    this.openMats = [];
    this.bodies.clear();
    this.bodiesGroup.clear();
    this.capGroup.clear();
    for (const data of meshes) {
      const old = keep.has(data.id) ? was.get(data.id) : undefined;
      if (old) {
        const i = this.bodies.size;
        old.data = data;
        old.mesh.material = this.matsFor(data.id).body;
        old.cap.material = this.matsFor(data.id).cap;
        old.capStencil.forEach((sm) => (sm.renderOrder = 10 + 3 * i));
        old.cap.renderOrder = 11 + 3 * i;
        this.bodiesGroup.add(old.mesh, old.edges, old.hidden);
        this.capGroup.add(old.cap, ...old.capStencil);
        this.bodies.set(data.id, old);
        this.addOpenEdges(data);
        continue;
      }
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(data.positions, 3));
      g.setAttribute("normal", new BufferAttribute(data.normals, 3));
      g.setIndex(new BufferAttribute(data.indices, 1));
      g.computeBoundingSphere();
      const mats = this.matsFor(data.id);
      const mesh = new Mesh(g, mats.body);
      mesh.userData.body = data.id;
      const i = this.bodies.size;
      const capStencil = this.stencilMats.map((m) => {
        const sm = new Mesh(g, m);
        sm.renderOrder = 10 + 3 * i;
        return sm;
      });
      const cap = new Mesh(this.capPlaneGeo, mats.cap);
      cap.renderOrder = 11 + 3 * i;
      // Each body's cap clears the marks after it: the next body starts afresh.
      cap.onAfterRender = (r) => r.clearStencil();
      const eg = new BufferGeometry();
      eg.setAttribute("position", new BufferAttribute(data.edgePositions, 3));
      const edges = new LineSegments(eg, this.edgeMat);
      const hidden = new LineSegments(eg, this.hiddenFor(data.id));
      hidden.computeLineDistances();
      hidden.renderOrder = 5;
      this.bodiesGroup.add(mesh, edges, hidden);
      this.capGroup.add(cap, ...capStencil);
      const vertices = uniqueEnds(data.edges);
      this.bodies.set(data.id, { data, mesh, cap, capStencil, outline: null, edges, hidden, vertices });
      this.addOpenEdges(data);
    }
    this.applyClip();
    this.applySettings();
    this.applyHidden();
    this.applyPoses();
  }

  /** Assemblies: each body's move from where it was modelled (a 4 x 4, column by column); none: all at home. */
  private poses: Map<string, number[]> | null = null;

  /**
   * Bodies shown moved - an assembly's parts at their joints' values, or pulled apart - without the model being
   * made again: what is drawn of each (its faces, its edges) is put through its move. Null: all where they were
   * modelled. Picks of faces and bodies go by what is drawn; edges, vertices and what is lit do not (they are
   * where the model has them), so a tool that shows bodies moved picks by `facesAt`.
   */
  setPoses(poses: Map<string, number[]> | null): void {
    // (Only the bodies that are moved: one whose move is none is as it was modelled.)
    const still = (m: number[]) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
    const moved = poses ? new Map([...poses].filter(([, m]) => !still(m))) : null;
    if (!this.poses && !moved?.size) return;
    this.poses = moved?.size ? moved : null;
    this.applyPoses();
    this.requestRender();
  }

  private applyPoses(): void {
    for (const [id, b] of this.bodies) {
      const m = this.poses?.get(id);
      for (const o of [b.mesh, b.edges, b.hidden, ...b.capStencil]) {
        if (!m && o.matrixAutoUpdate) continue;
        if (m) {
          o.matrixAutoUpdate = false;
          o.matrix.fromArray(m);
        } else {
          o.matrix.identity();
          o.matrixAutoUpdate = true;
        }
        o.matrixWorldNeedsUpdate = true;
      }
    }
  }

  /** Open (non-watertight) edges stand out in orange. */
  private addOpenEdges(data: BodyMesh): void {
    if (!data.openEdges?.length) return;
    const seg: number[] = [];
    for (const i of data.openEdges) {
      const g = data.edgeGroups.find((x) => x.edge === i);
      if (g) seg.push(...Array.from(data.edgePositions.slice(g.start * 3, (g.start + g.count) * 3)));
    }
    if (!seg.length) return;
    const mat = this.lineMaterial(0xff9a3d, 3, true);
    this.openMats.push(mat);
    const l = new LineSegments2(new LineSegmentsGeometry().setPositions(seg), mat);
    l.renderOrder = 3;
    this.bodiesGroup.add(l);
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
      // Section only: the cut faces alone (and their outline), the rest of the model gone.
      const only = this.sectionStyle === "only" && !!this.clip;
      b.mesh.visible = vis && settings.value.shader !== "wireframe" && !only;
      b.cap.visible = vis && !!this.clip && (settings.value.shader === "shaded" || only);
      for (const sm of b.capStencil) sm.visible = b.cap.visible;
      if (b.outline) b.outline.visible = vis && !!this.clip;
      b.edges.visible = vis && !only && (settings.value.showEdges || settings.value.shader === "wireframe" || this.sectionStyle === "flat");
      // (Wireframe: every edge is in plain sight, drawn whole; dashes over the same lines only broke them up.)
      b.hidden.visible = vis && !only && settings.value.showHiddenEdges && settings.value.shader !== "wireframe";
    }
    this.dirty = true;
  }

  /** How a section shows: the model cut (normal), the cut faces alone (only), or flat like a drawing, the edges beyond it drawn (flat). */
  private sectionStyle: "normal" | "only" | "flat" = "normal";

  setSectionStyle(style: "normal" | "only" | "flat"): void {
    if (this.sectionStyle === style) return;
    this.sectionStyle = style;
    this.applySettings();
  }

  /** The bodies' faces in a 2D section: the background's colour, unlit (they only hide the edges behind). */
  private flatMat: MeshBasicMaterial | null = null;

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

  /**
   * A picture of everything shown, fitted into a w × h frame, seen from the
   * way the view looks now (for the project library). The view itself doesn't move.
   */
  snapshot(w: number, h: number, background: string): string | undefined {
    const W = this.canvas.width, H = this.canvas.height;
    if (!W || !H) return undefined;
    // The middle of the canvas with the frame's shape: the model is fitted into that.
    const s = Math.min(W / w, H / h);
    const [cw, ch] = [w * s, h * s];
    const side = (1 - cw / W) / 2, top = (1 - ch / H) / 2;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const g = out.getContext("2d")!;
    // The view is see-through (the page shows behind it); a JPEG would turn that black.
    g.fillStyle = background;
    g.fillRect(0, 0, w, h);
    this.cam.borrow(() => {
      this.cam.fit(this.bounds(), false, { left: side, right: side, top, bottom: top });
      this.render();
      g.drawImage(this.canvas, (W - cw) / 2, (H - ch) / 2, cw, ch, 0, 0, w, h);
    });
    // Drawn again as it was.
    this.render();
    return out.toDataURL("image/jpeg", 0.75);
  }

  /** Zoom to fit everything shown, in the part of the screen the tools leave free. */
  fitAll(animate = true): void {
    this.cam.fit(this.bounds(), animate, this.coveredInsets());
  }

  /** Zoom to one face (Space over it): the face filling the free part of the screen. */
  zoomToFace(body: string, face: number): boolean {
    const d = this.body(body);
    if (!d) return false;
    const box = new Box3();
    const p = new Vector3();
    for (const g of d.faceGroups)
      if (g.face === face)
        for (let i = g.start; i < g.start + g.count; i++) box.expandByPoint(p.fromArray(d.positions, d.indices[i] * 3));
    if (box.isEmpty()) return false;
    this.cam.fit(box, true, this.coveredInsets());
    return true;
  }

  /**
   * Bring what a tool is working on (its highlighted picks, else everything)
   * into the free part of the screen - only when some of it is outside it,
   * and never zooming in.
   */
  keepInView(): void {
    const box = new Box3();
    this.highlightGroup.traverse((o) => {
      const b = new Box3().expandByObject(o, true);
      if (!b.isEmpty() && [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every((v) => Number.isFinite(v) && Math.abs(v) < 1e8)) box.union(b);
    });
    if (box.isEmpty()) box.copy(this.bounds());
    if (box.isEmpty()) return;
    const ins = this.coveredInsets();
    const w = this.width, h = this.height;
    const inside = [0, 1, 2, 3, 4, 5, 6, 7].every((i) => {
      const s = this.toScreen(new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
      return !!s && s[0] >= ins.left * w && s[0] <= (1 - ins.right) * w && s[1] >= ins.top * h && s[1] <= (1 - ins.bottom) * h;
    });
    if (!inside) this.cam.fit(box, true, ins, true);
  }

  /**
   * How much of each side of the canvas the tool columns and bars cover: a
   * column hugging the left or right edge, a bar along the top or bottom.
   * Panels that cover most of the screen (History on a phone) don't count -
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
      // A panel over most of the screen (History on a phone): nowhere left to put the model - ignored.
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
    // (The caps lie on the cut itself: never clipped.)
    for (const m of [this.bodyMat, this.edgeMat, this.hiddenMat, this.hiddenLightMat, ...this.stencilMats, ...[...this.colorMats.values()].map((c) => c.body)]) {
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
    this.placeCaps();
    this.dirty = true;
  }

  private outlineMat: LineMaterial | null = null;

  /** Each cap plane onto the cut (big enough to cover its body), and the cut's outline. */
  private placeCaps(): void {
    const clip = this.clip;
    for (const b of this.bodies.values()) {
      if (b.outline) {
        this.capGroup.remove(b.outline);
        b.outline.geometry.dispose();
        b.outline = null;
      }
      if (!clip) continue;
      const g = b.mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const sph = g.boundingSphere!;
      b.cap.position.copy(clip.projectPoint(sph.center, new Vector3()));
      b.cap.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), clip.normal);
      b.cap.scale.setScalar(sph.radius * 2.2 + 1);
      b.cap.updateMatrixWorld();
      // The outline: where the cut crosses each triangle.
      const pos = g.getAttribute("position").array as ArrayLike<number>;
      const idx = g.getIndex()!.array as ArrayLike<number>;
      const n = clip.normal;
      const k = clip.constant;
      const dist = (i: number) => n.x * pos[3 * i] + n.y * pos[3 * i + 1] + n.z * pos[3 * i + 2] + k;
      const seg: number[] = [];
      for (let t = 0; t < idx.length; t += 3) {
        const v = [idx[t], idx[t + 1], idx[t + 2]];
        const sd = v.map(dist);
        if ((sd[0] > 0 && sd[1] > 0 && sd[2] > 0) || (sd[0] < 0 && sd[1] < 0 && sd[2] < 0)) continue;
        const pts: number[] = [];
        for (let e = 0; e < 3; e++) {
          const a = v[e];
          const c = v[(e + 1) % 3];
          const sa = sd[e];
          const sc = sd[(e + 1) % 3];
          if (sa < 0 === sc < 0 || sa === sc) continue;
          const f = sa / (sa - sc);
          pts.push(pos[3 * a] + (pos[3 * c] - pos[3 * a]) * f, pos[3 * a + 1] + (pos[3 * c + 1] - pos[3 * a + 1]) * f, pos[3 * a + 2] + (pos[3 * c + 2] - pos[3 * a + 2]) * f);
        }
        if (pts.length === 6) seg.push(...pts);
      }
      if (!seg.length) continue;
      const lg = new LineSegmentsGeometry();
      lg.setPositions(seg);
      this.outlineMat ??= this.lineMaterial(COLORS.edge, 3, true);
      const line = new LineSegments2(lg, this.outlineMat);
      line.renderOrder = 1000;
      line.visible = !this.hiddenIds.has(b.data.id);
      this.capGroup.add(line);
      b.outline = line;
    }
  }

  // -------------------------------------------------------------- sketches

  private sketchMats: LineMaterial[] = [];
  private sketchPoints: { sketch: string; entity: string; p: string; pos: Vector3 }[] = [];

  setSketches(sketches: SketchView[], activeId?: string, fresh: ReadonlySet<string> = new Set()): void {
    this.sketches = sketches;
    this.activeSketch = activeId;
    this.freshSketches = fresh;
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
      // (A sketch saved without a plane - a damaged file: left out, not the whole drawing stopped.)
      if (!s.plane) continue;
      const active = s.id === activeId;
      // Not made into anything yet: drawn on top of bodies, so one inside a body still shows.
      const onTop = active || fresh.has(s.id);
      const m = planeMatrix(s.plane, this.cam.distance * 1e-5);
      // Clean 2px lines; the sketch being edited is brighter and on top.
      // (Each drawn with the see-through things, after the world's axes: a line along an axis is the line's colour.)
      const solid: number[] = [];
      const dashed: number[] = [];
      // Curves that follow a body's edge: in their own colour (they aren't the sketch's to move).
      const linked: number[] = [];
      // In the sketch being edited, curves its constraints hold completely: green.
      const held: number[] = [];
      // Offsets of the face's edge (linked to it): drawn and tapped like the sketch's own curves.
      for (const e of [...s.entities, ...(s.boundary ?? []).filter((b) => b.id.startsWith("lnk-"))]) {
        // (A spline with points off the plane runs through space: drawn, picked and snapped to where it is.)
        const high = splineHeightSamples(e);
        const lift = splineHeights(e);
        for (const poly of entityPolylines(e)) {
          const pts = poly.map((p, i) => new Vector3(p[0], p[1], high ? (high[Math.min(i, high.length - 1)] ?? 0) : 0).applyMatrix4(m));
          const into = e.construction ? dashed : e.id.startsWith("ref-") ? linked : active && s.defined?.has(e.id) ? held : solid;
          for (let i = 0; i < pts.length - 1; i++) into.push(...pts[i].toArray(), ...pts[i + 1].toArray());
          this.curveLines.push({ sketch: s.id, entity: e.id, pts });
        }
        if (active) {
          const all = pointsOf(e);
          // (A spline not picked: its two ends - none for a closed one. Picked: every point it is shaped by.)
          const shown = e.kind === "spline" && all.length > 2 && !this.openCurves.has(e.id) ? (e.closed ? [] : [all[0], all[all.length - 1]]) : all;
          for (const q of shown) this.sketchPoints.push({ sketch: s.id, entity: e.id, p: q.p, pos: new Vector3(q.at[0], q.at[1], lift && q.p.startsWith("k") ? (lift[Number(q.p.slice(1))] ?? 0) : 0).applyMatrix4(m) });
        }
      }
      if (solid.length) {
        const mat = this.lineMaterial(active ? 0xffffff : COLORS.sketch, active ? 2.2 : 1.6, !onTop);
        mat.transparent = true;
        this.sketchMats.push(mat);
        const l = new LineSegments2(new LineSegmentsGeometry().setPositions(solid), mat);
        l.renderOrder = 2;
        this.sketchGroup.add(l);
      }
      if (held.length) {
        const mat = this.lineMaterial(0x5fd38a, 2.2, !onTop);
        mat.transparent = true;
        this.sketchMats.push(mat);
        const l = new LineSegments2(new LineSegmentsGeometry().setPositions(held), mat);
        l.renderOrder = 2;
        this.sketchGroup.add(l);
      }
      if (linked.length) {
        const mat = this.lineMaterial(COLORS.linked, active ? 2.2 : 1.6, !onTop);
        mat.transparent = true;
        this.sketchMats.push(mat);
        const l = new LineSegments2(new LineSegmentsGeometry().setPositions(linked), mat);
        l.renderOrder = 2;
        this.sketchGroup.add(l);
      }
      if (dashed.length) {
        // As wide as the sketch's other lines: told
        // from them by its dashes and its colour, not by being faint.
        const mat = this.lineMaterial(COLORS.construction, active ? 2.2 : 1.6, !onTop);
        mat.transparent = true;
        mat.dashed = true;
        mat.dashSize = wpp * 9;
        mat.gapSize = wpp * 5;
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
        depthTest: !fresh.has(s.id) || active,
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
        fill.userData = { sketch: s.id, region: r.index, area: r.area, fresh: fresh.has(s.id) };
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
    const kindOf = (id: string) => this.construction.planes.find((c) => c.id === id)?.kind ?? "offset";
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
      // How it was made, at its corner: each kind of plane has its own mark.
      if (!origin) {
        const mark = new Sprite(planeMarkMaterial(kindOf(id)));
        // Small, in the plane's corner: it grows and shrinks with the zoom like the plane.
        mark.position.set(-0.48, 0.48, 0);
        mark.scale.set(PLANE_MARK_SIZE, PLANE_MARK_SIZE, 1);
        mark.renderOrder = 4;
        mesh.add(mark);
      }
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
  /** Planes moved by hand: drawn where they were put, not where what they were made from says. */
  private planePlaced = new Set<string>();

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
      // What it was made from says where its square is and how big (a face: in front of it, half as big again);
      // one moved by hand is where it was put.
      const info = m.userData.origin ? undefined : this.construction.planes.find((c) => c.id === id);
      let size = m.userData.origin ? wpp * 120 : (info?.size ?? this.planeSizes.get(id));
      let mid = m.userData.origin ? undefined : this.planePlaced.has(id) ? this.planeCentres.get(id) : (info?.at ?? this.planeCentres.get(id));
      if (size === undefined || (!m.userData.origin && mid === undefined)) {
        // (Nothing says: by the model as it is now - and kept so.)
        const box = this.bounds();
        if (size === undefined) {
          size = box.isEmpty() ? wpp * 160 : box.getSize(new Vector3()).length() * 0.6;
          this.planeSizes.set(id, size);
        }
        if (mid === undefined) {
          mid = box.isEmpty() ? p.origin : (box.getCenter(new Vector3()).toArray() as Vec3);
          this.planeCentres.set(id, mid);
        }
      }
      // Centred where the middle of the model (as it was) falls on the plane - a
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

  /** The middle of a construction plane's square as drawn (on the plane). */
  planeShownAt(id: string): Vec3 | undefined {
    const p = this.planeOf(id);
    if (!p) return undefined;
    const mid = this.planePlaced.has(id) ? this.planeCentres.get(id) : (this.construction.planes.find((c) => c.id === id)?.at ?? this.planeCentres.get(id));
    if (!mid || ORIGIN_PLANES[id]) return p.origin;
    const n = new Vector3(...p.normal).normalize();
    const c = new Vector3(...mid);
    return c.addScaledVector(n, -c.clone().sub(new Vector3(...p.origin)).dot(n)).toArray() as Vec3;
  }

  /** A moved (or copied) plane's square goes with it - the size of the one it came from. */
  showPlaneAt(id: string, at: Vec3, like = id): void {
    this.planeCentres.set(id, at);
    this.planePlaced.add(id);
    const s = this.planeShownSize(like);
    if (s !== undefined) this.planeSizes.set(id, s);
    this.requestRender();
  }

  /** How big a construction plane's square is drawn. */
  planeShownSize(id: string): number | undefined {
    return this.construction.planes.find((c) => c.id === id)?.size ?? this.planeSizes.get(id);
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
    // The curves picked changed: a spline among them shows its points, one let go only its ends (the sketch is drawn again).
    const open = new Set(selected.flatMap((h) => (h.kind === "curve" || h.kind === "point" ? [h.entity] : [])));
    if (open.size !== this.openCurves.size || [...open].some((id) => !this.openCurves.has(id))) {
      const was = this.openCurves;
      this.openCurves = open;
      const changed = (id: string) => was.has(id) !== open.has(id);
      const sk = this.activeSketch ? this.sketches.find((s) => s.id === this.activeSketch) : undefined;
      if (sk?.entities.some((e) => e.kind === "spline" && e.points.length > 2 && changed(e.id))) this.setSketches(this.sketches, this.activeSketch, this.freshSketches);
    }
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
    const add0 = (h: Highlight, color: number, opacity: number) => {
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
      if (h.kind === "origin") {
        const dot = new Points(new BufferGeometry().setFromPoints([new Vector3(0, 0, 0)]), dotMaterial({ color, size: 13, depthTest: false }));
        dot.renderOrder = 6;
        this.highlightGroup.add(dot);
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
    // (A body shown moved - an assembly's pose: what is lit of it is moved with it.)
    const add = (h: Highlight, color: number, opacity: number) => {
      const n0 = this.highlightGroup.children.length;
      add0(h, color, opacity);
      const m = "body" in h ? this.poses?.get(h.body) : undefined;
      if (!m) return;
      for (const o of this.highlightGroup.children.slice(n0)) {
        o.matrixAutoUpdate = false;
        o.matrix.fromArray(m);
        o.matrixWorldNeedsUpdate = true;
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

  /** The model's box (the bodies shown), or null when there are none. */
  modelBounds(): { min: Vec3; max: Vec3 } | null {
    const box = new Box3();
    for (const b of this.visibleBodies()) box.expandByObject(b.mesh);
    return box.isEmpty() ? null : { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 };
  }

  /** The per-frame work a headset frame needs too (handles kept their size, and so on). */
  xrFrame(): void {
    this.frameHooks.forEach((f) => f());
  }

  /** What the headset leaves out (and the page had shown), to put back after. */
  private xrHidden: Object3D[] = [];

  /** In the headset only the bodies show (no grid, axes, sketches, planes or highlights); back on the page, as it was. */
  xrMode(on: boolean): void {
    if (on) {
      this.xrHidden = [this.grid.mesh, this.axesGroup, this.imageGroup, this.constructionGroup, this.sketchGroup, this.highlightGroup, this.overlay].filter((o) => o.visible);
      for (const o of this.xrHidden) o.visible = false;
    } else {
      for (const o of this.xrHidden) o.visible = true;
      this.xrHidden = [];
      this.grid.mesh.visible = settings.value.showGrid;
    }
    this.dirty = true;
  }

  private setRay(x: number, y: number): void {
    const ndc = new Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /** Set while the pointer only hovers: picking skips the near-miss search that taps get. */
  hovering = false;

  /**
   * Under the pointer, the section's own cut face (the hatched cap, where it
   * is drawn): the point on it, or null where the tap lands on anything else
   * (a face in front of the cut, empty space, past a body's outline).
   */
  cutAt(x: number, y: number): Vec3 | null {
    const clip = this.clip;
    if (!clip) return null;
    this.setRay(x, y);
    const ray = this.raycaster.ray;
    const at = ray.intersectPlane(clip, new Vector3());
    if (!at) return null;
    const d = at.distanceTo(ray.origin);
    const near = this.cam.distance * 1e-4;
    const front = this.raycaster.intersectObjects(this.visibleBodies().map((b) => b.mesh), false).find((h) => clip.distanceToPoint(h.point) >= 0);
    if (front && front.distance < d - near) return null;
    // Inside a body there: from the cut on along the ray, its surface is crossed an odd number of times.
    const from = new Raycaster(at.clone().addScaledVector(ray.direction, near), ray.direction.clone());
    for (const b of this.visibleBodies()) {
      if (!b.cap.visible) continue;
      const m = b.mesh.material as MeshStandardMaterial;
      const side = m.side;
      m.side = DoubleSide;
      const hits = from.intersectObject(b.mesh, false);
      m.side = side;
      // (A ray through a seam between two triangles meets both: counted once.)
      let n = 0;
      let last = -Infinity;
      for (const h of hits) {
        if (h.distance - last > near) n++;
        last = h.distance;
      }
      if (n % 2 === 1) return at.toArray() as Vec3;
    }
    return null;
  }

  /** Pick what's under the pointer. Edges and curves win within the tolerance. */
  /**
   * The face of every body under the point at the nearest depth: more than one
   * where bodies share a face's place (a bolt flush with the flange it's to
   * cut). The nearest first, one per body.
   */
  facesAt(x: number, y: number): PickHit[] {
    if (settings.value.shader === "wireframe") return [];
    this.setRay(x, y);
    const hits = this.raycaster.intersectObjects(this.visibleBodies().map((b) => b.mesh), false).filter((h) => !this.clip || this.clip.distanceToPoint(h.point) >= 0);
    const near = this.cam.distance * 1e-3;
    const out: PickHit[] = [];
    for (const h of hits) {
      if (h.distance - hits[0].distance > near) break;
      const body = h.object.userData.body as string;
      if (h.faceIndex == null || out.some((o) => o.kind === "face" && o.body === body)) continue;
      const tri = h.faceIndex * 3;
      const g = this.bodies.get(body)?.data.faceGroups.find((g) => tri >= g.start && tri < g.start + g.count);
      if (g) out.push({ kind: "face", body, face: g.face, point: h.point.toArray() as Vec3 });
    }
    return out;
  }

  pick(x: number, y: number, opts: PickOptions = {}): PickHit | null {
    const { edgeTolPx = 8, profiles = true, bodies = true, edges = true, curves = false, planes = true, axes = true, vertices = edges, planesFirst = false } = opts;
    this.setRay(x, y);
    // The origin, tapped near it on screen: it wins (a point you mean exactly).
    if (opts.origin) {
      const s = new Float64Array(2);
      if (this.projector()(0, 0, 0, s) && Math.hypot(s[0] - x, s[1] - y) < Math.max(12, edgeTolPx)) return { kind: "origin", point: [0, 0, 0] };
    }
    // A plane of the project's own, where the tap lands on one: the origin
    // planes draw over everything and covered it (a plane 18 up, tapped from
    // the top, gave the floor; they have buttons in the card as well). A
    // sketch's shape on it still comes first (tapped to carry on with it).
    let ownPlane: PickHit | null = null;
    if (planes && planesFirst) {
      const hits = this.raycaster.intersectObjects(this.planeMeshes, false);
      const own = hits.find((h) => !h.object.userData.origin);
      if (own) ownPlane = { kind: "plane", id: own.object.userData.plane, point: own.point.toArray() as Vec3 };
      else if (hits[0]) return { kind: "plane", id: hits[0].object.userData.plane, point: hits[0].point.toArray() as Vec3 };
    }
    const visibleBodies = bodies && settings.value.shader !== "wireframe";
    const meshes = visibleBodies ? this.visibleBodies().map((b) => b.mesh) : [];
    const faceHit = this.raycaster.intersectObjects(meshes, false).find((h) => !this.clip || this.clip.distanceToPoint(h.point) >= 0);
    // Select Through: edges, corners and sketches behind the front faces can be picked.
    const faceDist = faceHit && !this.selectThrough ? faceHit.distance : Infinity;
    const near = this.cam.distance * 1e-3;

    if (bodies && vertices) {
      const v = this.pickVertex(x, y, edgeTolPx, faceDist);
      // A corner within a finger's reach - but a short edge tapped in its
      // middle (a 3 mm high box's upright edge) is the edge: the tap is much
      // nearer it than either end.
      if (v?.kind === "vertex" && edges) {
        const dist = (p: Vec3) => {
          const q = this.toScreen(new Vector3(...p));
          return q ? Math.hypot(q[0] - x, q[1] - y) : Infinity;
        };
        const dv = dist(v.point);
        const e = dv > 6 ? this.pickEdge(x, y, faceHit ? Math.max(5, edgeTolPx * 0.6) : edgeTolPx, faceDist) : null;
        if (e && dist(e.point) + 5 < dv) return e;
      }
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
      // A fresh sketch (drawn on top) is found behind a face too.
      const ph = this.raycaster.intersectObjects(this.profileMeshes, false).filter((h) => h.distance <= faceDist + near || h.object.userData.fresh);
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
      const near: { d: number; point: Vector3 }[] = [];
      const edge = this.pickEdge(x, y, faceHit ? Math.max(5, edgeTolPx * 0.6) : edgeTolPx, faceDist, near);
      // Over a face, the finger between two edges about as near either side -
      // the middle of a narrow strip (a 3 mm round, 21 px across, tapped in
      // its middle, gave one of its edges every time): the strip is meant.
      const strip = () => {
        const q = near[0] && this.toScreen(near[0].point);
        if (!q) return false;
        return near.slice(1).some((o) => {
          const r = this.toScreen(o.point);
          return !!r && o.d < near[0].d * 1.5 + 1 && (q[0] - x) * (r[0] - x) + (q[1] - y) * (r[1] - y) < 0;
        });
      };
      if (edge && !(faceHit && strip())) return edge;
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
    if (ownPlane) return ownPlane;
    if (planes) {
      const hit = this.raycaster.intersectObjects(this.planeMeshes, false)[0];
      if (hit && hit.distance <= faceDist) return { kind: "plane", id: hit.object.userData.plane, point: hit.point.toArray() as Vec3 };
    }
    return null;
  }

  /**
   * A sketch's shape at or right beside the pointer that is too narrow there to be tapped without tapping its own
   * outline - the frame between a face's edge and a small offset of it, a letter's stroke: that shape. (Its lines
   * and the body's edges took every tap; to pick it, the view had to be zoomed right in on it.) Null where the shape under the pointer is wide enough to tap, or there is none.
   */
  thinProfileNear(x: number, y: number, tol: number): PickHit | null {
    if (!this.profileMeshes.length) return null;
    const only = { curves: false, edges: false, vertices: false, planes: false, axes: false, images: false, edgeTolPx: 0 } as const;
    const at = (px: number, py: number) => {
      const h = this.pick(px, py, only);
      return h?.kind === "profile" ? h : null;
    };
    const same = (a: PickHit | null, b: PickHit) => a?.kind === "profile" && b.kind === "profile" && a.sketch === b.sketch && a.region === b.region;
    const area = (h: PickHit) => (h.kind === "profile" ? ((this.profileMeshes.find((m) => m.userData.sketch === h.sketch && m.userData.region === h.region)?.userData.area as number | undefined) ?? Infinity) : Infinity);
    // The shapes at the pointer and round it, as far as a tap's reach: the smallest of them is the one meant.
    const found: { h: PickHit; x: number; y: number }[] = [];
    const reach = Math.max(4, tol);
    for (const r of [0, reach * 0.5, reach]) {
      for (let k = 0; k < (r ? 8 : 1); k++) {
        const [px, py] = [x + r * Math.cos((k * Math.PI) / 4), y + r * Math.sin((k * Math.PI) / 4)];
        const h = at(px, py);
        if (h && !found.some((f) => same(f.h, h))) found.push({ h, x: px, y: py });
      }
    }
    // (Right on a shape that is wide enough to tap: its line was meant, not a narrow neighbour's.)
    const under = found[0] && found[0].x === x && found[0].y === y ? found[0] : null;
    const narrow = (f: { h: PickHit; x: number; y: number }, by = 2 * reach) => [0, 1, 2, 3].some((k) => {
      const [dx, dy] = [by * Math.cos((k * Math.PI) / 4), by * Math.sin((k * Math.PI) / 4)];
      return !same(at(f.x + dx, f.y + dy), f.h) && !same(at(f.x - dx, f.y - dy), f.h);
    });
    found.sort((a, b) => area(a.h) - area(b.h));
    // One no wider than a tap's own reach - a hair of a frame, seen from far off: it is meant even from just beside
    // it, on the wide shape next to it (there is no tapping it otherwise; a double tap on its line opens the sketch).
    const hair = found.find((f) => f !== under && narrow(f, reach));
    if (hair) return hair.h;
    if (under) return narrow(under) ? under.h : null;
    for (const f of found) {
      // Narrow there: some way across it, two taps' reach either side of the spot are both off it.
      if (narrow(f)) return f.h;
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
        if (d < tol && (!best || d < best.d)) {
          // Where on the piece the pointer is (not the piece's start: a straight line is one piece, and its far
          // end stood for it - "further away than the face it is drawn on", so the face was picked, not the line).
          // (Nearest the pointer's own line of sight: right in perspective too, however long the piece.)
          const at = new Vector3();
          this.raycaster.ray.distanceSqToSegment(A, B, undefined, at);
          best = { d, c, p: at };
        }
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
   * every body - 10–14 ms a pick for a ruler's 11 000 edges).
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
      // (A body shown moved is picked by its faces only: its corners and edges are known where it was modelled.)
      if (this.hiddenIds.has(id) || this.poses?.has(id)) continue;
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

  /** The edge nearest the pointer (within tolPx, not hidden); `near` gets the nearest few, the nearest first. */
  private pickEdge(x: number, y: number, tolPx: number, faceDist: number, near?: { d: number; point: Vector3 }[]): PickHit | null {
    // The nearest point of each edge near the pointer.
    const per = new Map<string, { d: number; body: string; edge: number; point: Vector3; depth: number }>();
    const a = new Vector3();
    const b = new Vector3();
    const camPos = this.camera.position;
    const viewDir = this.cam.viewDir();
    const proj = this.projector();
    const S = new Float64Array(2);
    const sa: [number, number] = [0, 0];
    const sb: [number, number] = [0, 0];
    for (const [id, { data }] of this.bodies) {
      if (this.hiddenIds.has(id) || this.poses?.has(id)) continue;
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
          per.set(key, { d, body: id, edge: g.edge, point: w, depth });
        }
      }
    }
    // The nearest one nothing covers (the allowance above lets an edge just
    // behind a thin wall through). Two on the same pixels (a frame's front
    // and back edge, seen from straight above): the one nearer the eye - the
    // tap just off the face took the hidden one under it.
    const sorted = [...per.values()].sort((p, q) => (Math.abs(p.d - q.d) < 1 ? p.depth - q.depth : p.d - q.d)).slice(0, 6);
    const best = sorted.find((c) => this.uncovered(c.point));
    if (near && best) for (const c of sorted) if (c === best || (c.d > best.d && this.uncovered(c.point))) near.push({ d: c.d, point: c.point });
    this.setRay(x, y);
    return best ? { kind: "edge", body: best.body, edge: best.edge, point: best.point.toArray() as Vec3 } : null;
  }

  /** Nothing drawn lies in front of this point (a few pixels' slack). Moves the ray. */
  private uncovered(p: Vector3): boolean {
    if (settings.value.shader === "wireframe" || this.selectThrough) return true;
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
  /**
   * The view as a PNG, with see-through marks at the bottom right: the
   * project's name, the isolated bodies' names (when isolating), and the
   * superGeometry.app logo and name.
   */
  async screenshot(label?: { project: string; isolated?: string[] }): Promise<Blob | null> {
    const logo = await watermarkLogo();
    // Render and copy straight away (the drawing buffer isn't kept after this task).
    this.render();
    const out = document.createElement("canvas");
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const g = out.getContext("2d");
    if (!g) return new Promise((resolve) => this.canvas.toBlob(resolve, "image/png"));
    g.drawImage(this.canvas, 0, 0);
    // Sized like the app's own name at the top (scaled to the picture's pixels).
    const px = this.canvas.width / Math.max(1, this.canvas.clientWidth);
    const pad = 14 * px;
    const icon = 26 * px;
    const font = (weight: number, size: number) => `${weight} ${size * px}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const right = out.width - pad;
    g.globalAlpha = 0.45;
    g.textBaseline = "middle";
    // Bottom line: logo, "superGeometry" and ".app", ending at the right edge.
    let y = out.height - pad - icon / 2;
    g.font = font(750, 20);
    const tld = g.measureText(".app").width;
    const name = g.measureText("superGeometry").width;
    g.fillStyle = "#3d8bff";
    g.fillText(".app", right - tld, y);
    g.fillStyle = "#cfd6e4";
    g.fillText("superGeometry", right - tld - name, y);
    if (logo) g.drawImage(logo, right - tld - name - 8 * px - icon, y - icon / 2, icon, icon);
    // Above it, right-aligned: the isolated bodies, then the project's name.
    g.textAlign = "right";
    const maxW = out.width * 0.6;
    const fit = (s: string) => {
      if (g.measureText(s).width <= maxW) return s;
      while (s.length > 1 && g.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
      return `${s.trimEnd()}…`;
    };
    y -= icon / 2 + 6 * px;
    const names = label?.isolated ?? [];
    if (names.length) {
      g.font = font(500, 13);
      g.fillStyle = "#cfd6e4";
      y -= 8 * px;
      g.fillText(fit(names.join(", ")), right, y);
      y -= 8 * px + 4 * px;
    }
    if (label?.project) {
      g.font = font(650, 16);
      g.fillStyle = "#e8e9ec";
      y -= 10 * px;
      g.fillText(fit(label.project), right, y);
    }
    g.textAlign = "left";
    g.globalAlpha = 1;
    return new Promise((resolve) => out.toBlob(resolve, "image/png"));
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
    const mat = new LineBasicMaterial({ color, transparent: true, depthWrite: false });
    // The axes are the background of whatever is made: a hair further from the eye than they are (a third of a
    // percent of the way to what is looked at), so a body's edge or a sketch's line that runs along one is drawn
    // whole, in its own colour. (Lying in the very same place, the two fought for each pixel - an edge along X came
    // out in dashes of red, a sketch line there lost its colour to the axis.)
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n  gl_Position.z += 3.0e-6 * gl_Position.w;");
    };
    mat.customProgramCacheKey = () => "axis-behind";
    const line = new LineSegments(geo, mat);
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

/**
 * A plane's mark: a small outline symbol for how it was made (and the
 * symmetry plane's) - like the view cube's buttons, no badge behind it.
 */
const PLANE_MARKS: Record<string, string> = { offset: "⇡", mid: "⇹", "3pt": "∴", curve: "∿", perp: "⊥", angle: "∠", parallel: "∥", symmetry: "⧖" };
/** Its size, as a part of the plane's width. */
export const PLANE_MARK_SIZE = 0.024;
const markMats = new Map<string, SpriteMaterial>();
export function planeMarkMaterial(kind: string): SpriteMaterial {
  let m = markMats.get(kind);
  if (m) return m;
  const c = document.createElement("canvas");
  // Drawn large and scaled down smoothly: crisp when zoomed in (a 64 px one pixelated).
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = kind === "symmetry" ? "#a98bd6" : "#8f96a3";
  g.font = "176px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(PLANE_MARKS[kind] ?? "?", 128, 140);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  m = new SpriteMaterial({ map: tex, transparent: true, depthTest: false, opacity: 0.4 });
  markMats.set(kind, m);
  return m;
}

/** The app's mark, the cape (public/icon.svg without its dark tile), for the screenshot watermark. */
let logoImage: Promise<HTMLImageElement | null> | null = null;
function watermarkLogo(): Promise<HTMLImageElement | null> {
  logoImage ??= fetch("icon.svg")
    .then((r) => (r.ok ? r.text() : Promise.reject()))
    .then(
      (text) =>
        new Promise<HTMLImageElement | null>((resolve) => {
          // Drop the tile and crop to the cape.
          const svg = text.replace(/<rect[^>]*\/>/, "").replace(/viewBox="[^"]*"/, 'viewBox="3 8 58 48"');
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        }),
    )
    .catch(() => null);
  return logoImage;
}
