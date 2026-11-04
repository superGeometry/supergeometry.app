// The Copy switch next to a Move/Rotate gimbal. While it's on, a gimbal drag
// leaves the original where it was and makes a copy; the copy is then
// selected, so the next drag (or typed value + Enter) copies again.

import type { Vec3 } from "../doc/types";
import { icons } from "../ui/icons";
import type { Viewport } from "../view/viewport";

/** Shared by bodies, sketches and images: the switch stays as you left it. */
export const copyMode = { on: false };

export class CopyToggle {
  private btn = document.createElement("button");
  private hook = () => this.layout();

  constructor(
    private view: Viewport,
    /** Where the gimbal is (world). */
    private at: () => Vec3 | null,
    private onChange?: (on: boolean) => void,
  ) {
    this.btn.className = "copy-toggle";
    this.btn.title = "Copy: drag to make copies (each Enter or release makes one, then keep dragging)";
    this.btn.innerHTML = `${icons.copy}<span>Copy</span>`;
    // Never let the press reach the viewport (it would start a drag or deselect).
    this.btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      copyMode.on = !copyMode.on;
      this.paint();
      this.onChange?.(copyMode.on);
    });
    this.paint();
    document.body.append(this.btn);
    view.frameHooks.add(this.hook);
    view.helpers.add(this);
    this.layout();
  }

  private paint(): void {
    this.btn.classList.toggle("on", copyMode.on);
  }

  private layout(): void {
    const w = this.at();
    const s = w && this.view.toScreen(w);
    this.btn.hidden = !s;
    if (s) {
      const r = this.view.canvas.getBoundingClientRect();
      // Up and to the right of the gimbal, clear of its arrows.
      this.btn.style.transform = `translate(${Math.round(r.left + s[0] + 70)}px, ${Math.round(r.top + s[1] - 96)}px)`;
    }
  }

  dispose(): void {
    this.view.helpers.delete(this);
    this.view.frameHooks.delete(this.hook);
    this.btn.remove();
  }
}
