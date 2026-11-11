// Check a project from the command line: rebuild it step by step and say what
// each step did (its error, the bodies it made, changed or took away) and how
// sound each body is at the end.
//
//   npx tsx scripts/check.ts project.super            step by step, then the bodies
//   npx tsx scripts/check.ts project.super --end      only the bodies at the end
//   npx tsx scripts/check.ts project.super --json     the same, as JSON
//   npx tsx scripts/check.ts project.super --png a.png   and a picture of it (see render.ts)
//
// Exit code 1 when a step fails or a body isn't sound.
import { readFileSync } from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { parseProject } from "../src/doc/store";
import { debugBodies, healthReport, regenerate } from "../src/kernel/engine";
import type { BodyHealth } from "../src/kernel/protocol";
import type { Feature } from "../src/doc/types";
import { renderPNG, type RenderOptions } from "./render";

export interface StepReport {
  index: number;
  id: string;
  name: string;
  type: string;
  off?: boolean;
  error?: string;
  note?: string;
  /** Bodies it made, took away, or changed (volume before → after, mm³). */
  made: string[];
  gone: string[];
  changed: { body: string; from: number; to: number }[];
  /** Bodies that were sound before it and aren't after. */
  broke: string[];
  ms: number;
}

export interface CheckReport {
  name: string;
  steps?: StepReport[];
  bodies: BodyHealth[];
  errors: { step: string; message: string }[];
  ok: boolean;
}

/** Every body's health after the steps (name from the rebuild). */
function bodiesNow(names: Map<string, string>): BodyHealth[] {
  return [...debugBodies()].map(([id, s]) => healthReport(id, names.get(id) ?? id, s));
}

export async function checkProject(features: Feature[], name: string, stepwise = true): Promise<CheckReport> {
  const steps: StepReport[] = [];
  if (stepwise) {
    let before = new Map<string, BodyHealth>();
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const t0 = performance.now();
      const r = await regenerate(features.slice(0, i + 1));
      const names = new Map(r.bodies.map((b) => [b.id, b.name]));
      const now = new Map(bodiesNow(names).map((h) => [h.id, h]));
      const step: StepReport = { index: i + 1, id: f.id, name: f.name, type: f.type, made: [], gone: [], changed: [], broke: [], ms: Math.round(performance.now() - t0) };
      if (f.suppressed) step.off = true;
      const err = r.errors.find((e) => e.featureId === f.id);
      if (err) step.error = err.message;
      const note = r.notes?.find((e) => e.featureId === f.id);
      if (note) step.note = note.message;
      for (const [id, h] of now) {
        const was = before.get(id);
        if (!was) step.made.push(h.name);
        else if (Math.abs(was.volume - h.volume) > 1e-6 * Math.max(1, was.volume) || was.faces !== h.faces) step.changed.push({ body: h.name, from: was.volume, to: h.volume });
        if (was?.healthy && !h.healthy) step.broke.push(h.name);
        if (!was && !h.healthy) step.broke.push(h.name);
      }
      for (const [id, h] of before) if (!now.has(id)) step.gone.push(h.name);
      steps.push(step);
      before = now;
    }
  }
  const r = await regenerate(features);
  const names = new Map(r.bodies.map((b) => [b.id, b.name]));
  const bodies = bodiesNow(names);
  const byId = new Map(features.map((f) => [f.id, f]));
  const errors = r.errors.map((e) => ({ step: byId.get(e.featureId)?.name ?? e.featureId, message: e.message }));
  return { name, ...(stepwise ? { steps } : {}), bodies, errors, ok: !errors.length && bodies.every((b) => b.healthy) };
}

const n = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));

/** The report as lines to read. */
export function reportText(rep: CheckReport): string {
  const out: string[] = [`Project: ${rep.name}`];
  if (rep.steps) {
    out.push("", "Steps:");
    for (const s of rep.steps) {
      const what: string[] = [];
      if (s.off) what.push("switched off");
      if (s.made.length) what.push(`made ${s.made.join(", ")}`);
      for (const c of s.changed) what.push(`${c.body} ${c.to >= c.from ? "+" : ""}${n(c.to - c.from)} mm³`);
      if (s.gone.length) what.push(`took away ${s.gone.join(", ")}`);
      if (s.broke.length) what.push(`!! not sound after it: ${s.broke.join(", ")}`);
      if (s.note) what.push(`note: ${s.note}`);
      if (s.error) what.push(`ERROR: ${s.error}`);
      out.push(`${String(s.index).padStart(3)}. ${s.name} [${s.type}]${what.length ? " - " + what.join("; ") : ""}  (${s.ms} ms)`);
    }
  }
  out.push("", "Bodies:");
  if (!rep.bodies.length) out.push("  (none)");
  for (const b of rep.bodies) {
    const size = b.box[1].map((v, k) => n(v - b.box[0][k])).join(" x ");
    const bad: string[] = [];
    if (!b.valid) bad.push("invalid");
    if (b.solids !== 1) bad.push(`${b.solids} solids`);
    if (b.openEdges) bad.push(`${b.openEdges} open edges`);
    if (b.thin) bad.push(`${b.thin} hair-thin faces`);
    if (!(b.volume > 0)) bad.push("no volume");
    out.push(`  ${b.healthy ? "ok  " : "BAD "} ${b.name}: ${n(b.volume)} mm³, ${b.faces} faces, ${b.edges} edges, ${size} mm${bad.length ? " - " + bad.join(", ") : ""}`);
  }
  if (rep.errors.length) {
    out.push("", "Errors:");
    for (const e of rep.errors) out.push(`  ${e.step}: ${e.message}`);
  }
  out.push("", rep.ok ? "All sound." : "Not all sound.");
  return out.join("\n");
}

// ------------------------------------------------------------------ command line

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/check.ts")) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--") && !/\.png$/i.test(a));
  if (!file) {
    console.log("Usage: npx tsx scripts/check.ts <project.super> [--end] [--json] [--png out.png] [--view iso|front|top|right|...]");
    process.exit(2);
  }
  const doc = parseProject(readFileSync(file, "utf8"));
  setOC(await (opencascade as unknown as () => Promise<any>)());
  const rep = await checkProject(doc.features, doc.name, !args.includes("--end"));
  console.log(args.includes("--json") ? JSON.stringify(rep, null, 2) : reportText(rep));
  const png = args[args.indexOf("--png") + 1];
  if (args.includes("--png") && png) {
    const view = args.includes("--view") ? (args[args.indexOf("--view") + 1] as RenderOptions["view"]) : "iso";
    const hidden = new Set(doc.hidden ?? []);
    renderPNG([...debugBodies()].filter(([id]) => !hidden.has(id)).map(([id, shape]) => ({ shape, color: doc.colors?.[id] })), png, { view });
    console.log(`Picture: ${png}`);
  }
  process.exit(rep.ok ? 0 : 1);
}
