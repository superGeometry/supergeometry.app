// The # part of the address that carries a packed project (supergeometry.app/#p=…).
// Small, read at every start; the packing itself (projectLink) loads only when needed.

export const SITE = "https://supergeometry.app/";
export const KEY = "p";

/** The packed project in this address's # part, if there is one. */
export function linkedProject(hash = location.hash): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get(KEY);
}

/** The address without the packed project (a reload doesn't open it again). */
export function clearLinkedProject(): void {
  history.replaceState(null, "", location.pathname + location.search);
}
