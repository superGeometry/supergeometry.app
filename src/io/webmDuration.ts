// A WebM file as a browser records it has no length written in it: it is written as it is recorded, and the
// length is only known at the end. Players then show no duration and can't jump about in it. This writes the
// length in afterwards (pure logic: bytes in, bytes out).
//
// WebM is a tree of elements: an id, a size, then the content. The length belongs in Segment › Info, as a Duration
// element. Nothing after Info may move (other elements are found by their place in the file), so where it can the
// Duration takes the place of the WritingApp element - the recorder's own name, which no player needs - with the
// rest of that space left as padding. Only when there is no such element is it put in at the end of Info, and then
// only in a file that has nothing in it that goes by place.

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_SEEKHEAD = 0x114d9b74;
const ID_CUES = 0x1c53bb6b;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_WRITING_APP = 0x5741;
const ID_VOID = 0xec;

interface El {
  id: number;
  /** Where the id starts, where the content starts, how long the content is (-1: not said). */
  at: number;
  data: number;
  size: number;
  sizeAt: number;
  sizeLen: number;
}

/** How many bytes a number of this first byte takes (ids and sizes both: one more for each leading zero bit). */
const lengthOf = (first: number) => (first === 0 ? 9 : Math.clz32(first) - 23);

function read(b: Uint8Array, at: number, end: number): El | null {
  if (at >= end) return null;
  const idLen = lengthOf(b[at]);
  if (idLen > 4 || at + idLen >= end) return null;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[at + i];
  const sizeAt = at + idLen;
  const sizeLen = lengthOf(b[sizeAt]);
  if (sizeLen > 8 || sizeAt + sizeLen > end) return null;
  let size = b[sizeAt] & (0xff >> sizeLen);
  let ones = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    size = size * 256 + b[sizeAt + i];
    ones &&= b[sizeAt + i] === 0xff;
  }
  return { id, at, data: sizeAt + sizeLen, size: ones ? -1 : size, sizeAt, sizeLen };
}

function children(b: Uint8Array, from: number, end: number, stopAt?: number): El[] {
  const out: El[] = [];
  let at = from;
  for (;;) {
    const e = read(b, at, end);
    if (!e) break;
    out.push(e);
    if (e.id === stopAt || e.size < 0) break;
    at = e.data + e.size;
  }
  return out;
}

/** A size of `value` written in `len` bytes. */
function sizeBytes(value: number, len: number): number[] {
  const out = new Array<number>(len).fill(0);
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function float32(v: number): number[] {
  const d = new DataView(new ArrayBuffer(4));
  d.setFloat32(0, v);
  return [0, 1, 2, 3].map((i) => d.getUint8(i));
}

function float64(v: number): number[] {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, v);
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => d.getUint8(i));
}

/**
 * The file with its length (`ms`, milliseconds) written in. The same bytes back if it has one already, if it is not
 * a WebM file, or if there is no safe place to write it.
 */
