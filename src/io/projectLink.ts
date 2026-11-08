// A project packed into a link: supergeometry.app/#p=… opens it in the app.
// The project's text, compressed (deflate) and written in letters a link
// keeps as they are (base64url). It sits after the # so it never reaches a
// server - the page reads it - and a link has room for a fair-sized project.

export const SITE = "https://supergeometry.app/";
const KEY = "p";

function toBase64Url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}

async function through(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The link that opens this project (null where the browser can't compress). */
export async function projectLink(json: string): Promise<string | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const packed = await through(new TextEncoder().encode(json), new CompressionStream("deflate-raw"));
    return `${SITE}#${KEY}=${toBase64Url(packed)}`;
  } catch {
    return null;
  }
}

/** The packed project in this address's # part, if there is one. */
export function linkedProject(hash = location.hash): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get(KEY);
}

/** The project's text back from what projectLink packed. */
export async function unpackProject(packed: string): Promise<string> {
  const text = await through(fromBase64Url(packed), new DecompressionStream("deflate-raw"));
  return new TextDecoder().decode(text);
}

/** The address without the packed project (a reload doesn't open it again). */
export function clearLinkedProject(): void {
  history.replaceState(null, "", location.pathname + location.search);
}
