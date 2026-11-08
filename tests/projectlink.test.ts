// Run: npx tsx tests/projectlink.test.ts - a project packed into a link
// (short ids, compressed with a dictionary) opens as the same
// model: every fixture project is built from its file and from its link, and
// the bodies (how many, their volumes) and the errors must match. Also: the
// link is shorter than plain compression, short ids already in a file aren't
// taken by new ones, and opened, the ids are long and unique again.
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { debugBodies, regenerate } from "../src/kernel/engine";
import { resolveDoc } from "../src/doc/params";
import { setVariables } from "../src/units";
import { parseProject } from "../src/doc/store";
import { packProject, unpackProject } from "../src/io/projectLink";

setOC(await (opencascade as unknown as () => Promise<any>)());
let failed = 0;
const check = (name: string, ok: boolean, info = "") => {
  if (!ok) failed++;
  console.log(ok ? "ok  " : "FAIL", name, info);
};

const build = async (text: string) => {
  const d = parseProject(text);
  setVariables(d.variables);
  resolveDoc(d);
  const r: any = await regenerate(d.features);
  const vols = r.bodies.map((b: any) => Math.abs(measureVolume(debugBodies().get(b.id)!)));
  return { n: r.bodies.length, vols, errors: r.errors.length, names: r.bodies.map((b: any) => b.name).join(",") };
};

const dir = new URL("./fixtures/", import.meta.url);
// Each fixture in a fresh process of its own: after a big one (the jet) the
// kernel has run out of memory and builds nothing more.
const only = process.argv[2];
if (!only) {
  // (Only whole project files: some fixtures are just a list of steps.)
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && readFileSync(new URL(f, dir), "utf8").startsWith('{"format"'))) {
    const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), f], { encoding: "utf8" });
    const lines = r.stdout.split("\n").filter((l) => /^(ok|FAIL| {4})/.test(l));
    console.log(lines.length ? lines.join("\n") : `FAIL ${f}: the test didn't run (${r.stderr.trim().split("\n").pop()})`);
    if (r.status || !lines.length || lines.some((l) => l.startsWith("FAIL"))) failed++;
  }
}
for (const f of only ? [only] : []) {
  const text = readFileSync(new URL(f, dir), "utf8");
  if (!text.startsWith('{"format"')) continue;
  const packed = packProject(text);
  const back = unpackProject(packed);
  const plain = Math.ceil((deflateRawSync(Buffer.from(text)).length * 4) / 3);
  // (The biggest, packed by a smaller compressor, may come out a little longer.)
  check(`${f}: about as short as plain compression or shorter`, packed.length <= plain * 1.03, `${text.length} chars → link ${packed.length} (plain ${plain})`);
  // The link's first, then the file: the kernel has room for the jet twice, not three times.
  const b = await build(back);
  const a = await build(text);
  // Compared only where the file itself builds the same twice: a big one can
  // leave the kernel out of memory (the jet: 6 bodies, then none). Listed if so.
  const again = await build(text);
  const same = (x: typeof a, y: typeof a) => x.n === y.n && x.names === y.names && x.errors === y.errors && x.vols.every((v: number, i: number) => Math.abs(v - y.vols[i]) <= 1e-6 * Math.max(1, v));
  if (!same(a, again)) {
    console.log("    ", `${f}: not compared (the file itself built ${a.n} bodies / ${a.errors} errors, then ${again.n} / ${again.errors})`);
    continue;
  }
  check(`${f}: same bodies`, a.n === b.n && a.names === b.names, `${a.n} / ${b.n}`);
  check(`${f}: same volumes`, a.vols.every((v: number, i: number) => Math.abs(v - b.vols[i]) <= 1e-6 * Math.max(1, v)), a.vols.map((v: number) => v.toFixed(2)).join(" "));
  check(`${f}: same errors`, a.errors === b.errors, `${a.errors} / ${b.errors}`);
}

// A short id ("0") stays as it is (it could be the same as a word in the file); the long ones come back long and unique.
if (!only) {
  const doc = { format: "super", version: 2, name: "ids", features: [{ id: "0", name: "a", type: "plane" }, { id: "long-id-one", name: "b", type: "plane", ref: "0" }, { id: "long-id-two", name: "c", type: "plane", ref: "long-id-one" }], variables: [], views: [], units: "mm", hidden: ["long-id-two"], pins: [], names: { "long-id-one:2": "x" } };
  const back = JSON.parse(unpackProject(packProject(JSON.stringify(doc))));
  const ids = back.features.map((x: any) => x.id);
  check("ids stay unique, long again", new Set(ids).size === 3 && ids[0] === "0" && ids.slice(1).every((i: string) => i.length > 8), ids.join(","));
  check("references follow", back.features[2].ref === ids[1] && back.hidden[0] === ids[2] && Object.keys(back.names)[0] === `${ids[1]}:2`, JSON.stringify(back.names));
}

console.log(failed ? `${failed} FAILED` : "all ok");
process.exit(failed ? 1 : 0);