export function withDuration(file: Uint8Array, ms: number): Uint8Array {
  try {
    if (!(ms > 0)) return file;
    const top = children(file, 0, file.length, ID_SEGMENT);
    const segment = top.find((e) => e.id === ID_SEGMENT);
    if (!segment) return file;
    const end = segment.size < 0 ? file.length : Math.min(file.length, segment.data + segment.size);
    // What stands before the first picture data: Info among it.
    const head = children(file, segment.data, end, ID_CLUSTER);
    const info = head.find((e) => e.id === ID_INFO);
    if (!info || info.size < 0) return file;
    const inside = children(file, info.data, info.data + info.size);
    // Lengths are counted in the file's own unit: a millionth of a second times this (most often 1000: milliseconds).
    const scaleEl = inside.find((e) => e.id === ID_TIMECODE_SCALE);
    let scale = 1_000_000;
    if (scaleEl && scaleEl.size > 0 && scaleEl.size <= 6) {
      scale = 0;
      for (let i = 0; i < scaleEl.size; i++) scale = scale * 256 + file[scaleEl.data + i];
    }
    const value = (ms * 1_000_000) / (scale || 1_000_000);
    const out = file.slice();

    // One there already: filled in if it is empty, left alone if it says something.
    const has = inside.find((e) => e.id === ID_DURATION);
    if (has) {
      const d = new DataView(out.buffer, has.data, has.size);
      const now = has.size === 8 ? d.getFloat64(0) : has.size === 4 ? d.getFloat32(0) : NaN;
      if (now > 0 || Number.isNaN(now)) return file;
      if (has.size === 8) d.setFloat64(0, value);
      else d.setFloat32(0, value);
      return out;
    }

    // In place of the recorder's name: nothing moves.
    const app = inside.find((e) => e.id === ID_WRITING_APP && e.size >= 0);
    if (app) {
      const room = app.data + app.size - app.at;
      if (room >= 7 && room !== 8) {
        // Duration (2 + 1 + 4 bytes), then padding for what is left (a Void element: at least 2 bytes).
        const left = room - 7;
        const bytes = [0x44, 0x89, 0x84, ...float32(value)];
        if (left >= 2) {
          const padLen = left - 2 <= 126 ? 1 : 2;
          const pad = left - 1 - padLen;
          if (pad < 0) return file;
          bytes.push(ID_VOID, ...sizeBytes(pad, padLen), ...new Array<number>(pad).fill(0));
        }
        out.set(bytes, app.at);
        return out;
      }
      if (room === 8) {
        // (One byte too many for the plain way: the size is written in two bytes.)
        out.set([0x44, 0x89, 0x40, 0x04, ...float32(value)], app.at);
        return out;
      }
    }

    // No such element: put in at the end of Info - only where nothing in the file goes by place.
    if (segment.size >= 0 || head.some((e) => e.id === ID_SEEKHEAD || e.id === ID_CUES)) return file;
    const add = [0x44, 0x89, 0x88, ...float64(value)];
    const newSize = info.size + add.length;
    const fits = newSize < Math.pow(2, 7 * info.sizeLen) - 1;
    const sizeLen = fits ? info.sizeLen : info.sizeLen + 1;
    const grown = new Uint8Array(file.length + add.length + (sizeLen - info.sizeLen));
    grown.set(file.subarray(0, info.sizeAt), 0);
    grown.set(sizeBytes(newSize, sizeLen), info.sizeAt);
    const body = info.sizeAt + sizeLen;
    grown.set(file.subarray(info.data, info.data + info.size), body);
    grown.set(add, body + info.size);
    grown.set(file.subarray(info.data + info.size), body + info.size + add.length);
    return grown;
  } catch {
    return file;
  }
}

/** The length written in a WebM file, in milliseconds (null: none, or not a WebM file). For tests. */
export function durationOf(file: Uint8Array): number | null {
  try {
    const segment = children(file, 0, file.length, ID_SEGMENT).find((e) => e.id === ID_SEGMENT);
    if (!segment) return null;
    const end = segment.size < 0 ? file.length : Math.min(file.length, segment.data + segment.size);
    const info = children(file, segment.data, end, ID_CLUSTER).find((e) => e.id === ID_INFO);
    if (!info || info.size < 0) return null;
    const inside = children(file, info.data, info.data + info.size);
    const d = inside.find((e) => e.id === ID_DURATION);
    if (!d) return null;
    const v = new DataView(file.buffer, file.byteOffset + d.data, d.size);
    const value = d.size === 8 ? v.getFloat64(0) : d.size === 4 ? v.getFloat32(0) : NaN;
    const s = inside.find((e) => e.id === ID_TIMECODE_SCALE);
    let scale = 1_000_000;
    if (s && s.size > 0 && s.size <= 6) {
      scale = 0;
      for (let i = 0; i < s.size; i++) scale = scale * 256 + file[s.data + i];
    }
    return value > 0 ? (value * scale) / 1_000_000 : null;
  } catch {
    return null;
  }
}
