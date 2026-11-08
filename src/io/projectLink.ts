// A project packed into a link: supergeometry.app/#p=… opens it in the app.
// It sits after the # so it never reaches a server - the page reads it.
//
// Kept short, so it fits in a post or a message:
//  - the long made-up ids ("extrude-mw6obrns-xqpb") become short ones ("~3"),
//    the same everywhere they're used (a body "~3:1" too), and long unique
//    ones again when the link is opened;
//  - numbers stay exactly as they are (rounding off even the float noise,
//    13.999999999999998, changed what some models rebuild into);
//  - it's compressed (deflate) with a dictionary of the words every project
//    file has ({"id":, "type":"extrude", …), so even a small one packs well;
//  - written in letters a link keeps as they are (base64url).
// The first letter is the packing's version: links made now must open later,
// so a new dictionary or step gets a new letter and the old ones stay readable.

import { deflateSync, inflateSync } from "fflate";

export const SITE = "https://supergeometry.app/";
const KEY = "p";
const VERSION = "A";

/** Version A's dictionary: the pieces every project file is made of, the most common last. Never change it. */
const DICT_A = new TextEncoder().encode(
  [
    '{"format":"super","version":2,"name":"',
    '"variables":[],"views":[],"units":"mm","hidden":[],"pins":[],"names":{},"colors":{}}',
    '"type":"thread"', '"type":"loft"', '"type":"sweep"', '"type":"split"', '"type":"axis"', '"type":"fillToPlane"', '"type":"replaceFace"', '"type":"scaleFace"', '"type":"deleteGeom"', '"type":"freeform"',
    '"type":"shell"', '"type":"chamfer"', '"type":"revolve"', '"type":"fillet"', '"type":"moveFace"', '"type":"transform"', '"type":"boolean"', '"type":"plane"',
    '"kind":"polygon"', '"kind":"offset"', '"kind":"mirror"', '"kind":"spline"', '"kind":"ellipse"', '"kind":"polyline"', '"kind":"arc"', '"kind":"axis"', '"kind":"face"', '"kind":"move"', '"kind":"linear"', '"kind":"circular"',
    '"op":"Polygon"', '"op":"Text"', '"op":"Spline"', '"op":"Arc"', '"op":"Ellipse"', '"op":"Constraint"', '"op":"Edit"', '"op":"Rectangle"', '"op":"Line"', '"op":"Circle"', '"op":"union"', '"op":"subtract"', '"op":"intersect"',
    '"type":"midpoint"', '"type":"fix"', '"type":"tangent"', '"type":"horizontal"', '"type":"vertical"', '"type":"coincident"', '"type":"dim"',
    '"thickness":', '"construction":true', '"closed":true', '"attachedTo":', '"tools":[', '"bodies":[', '"copy":false', '"translate":[', '"rotate":', '"expr":"', '"exprs":{', '"offset":', '"angle":', '"axis":', '"face":{',
    '"edges":[{"body":"', '"mid":[', '"dir":[', '"length":', '"radius":', '"faces":[{"body":"', '"area":', '"target":"',
    '"constraints":[', '"log":[{"op":"', '"n":1}]', '"w":', '"h":', '"rotation":0', '"pts":[[', '"curves":[', '"prop":"', '"value":',
    '"mode":"auto"', '"mode":"new"', '"mode":"cut"', '"mode":"join"', '"distance":', '"source":{"kind":"profile","sketch":"', '"regions":[{"c":[', '"a":',
    '"plane":{"origin":[0,0,0],"xDir":[1,0,0],"normal":[0,0,1]}', '"normal":[', '"center":[', '"origin":[', '"xDir":[',
    '"kind":"circle","center":[', '"r":', '"kind":"rect","center":[', '"kind":"line","a":[', '"b":[', '"e":"', '"p":"',
    '"name":"Extrude 0', '"type":"extrude"', '"name":"Sketch 0', '"type":"sketch"', '"entities":[{"id":"', '},{"id":"', '"features":[{"id":"',
  ].join(""),
);

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

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Every id given in the project (features, sketch entities, constraints…): an "id" field's value. */
function eachId(o: Json, fn: (id: string) => void): void {
  if (Array.isArray(o)) for (const x of o) eachId(x, fn);
  else if (o && typeof o === "object") {
    if (typeof o.id === "string") fn(o.id);
    for (const v of Object.values(o)) eachId(v, fn);
  }
}

/** Every string and key in the project (a short id must not be one of them). */
function eachWord(o: Json, fn: (w: string) => void): void {
  if (typeof o === "string") fn(o);
  else if (Array.isArray(o)) for (const x of o) eachWord(x, fn);
  else if (o && typeof o === "object")
    for (const [k, v] of Object.entries(o)) {
      fn(k);
      eachWord(v, fn);
    }
}

/**
 * Ids → short ones: "~" and a count ("~0", "~1"…), none the same as a word
 * already in the project, so opening the link can tell them apart.
 */
function shortIds(doc: Json): Map<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  eachWord(doc, (w) => taken.add(w));
  let n = 0;
  eachId(doc, (id) => {
    // A short id stays (it could be the same as a word in the file, renamed with it).
    if (id.length <= 3 || ids.has(id)) return;
    let s: string;
    do s = `~${(n++).toString(36)}`;
    while (taken.has(s));
    ids.set(id, s);
  });
  return ids;
}

/** Ids renamed (in values and in keys, parts of "a:b" too): made short for the link, long again when it's opened. */
function shrink(o: Json, ids: Map<string, string>): Json {
  const s = (t: string) => (t.includes(":") ? t.split(":").map((p) => ids.get(p) ?? p).join(":") : ids.get(t) ?? t);
  if (typeof o === "string") return s(o);
  if (Array.isArray(o)) return o.map((x) => shrink(x, ids));
  if (o && typeof o === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(o)) out[s(k)] = shrink(v, ids);
    return out;
  }
  return o;
}

/** The project's text packed for a link (the part after "#p="). */
export function packProject(json: string): string {
  const doc = JSON.parse(json) as Json;
  const ids = shortIds(doc);
  const small = JSON.stringify(shrink(doc, ids));
  return VERSION + toBase64Url(deflateSync(new TextEncoder().encode(small), { level: 9, dictionary: DICT_A }));
}

/**
 * The project's text back from packProject. The short ids become long unique
 * ones again: the same short ids are in every linked project, and the model's
 * steps are remembered by their ids (two linked projects would mix).
 */
export function unpackProject(packed: string): string {
  if (packed[0] !== VERSION) throw new Error("A link from a newer version of the app");
  const doc = JSON.parse(new TextDecoder().decode(inflateSync(fromBase64Url(packed.slice(1)), { dictionary: DICT_A }))) as Json;
  const ids = new Map<string, string>();
  const stamp = Date.now().toString(36);
  eachId(doc, (id) => {
    if (id.startsWith("~") && !ids.has(id)) ids.set(id, `l${stamp}-${ids.size.toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  });
  return JSON.stringify(shrink(doc, ids));
}

/** The link that opens this project (null if it can't be packed). */
export function projectLink(json: string): string | null {
  try {
    return `${SITE}#${KEY}=${packProject(json)}`;
  } catch {
    return null;
  }
}

/** The packed project in this address's # part, if there is one. */
export function linkedProject(hash = location.hash): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get(KEY);
}

/** The address without the packed project (a reload doesn't open it again). */
export function clearLinkedProject(): void {
  history.replaceState(null, "", location.pathname + location.search);
}
