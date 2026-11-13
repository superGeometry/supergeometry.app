// Color → Custom…: a colour card like the app's other windows (the browser's
// own colour window looked different on every device). A square for how pale
// or dark, a strip for the hue, the hex code to type, and the body changing
// as you go. Done keeps it; Cancel (or Esc, or a tap outside) puts it back.

import { el, textButton } from "./ui";
import { textField } from "./textField";

type HSV = [number, number, number];

function hexToHsv(hex: string): HSV {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];
}

function hsvToHex([h, s, v]: HSV): string {
  const f = (k: number) => {
    const x = (k + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(x, 4 - x, 1))) * 255);
  };
  return "#" + [f(5), f(3), f(1)].map((c) => c.toString(16).padStart(2, "0")).join("");
}

const HEX = /^#?[0-9a-f]{6}$/i;

/**
 * Resolves with the colour chosen, or null if cancelled. `live` gets each
 * colour while choosing (to show it on the model).
 */
export function pickColor(title: string, start: string, live: (hex: string) => void): Promise<string | null> {
  return new Promise((resolve) => {
    let hsv = hexToHsv(HEX.test(start) ? start : "#888888");
    const back = el("div", "dialog-back see-through");
    const box = el("div", "dialog color-dialog");
    // The grip along the top (like the tool cards'): drag the window aside to see the body.
    const grip = el("div", "color-grip");
    grip.title = "Drag to move";
    grip.append(el("span", ""));
    box.append(grip, el("div", "panel-title", title));
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const r = box.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {
        // (no live pointer to hold)
      }
      const move = (m: PointerEvent) => {
        // Kept whole on screen.
        const x = Math.min(window.innerWidth - r.width, Math.max(0, m.clientX - dx));
        const y = Math.min(window.innerHeight - r.height, Math.max(0, m.clientY - dy));
        box.style.position = "fixed";
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });

    const sv = el("div", "color-sv");
    const svDot = el("div", "color-dot");
    sv.append(svDot);
    const hue = el("div", "color-hue");
    const hueDot = el("div", "color-dot");
    hue.append(hueDot);

    const row = el("div", "color-row");
    const preview = el("span", "swatch color-preview");
    const input = textField("color-hex");
    input.maxLength = 7;
    row.append(preview, input);

    const show = (fromInput = false) => {
      const hex = hsvToHex(hsv);
      sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex([hsv[0], 1, 1])})`;
      svDot.style.left = `${hsv[1] * 100}%`;
      svDot.style.top = `${(1 - hsv[2]) * 100}%`;
      svDot.style.background = hex;
      hueDot.style.left = `${(hsv[0] / 360) * 100}%`;
      hueDot.style.background = hsvToHex([hsv[0], 1, 1]);
      preview.style.background = hex;
      if (!fromInput) input.value = hex;
      live(hex);
    };

    // Drag on the square or the strip (a finger or a mouse).
    const drag = (target: HTMLElement, at: (fx: number, fy: number) => void) => {
      const move = (e: PointerEvent) => {
        const r = target.getBoundingClientRect();
        at(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
        show();
      };
      target.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          // (no live pointer to hold)
        }
        move(e);
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
      });
    };
    drag(sv, (fx, fy) => (hsv = [hsv[0], fx, 1 - fy]));
    drag(hue, (fx) => (hsv = [Math.min(359.9, fx * 360), hsv[1], hsv[2]]));
    input.addEventListener("input", () => {
      const v = input.value.trim();
      if (!HEX.test(v)) return;
      hsv = hexToHsv(v.startsWith("#") ? v : `#${v}`);
      show(true);
    });

    const buttons = el("div", "panel-buttons");
    const close = (v: string | null) => {
      back.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const done = textButton("Done", "Enter", () => close(hsvToHex(hsv)), true);
    buttons.append(textButton("Cancel", "Esc", () => close(null)), done);
    for (const b of buttons.querySelectorAll("button")) b.type = "button";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.preventDefault(), close(null));
      else if (e.key === "Enter") (e.preventDefault(), done.click());
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    back.addEventListener("pointerdown", (e) => e.target === back && close(null));

    box.append(sv, hue, row, buttons);
    back.append(box);
    document.body.append(back);
    show();
  });
}
