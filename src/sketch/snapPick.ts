// Which snap point a tap lands on, among those within reach (distances in
// screen pixels). Pure: tests/desklamp.test.ts.

export interface SnapCandidate {
  /** Screen distance from the pointer, in pixels. */
  d: number;
  /** A point of a curve (drawing there adds a Coincident). */
  ref?: unknown;
  /** The middle of a line (kept there). */
  mid?: string;
  /** A point of the model or the origin (held there). */
  model?: boolean;
}

/**
 * The nearest candidate within `tol`. Two on one spot (within half a pixel,
 * e.g. a line's end and the middle of a rectangle's side): the one a drawing
 * there can be kept on wins - a circle centred there took the side's middle
 * (nothing to keep) and stayed behind when the line moved.
 */
export function nearestSnap<T extends SnapCandidate>(cands: T[], tol: number): T | null {
  const keeps = (x: SnapCandidate) => !!(x.ref || x.mid || x.model);
  let best: T | null = null;
  for (const c of cands) {
    if (c.d >= tol) continue;
    if (!best || c.d < best.d - 0.5 || (c.d < best.d + 0.5 && keeps(c) && !keeps(best))) best = c;
  }
  return best;
}
