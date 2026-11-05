// What kind of device the app runs on, for small per-device adjustments.

/** A VR/AR headset's browser (Meta Quest, Pico, Vision Pro's Safari reports as a Mac). */
export const isHeadset = typeof navigator !== "undefined" && /OculusBrowser|Quest|Pico|MetaQuest/i.test(navigator.userAgent);

/** Touch-first screens: phones, tablets, headsets (their controllers aim like a laser, not a mouse). */
export const isCoarse = isHeadset || (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches);

/**
 * Pointer pick tolerance in pixels: fingers are fat, and a controller's
 * ray wobbles more than a mouse.
 */
export function pickTolerance(type: string): number {
  if (type === "touch") return 18;
  return isHeadset ? 14 : 8;
}

/**
 * Phones, tablets and headsets (not computers, touchscreen laptops included):
 * a touch-first device by its own description. iPads say "Macintosh" but have
 * touch points; one with a trackpad still counts.
 */
export const isTouchDevice =
  isHeadset ||
  (typeof navigator !== "undefined" &&
    (/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)));

/**
 * Three kinds of screen, by the page's size in CSS pixels (what the browser
 * reports, after display scaling) — the layout adapts to each:
 *   phone   – phones upright (360–440 wide) or sideways (≤ 500 tall), flip
 *             phones, a folded foldable: one thing at a time, fixed places.
 *   tablet  – tablets (iPad 768–1024, iPad Pro up to 1366) and small laptops
 *             (1280–1536 wide): floating cards beside what you work on.
 *   desktop – monitors and TVs (≥ 1600 wide, ≥ 800 tall): room for everything.
 * The phone line is the same as the stylesheet's phone layout (720 / 500).
 */
export type ScreenClass = "phone" | "tablet" | "desktop";

export function screenClass(w = window.innerWidth, h = window.innerHeight): ScreenClass {
  if (w <= 720 || h <= 500) return "phone";
  if (w >= 1600 && h >= 800) return "desktop";
  return "tablet";
}

/** Keeps <html data-screen="…"> up to date (for the stylesheet), and says when it changes. */
export function watchScreenClass(onChange?: (c: ScreenClass) => void): void {
  const set = () => {
    const c = screenClass();
    if (document.documentElement.dataset.screen === c) return;
    document.documentElement.dataset.screen = c;
    onChange?.(c);
  };
  set();
  window.addEventListener("resize", set);
}
