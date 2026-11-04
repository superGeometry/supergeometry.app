import { DoubleSide, Matrix4, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from "three";
import type { PlaneDef } from "../doc/types";
import { planeY } from "../geom";

/**
 * Infinite-looking grid that adapts its spacing to the zoom level (powers of
 * ten, 0.001 mm … 1 000 000 mm), or stays at a locked step. It lies on the
 * ground, or on the active sketch plane while sketching.
 */
export class AdaptiveGrid {
  readonly mesh: Mesh;
  /** Current minor step in mm (also used for grid snapping). */
  step = 1;
  locked = false;
  lockedStep = 1;
  private plane: PlaneDef = { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] };
  private material: ShaderMaterial;

  constructor() {
    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: {
        uStep: { value: 1 },
        uFade: { value: 0 },
        uCenter: { value: [0, 0] },
        uRadius: { value: 100 },
        // Quad centre (u, v) on the plane and its size: turns quad coords into plane coords.
        uLocal: { value: [0, 0, 1] },
      },
      vertexShader: /* glsl */ `
        uniform vec3 uLocal;
        varying vec2 vUv;
        void main() {
          vUv = uLocal.xy + position.xy * uLocal.z;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uStep;
        uniform float uFade;
        uniform vec2 uCenter;
        uniform float uRadius;
        varying vec2 vUv;
        float lines(vec2 p, float s) {
          vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          vec2 p = vUv;
          float minor = lines(p, uStep) * (1.0 - uFade);
          float mid = lines(p, uStep * 10.0);
          float major = lines(p, uStep * 100.0);
          float a = max(max(minor * 0.22, mid * 0.38), major * 0.55);
          float d = length(p - uCenter) / uRadius;
          a *= 1.0 - smoothstep(0.55, 1.0, d);
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.78), a);
        }`,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = -1;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
  }

  setPlane(p: PlaneDef): void {
    this.plane = p;
  }

  /** Recompute spacing and placement for the current view. */
  update(worldPerPixel: number, target: Vector3, distance: number, eye?: Vector3): void {
    let fade = 0;
    if (this.locked) {
      this.step = this.lockedStep;
    } else {
      // Minor lines at least ~10 px apart; fade them in as they get there.
      const raw = worldPerPixel * 10;
      const exp = Math.log10(raw);
      this.step = Math.pow(10, Math.ceil(exp));
      fade = 1 - (Math.ceil(exp) - exp);
      fade = Math.max(0, Math.min(1, (fade - 0.6) / 0.4));
    }
    const n = new Vector3(...this.plane.normal);
    const x = new Vector3(...this.plane.xDir);
    const y = new Vector3(...planeY(this.plane));
    const o = new Vector3(...this.plane.origin);
    // Centre the quad under the camera target (projected on the plane).
    const rel = target.clone().sub(o);
    const cu = rel.dot(x);
    const cv = rel.dot(y);
    // Big enough to reach the horizon from where the camera is (it can sit far
    // above the plane while its target is close, after zooming towards a point).
    const height = eye ? Math.abs(eye.clone().sub(o).dot(n)) : 0;
    const size = Math.max(distance * 6, height * 12, this.step * 400);
    // The quad spans local coords [cu ± size/2]; vUv carries plane coordinates.
    const m = new Matrix4().makeBasis(x, y, n).setPosition(o);
    const local = new Matrix4().makeScale(size, size, 1).setPosition(cu, cv, 0);
    this.mesh.matrix.copy(m.multiply(local));
    this.mesh.matrixWorldNeedsUpdate = true;
    this.material.uniforms.uStep.value = this.step;
    this.material.uniforms.uFade.value = fade;
    this.material.uniforms.uCenter.value = [cu, cv];
    this.material.uniforms.uRadius.value = size / 2;
    this.material.uniforms.uLocal.value = [cu, cv, size];
  }
}
