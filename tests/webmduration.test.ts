// Run: npx tsx tests/webmduration.test.ts
// A WebM file as a browser records it has no length in it: players show no duration and can't seek. The length is
// written in afterwards (io/webmDuration.ts), without moving anything that comes after it in the file.
import { durationOf, withDuration } from "../src/io/webmDuration";
import { check, done } from "./kit";

const el = (id: number[], body: number[]) => [...id, 0x80 | body.length, ...body];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const EBML = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], text("webm")));
const SCALE = el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]);
const MUX = (s: string) => el([0x4d, 0x80], text(s));
const APP = (s: string) => el([0x57, 0x41], text(s));
const INFO = (body: number[]) => el([0x15, 0x49, 0xa9, 0x66], body);
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xe7, 0x81, 0x00, 1, 2, 3, 4, 5, 6, 7, 8];
// A segment of unknown size (as recorders write it), holding `parts`.
const file = (...parts: number[][]) => new Uint8Array([...EBML, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...parts.flat(), ...CLUSTER]);
const tail = (b: Uint8Array) => [...b.slice(-CLUSTER.length)].join();

for (const app of ["Chrome", "Chro", "Chrom", "QTwritingAppLibWebM-0.0.1", "x".repeat(140)]) {
  const f = file(INFO([...SCALE, ...MUX("Chrome"), ...(app.length > 126 ? [0x57, 0x41, 0x40, app.length, ...text(app)] : APP(app))]));
  const out = withDuration(f, 16900);
  const d = durationOf(out);
  check(`a recorder's name of ${app.length} letters: the length takes its place, and the file is not a byte longer`, out.length === f.length && d !== null && Math.abs(d - 16900) < 1 && tail(out) === tail(f) && durationOf(f) === null, `${d} ms, ${out.length} / ${f.length} bytes`);
}
{
  // No name to take the place of: put in at the end of Info, the rest moved down.
  const f = file(INFO([...SCALE, ...MUX("Chrome")]));
  const out = withDuration(f, 154800);
  check("no recorder's name: the length is added to Info, and the picture data follows unchanged", out.length === f.length + 11 && Math.abs((durationOf(out) ?? 0) - 154800) < 1e-6 && tail(out) === tail(f), `${durationOf(out)} ms, ${out.length - f.length} bytes more`);
}
{
  // The same, but something in the file goes by place (a seek head): left alone.
  const seek = el([0x11, 0x4d, 0x9b, 0x74], el([0x4d, 0xbb], [1, 2, 3]));
  const f = file(seek, INFO([...SCALE, ...MUX("Chrome")]));
  check("no name, and a file that finds its parts by their place: left as it is", withDuration(f, 5000) === f);
}
{
  // Counted in another unit than milliseconds.
  const f = file(INFO([...el([0x2a, 0xd7, 0xb1], [0x07, 0xa1, 0x20]), ...APP("Chrome")]));
  const out = withDuration(f, 9000);
  check("a file that counts in half milliseconds: the length still reads 9 seconds", Math.abs((durationOf(out) ?? 0) - 9000) < 1, `${durationOf(out)} ms`);
}
{
  const f = file(INFO([...SCALE, ...APP("Chrome")]));
  const once = withDuration(f, 4000);
  check("a file that has its length already is left alone", withDuration(once, 9999) === once && Math.abs((durationOf(once) ?? 0) - 4000) < 1);
  check("not a WebM file (an MP4's first bytes), or no length to write: the same bytes back", withDuration(new Uint8Array([0, 0, 0, 28, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]), 5000).length === 11 && withDuration(f, 0) === f);
}
done();
