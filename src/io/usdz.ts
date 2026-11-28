// USDZ: the bodies as the file Apple's AR viewer (AR Quick Look) opens - an iPhone or iPad has no AR in the browser
// itself, but it shows a USDZ file in the room at a tap. Loaded only when asked for (three.js's own exporter).
//
// The bodies' meshes with their colours, in metres with Y up (the app works in millimetres with Z up), so the model
// stands in the room at its true size.

import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Scene } from "three";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";

export interface UsdzBody {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** "#rrggbb" */
  color?: string;
  opacity?: number;
}

export async function usdz(bodies: UsdzBody[]): Promise<Uint8Array> {
  const scene = new Scene();
  const root = new Group();
  // Z up to Y up, millimetres to metres.
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(0.001);
  scene.add(root);
  const made: { geometry: BufferGeometry; material: MeshStandardMaterial }[] = [];
  for (const b of bodies) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(b.positions, 3));
    geometry.setIndex(new BufferAttribute(b.indices, 1));
    geometry.computeVertexNormals();
    const material = new MeshStandardMaterial({ color: new Color(b.color ?? "#9aa3b2"), roughness: 0.6, metalness: 0.05, transparent: (b.opacity ?? 1) < 1, opacity: b.opacity ?? 1 });
    const mesh = new Mesh(geometry, material);
    mesh.name = b.name.replace(/[^A-Za-z0-9_]/g, "_") || "Body";
    root.add(mesh);
    made.push({ geometry, material });
  }
  scene.updateMatrixWorld(true);
  try {
    const out = await new USDZExporter().parseAsync(scene, { quickLookCompatible: true } as never);
    return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
  } finally {
    for (const m of made) (m.geometry.dispose(), m.material.dispose());
  }
}

/** Can this browser open a USDZ file in AR at a tap (Safari on an iPhone or iPad)? */
export function quickLook(): boolean {
  try {
    return document.createElement("a").relList.supports("ar");
  } catch {
    return false;
  }
}
