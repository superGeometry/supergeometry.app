// Orbit centre: a button under the view cube. Tap it, then tap a body, a sketch
// or the ground: from then on the view turns about that point. Zoom to fit
// (or tapping empty space while choosing) goes back to turning about the view's centre.

import { BufferGeometry, Points, Vector3 } from "three";
import type { Viewport } from "../view/viewport";
import { dotMaterial } from "../view/viewport";
import { GROUND } from "../geom";
import { icons } from "./icons";

export class PivotButton {
  readonly el = document.createElement("button");
  private cursor = document.createElement("div");
  private choosing = false;
  private marker: Points;

  constructor(private view: Viewport, private toast: (text: string) => void) {
    this.el.className = "vc-roll bottom left pivot-btn";
    this.el.title = "Orbit centre: tap here, then tap where the view should turn around";
    this.el.innerHTML = icons.pivot;
    this.el.addEventListener("click", () => this.setChoosing(!this.choosing));
    this.cursor.className = "pivot-cursor";
    this.cursor.innerHTML = icons.pivot;
    this.cursor.hidden = true;
    document.body.append(this.cursor);
    this.marker = new Points(new BufferGeometry().setFromPoints([new Vector3()]), dotMaterial({ color: 0x3d8bff, size: 10 }));
    this.marker.renderOrder = 60;
    (this.marker.material as { depthTest: boolean }).depthTest = false;
    this.marker.visible = false;
    view.overlay.add(this.marker);
    // While choosing, the next press on the model picks the point (and goes nowhere else).
    view.canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.choosing || e.button !== 0) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        const r = view.canvas.getBoundingClientRect();
        this.pick(e.clientX - r.left, e.clientY - r.top);
      },
      true,
    );
    window.addEventListener("pointermove", (e) => {
      if (!this.choosing) return;
      this.cursor.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
    });
    window.addEventListener("keydown", (e) => e.key === "Escape" && this.choosing && this.setChoosing(false));
    view.frameHooks.add(() => this.layout());
  }

  private setChoosing(on: boolean): void {
    this.choosing = on;
    this.el.classList.toggle("on", on || !!this.view.cam.pivot);
    this.cursor.hidden = !on;
    this.view.canvas.style.cursor = on ? "crosshair" : "";
    if (on) this.toast("Tap a point on the model to turn the view around it");
  }

  private pick(x: number, y: number): void {
    const hit = this.view.pick(x, y, { edgeTolPx: 10, curves: true, planes: false, axes: false });
    const at = hit?.point ?? this.view.rayToPlane(x, y, GROUND);
    if (hit?.point || at) {
      this.view.cam.pivot = new Vector3(...(at as [number, number, number]));
    } else {
      this.view.cam.pivot = null;
    }
    this.setChoosing(false);
    this.view.requestRender();
  }

  private layout(): void {
    const p = this.view.cam.pivot;
    this.marker.visible = !!p;
    this.el.classList.toggle("on", this.choosing || !!p);
    if (p) {
      this.marker.position.copy(p);
      this.marker.updateMatrixWorld();
    }
  }
}
