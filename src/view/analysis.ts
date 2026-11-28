// Surface analysis in the view: zebra stripes (reflected stripes show where
// faces meet smoothly - a kink in a stripe is a crease, a jump a gap), a
// curvature map (blue hollow, green flat, red domed), and the overhang check
// for 3D printing (red: a face that leans out further than a printer can
// build without support, printing upwards from the floor).

import { ShaderMaterial, UniformsLib, UniformsUtils, Vector3 } from "three";

export type Analysis = "none" | "zebra" | "curvature" | "overhang";

/**
 * Curvature at each vertex of a mesh (1/mm), from how the normals turn along
 * its edges: (nᵢ − nⱼ)·(pᵢ − pⱼ) / |pᵢ − pⱼ|², the strongest of them (a
 * cylinder or sphere of radius r: 1/r). Positive where the surface bulges
 * out, negative in a hollow.
 * Faces are meshed apart, so a sharp edge between two faces doesn't count.
 */
export function curvatureOf(positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(n);
  const add = (i: number, j: number) => {
    const dx = positions[3 * i] - positions[3 * j];
    const dy = positions[3 * i + 1] - positions[3 * j + 1];
    const dz = positions[3 * i + 2] - positions[3 * j + 2];
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 < 1e-12) return;
    const k = ((normals[3 * i] - normals[3 * j]) * dx + (normals[3 * i + 1] - normals[3 * j + 1]) * dy + (normals[3 * i + 2] - normals[3 * j + 2]) * dz) / len2;
    if (Math.abs(k) > Math.abs(out[i])) out[i] = k;
    if (Math.abs(k) > Math.abs(out[j])) out[j] = k;
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    add(a, b);
    add(b, c);
    add(c, a);
  }
  return out;
}

const vertex = /* glsl */ `
#include <clipping_planes_pars_vertex>
attribute float curv;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vCurv;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vCurv = curv;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
`;

const fragment = /* glsl */ `
#include <clipping_planes_pars_fragment>
uniform int uKind;        // 0 zebra, 1 curvature, 2 overhang
uniform float uLean;      // overhang: the sine of the furthest lean from upright that prints without support
uniform float uBed;       // overhang: the height the model stands on (what lies on it needs no support)
uniform float uStripes;   // zebra: stripes round the view
uniform int uHorizontal;  // zebra: stripes across (1) or upright (0)
uniform float uScale;     // curvature: the curvature (1/mm) shown fully red / blue
uniform bool uOrtho;
uniform vec3 uViewDir;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vCurv;
const float PI = 3.14159265;
void main() {
  #include <clipping_planes_fragment>
  vec3 N = normalize(vNormalW);
  vec3 V = uOrtho ? normalize(uViewDir) : normalize(vWorld - cameraPosition);
  if (!gl_FrontFacing) N = -N;
  float light = 0.55 + 0.45 * max(dot(N, -V), 0.0);
  vec3 col;
  if (uKind == 0) {
    vec3 R = reflect(V, N);
    float u = uHorizontal == 1 ? asin(clamp(R.z, -1.0, 1.0)) / PI + 0.5 : atan(R.y, R.x) / (2.0 * PI) + 0.5;
    float s = fract(u * uStripes);
    // Soft-edged stripes (no shimmer where they're thin).
    float w = fwidth(u * uStripes);
    float band = smoothstep(0.5 - w, 0.5 + w, s) * (1.0 - smoothstep(1.0 - w, 1.0, s));
    col = mix(vec3(0.08), vec3(0.97), band) * (0.85 + 0.15 * light);
  } else if (uKind == 2) {
    // How far the face looks down: 0 for an upright wall, 1 for a ceiling. Past the limit it needs support - red;
    // within ten degrees of it, a warning yellow; what lies on the bed is held by the bed.
    float down = -N.z;
    float near = sin(max(asin(clamp(uLean, 0.0, 1.0)) - 0.1745, 0.0));
    vec3 fine = vec3(0.62, 0.66, 0.72);
    vec3 warn = vec3(0.98, 0.78, 0.22);
    vec3 bad = vec3(0.93, 0.22, 0.2);
    float onBed = step(vWorld.z, uBed + 0.05);
    float w = max(fwidth(down), 1e-4);
    col = mix(fine, warn, smoothstep(near - w, near + w, down));
    col = mix(col, bad, smoothstep(uLean - w, uLean + w, down));
    col = mix(col, fine, onBed * step(0.9, down));
    col *= light;
  } else {
    float t = clamp(vCurv / uScale, -1.0, 1.0);
    vec3 flat_ = vec3(0.25, 0.78, 0.35);
    col = t >= 0.0 ? mix(flat_, vec3(0.92, 0.2, 0.15), t) : mix(flat_, vec3(0.15, 0.35, 0.95), -t);
    col *= light;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** The material bodies wear while an analysis is on (it keeps the section's cut). */
export function analysisMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.common,
      {
        uKind: { value: 0 },
        uStripes: { value: 16 },
        uHorizontal: { value: 0 },
        uScale: { value: 0.1 },
        uLean: { value: Math.SQRT1_2 },
        uBed: { value: 0 },
        uOrtho: { value: false },
        uViewDir: { value: new Vector3(0, 0, -1) },
      },
    ]),
    vertexShader: vertex,
    fragmentShader: fragment,
    clipping: true,
  });
}
