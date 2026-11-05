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
