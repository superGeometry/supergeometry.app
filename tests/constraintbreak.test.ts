// Break-it test for sketch constraints: random sketches, random constraints,
// extreme values and long drags, checked after every step.
// Run: npx tsx tests/constraintbreak.test.ts [scenarios] [steps] [seed]
import { createRequire } from "node:module";
import type { PointRef, SketchConstraint, SketchEntity, Vec2 } from "../src/doc/types";
import { addStrict, applicable, constraintError, pointOf, pointsOf, followDrag, refsOf, setValueStrict, sizeOf, solve } from "../src/sketch/constraints";
import { arcFrom3 } from "../src/sketch/curves";
import { filletConstraints, filletCorner } from "../src/sketch/edit";

const require = createRequire(import.meta.url);
const SCEN = Number(process.argv[2] ?? 18);
const STEPS = Number(process.argv[3] ?? 20);
let seed = Number(process.argv[4] ?? 1);
const VERBOSE = !!process.env.CBREAK_WHY;

const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
let nid = 0;
const uid = () => `x${++nid}`;

const L = (a: Vec2, b: Vec2): SketchEntity => ({ id: uid(), kind: "line", a, b });
const co = (e1: string, p1: string, e2: string, p2: string): SketchConstraint => ({ id: uid(), type: "coincident", pts: [{ e: e1, p: p1 }, { e: e2, p: p2 }] });

/** A closed chain of lines through these points, joined end to end. */
function loop(pts: Vec2[], hv = true): { es: SketchEntity[]; cs: SketchConstraint[] } {
  const es = pts.map((p, i) => L(p, pts[(i + 1) % pts.length]));
  const cs: SketchConstraint[] = es.map((e, i) => co(e.id, "b", es[(i + 1) % es.length].id, "a"));
  if (hv)
    for (const e of es) {
      const l = e as Extract<SketchEntity, { kind: "line" }>;
      if (Math.abs(l.a[1] - l.b[1]) < 1e-9) cs.push({ id: uid(), type: "horizontal", curves: [e.id] });
      else if (Math.abs(l.a[0] - l.b[0]) < 1e-9) cs.push({ id: uid(), type: "vertical", curves: [e.id] });
    }
  return { es, cs };
}

function base(kind: number): { es: SketchEntity[]; cs: SketchConstraint[]; name: string } {
  const s = 5 + rnd() * 40;
  switch (kind) {
    case 0: return { ...loop([[0, 0], [s, 0], [s, s * 0.6], [0, s * 0.6]]), name: "rectangle" };
    case 1: return { ...loop([[0, 0], [s, 0], [s * 0.3, s * 0.8]], false), name: "triangle" };
    case 2: return { ...loop([[0, 0], [s, 0], [s, s * 0.3], [s * 0.4, s * 0.3], [s * 0.4, s], [0, s]]), name: "L shape" };
    case 3: {
      const r = loop([[0, 0], [s, 0], [s, s * 0.6], [0, s * 0.6]]);
      let es = r.es;
      let cs = r.cs;
      for (const at of [[s, 0], [s, s * 0.6]] as Vec2[]) {
        const before = new Set(es.map((e) => e.id));
        const next = filletCorner(es, at, s * 0.15, 1e-6);
        if (!next) continue;
        // Constraints at the removed corner move to the arc.
        const ids = new Set(next.map((e) => e.id));
        cs = filletConstraints(next, cs.filter((c) => refsOf(c).every((id) => ids.has(id)) && !(c.type === "coincident" && c.pts?.every((p) => { const e = es.find((x) => x.id === p.e); const q = e && pointOf(e, p.p); return q && Math.hypot(q[0] - at[0], q[1] - at[1]) < 1e-6; }))), before);
        es = next;
      }
      return { es, cs, name: "filleted rectangle" };
    }
    case 4: {
      const c: SketchEntity = { id: uid(), kind: "circle", center: [0, 0], radius: s / 3 };
      const t = L([-s, s / 3 + 1], [s, s / 3 + 2]);
      return { es: [c, t], cs: [{ id: uid(), type: "tangent", curves: [t.id, c.id] }], name: "circle + tangent line" };
    }
    case 5: {
      const a: SketchEntity = { id: uid(), kind: "circle", center: [0, 0], radius: s / 2 };
      const b: SketchEntity = { id: uid(), kind: "circle", center: [1, 1], radius: s / 4 };
      return { es: [a, b], cs: [{ id: uid(), type: "concentric", curves: [a.id, b.id] }], name: "concentric circles" };
    }
    case 6: {
      // Slot: two lines and two half circles.
      const r = s / 4;
      const top = L([0, r], [s, r]);
      const bot = L([s, -r], [0, -r]);
      const right: SketchEntity = { id: uid(), kind: "arc", a: [s, r], m: [s + r, 0], b: [s, -r] };
      const left: SketchEntity = { id: uid(), kind: "arc", a: [0, -r], m: [-r, 0], b: [0, r] };
      const cs = [co(top.id, "b", right.id, "a"), co(right.id, "b", bot.id, "a"), co(bot.id, "b", left.id, "a"), co(left.id, "b", top.id, "a"),
        { id: uid(), type: "tangent" as const, curves: [top.id, right.id] }, { id: uid(), type: "tangent" as const, curves: [bot.id, right.id] },
        { id: uid(), type: "tangent" as const, curves: [bot.id, left.id] }, { id: uid(), type: "tangent" as const, curves: [top.id, left.id] },
        { id: uid(), type: "horizontal" as const, curves: [top.id] }];
      return { es: [top, right, bot, left], cs, name: "slot" };
    }
    case 7: {
      const es: SketchEntity[] = [
        { id: uid(), kind: "rect", center: [0, 0], w: s, h: s / 2, rotation: 0 },
        { id: uid(), kind: "polygon", center: [s, s], radius: s / 3, sides: 6, angle: 0 },
        { id: uid(), kind: "ellipse", center: [-s, s], rx: s / 2, ry: s / 4, rotation: 0 },
      ];
      return { es, cs: [], name: "rect + polygon + ellipse" };
    }
    default: {
      // Open zig-zag with an arc.
      const a = L([0, 0], [s, 0]);
      const arc: SketchEntity = { id: uid(), kind: "arc", a: [s, 0], m: [s * 1.3, s * 0.3], b: [s, s * 0.6] };
      const b = L([s, s * 0.6], [0, s * 0.6]);
      return { es: [a, arc, b], cs: [co(a.id, "b", arc.id, "a"), co(arc.id, "b", b.id, "a"), { id: uid(), type: "tangent", curves: [a.id, arc.id] }], name: "line-arc-line" };
    }
  }
}

const KINDS = 9;
const TYPES = ["coincident", "horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "concentric", "midpoint", "symmetric", "distance", "fix"] as const;

function scaleOf(es: SketchEntity[]): number {
  let s = 1;
  for (const e of es) {
    for (const p of pointsOf(e)) s = Math.max(s, Math.abs(p.at[0]), Math.abs(p.at[1]));
    s = Math.max(s, sizeAny(e));
  }
  return s;
}

function sizeAny(e: SketchEntity): number {
  if (e.kind === "line") return Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
  if (e.kind === "circle" || e.kind === "polygon") return e.radius;
  if (e.kind === "arc") {
    const c = arcFrom3(e.a, e.m, e.b);
    return c ? c.r * Math.abs(c.sweep) : 0;
  }
  if (e.kind === "rect") return Math.min(e.w, e.h);
  if (e.kind === "ellipse") return Math.min(e.rx, e.ry);
  return 1;
}

/** Largest point move between two versions of the same sketch. */
function moved(a: SketchEntity[], b: SketchEntity[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const pa = pointsOf(a[i]);
    const pb = pointsOf(b[i]);
    for (let k = 0; k < Math.min(pa.length, pb.length); k++) d = Math.max(d, Math.hypot(pa[k].at[0] - pb[k].at[0], pa[k].at[1] - pb[k].at[1]));
    if (a[i].kind === "arc" && b[i].kind === "arc") {
      const sa = arcFrom3((a[i] as any).a, (a[i] as any).m, (a[i] as any).b);
      const sb = arcFrom3((b[i] as any).a, (b[i] as any).m, (b[i] as any).b);
      if (sa && sb && Math.sign(sa.sweep) !== Math.sign(sb.sweep)) d = Infinity;
      else if (sa && sb) d = Math.max(d, Math.abs(sa.sweep - sb.sweep) * Math.max(sa.r, sb.r));
    }
  }
  return d;
}

/** Orientation of each corner where two curves join, and of each arc: flips show up here. */
function turns(es: SketchEntity[], cs: SketchConstraint[]): number[] {
  const out: number[] = [];
  const byId = new Map(es.map((e) => [e.id, e]));
  for (const c of cs) {
    if (c.type !== "coincident" || c.pts?.length !== 2) continue;
    const [p, q] = c.pts;
    const e1 = byId.get(p.e);
    const e2 = byId.get(q.e);
    if (e1?.kind !== "line" || e2?.kind !== "line") continue;
    const far = (e: Extract<SketchEntity, { kind: "line" }>, end: string) => (end === "a" ? e.b : e.a);
    const o = pointOf(e1, p.p)!;
    const u = far(e1, p.p);
    const v = far(e2, q.p);
    const cr = (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
    const lu = Math.hypot(u[0] - o[0], u[1] - o[1]);
    const lv = Math.hypot(v[0] - o[0], v[1] - o[1]);
    // Legs next to nothing can tip either way.
    const big = Math.max(...es.map((e) => (e.kind === "line" ? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) : 0)));
    out.push(lu > big * 1e-4 && lv > big * 1e-4 && Math.abs(cr) > lu * lv * 0.02 ? Math.sign(cr) : 0);
  }
  for (const e of es) if (e.kind === "arc") out.push(Math.sign(arcFrom3(e.a, e.m, e.b)?.sweep ?? 0));
  return out;
}

interface State { es: SketchEntity[]; cs: SketchConstraint[] }

const fails: string[] = [];
const why = new Map<string, number>();
let accepted = 0;
let refused = 0;
let slowest = 0;
let dropped = 0;
let dumped = false;
let lastCall: unknown = null;
let failDumped = false;
const slowFrames: string[] = [];
const editTimes: number[] = [];
const times: number[] = [];
let slowWhat = "";

function check(label: string, before: State, after: State, opts: { fixed?: string; smooth?: State; sized?: string } = {}): string | null {
  const sc = scaleOf(after.es);
  for (const e of after.es) for (const p of pointsOf(e)) if (!Number.isFinite(p.at[0]) || !Number.isFinite(p.at[1])) return "NaN/Infinity in the geometry";
  const err = constraintError(after.es, after.cs);
  if (err > 1e-5 * Math.max(1, sc)) return `constraints not met (error ${err.toExponential(2)})`;
  for (let i = 0; i < after.es.length; i++) {
    const s0 = sizeAny(before.es[i] ?? after.es[i]);
    const s1 = sizeAny(after.es[i]);
    if (after.es[i].id !== opts.sized && s0 > sc * 1e-7 && s1 < sc * 1e-7) return `${after.es[i].kind} collapsed to nothing`;
  }
  if (opts.fixed) {
    const i = before.es.findIndex((e) => e.id === opts.fixed);
    if (i >= 0 && moved([before.es[i]], [after.es[i]]) > 1e-6 * sc) return "the first-picked curve moved";
  }
  // Same change made gradually lands in the same place: no jump to a flipped solution.
  if (opts.smooth) {
    const t0 = turns(before.es, before.cs);
    const t1 = turns(after.es, after.cs);
    const t2 = turns(opts.smooth.es, opts.smooth.cs);
    const flipped = t1.some((v, i) => v !== 0 && t2[i] !== 0 && v !== t2[i] && t0[i] === t2[i]);
    if (flipped) return "flipped a corner/arc inside out (a gradual change keeps it)";
  }
  return null;
}

function timed<T>(what: string, f: () => T): T {
  const t = performance.now();
  const r = f();
  const dt = performance.now() - t;
  if (what.startsWith("drag")) times.push(dt);
  else editTimes.push(dt);
  if (dt > slowest) {
    slowest = dt;
    slowWhat = what;
  }
  return r;
}

function randomSelection(st: State): { pts: PointRef[]; curves: SketchEntity[] } {
  const nP = pick([0, 0, 1, 1, 2]);
  const nC = pick([0, 1, 1, 2, 2]);
  const pts: PointRef[] = [];
  for (let i = 0; i < nP; i++) {
    const e = pick(st.es);
    const p = pick(pointsOf(e));
    pts.push({ e: e.id, p: p.p });
  }
  const curves: SketchEntity[] = [];
  for (let i = 0; i < nC; i++) {
    const e = pick(st.es);
    if (!curves.includes(e)) curves.push(e);
  }
  return { pts, curves };
}

function build(type: (typeof TYPES)[number], pts: PointRef[], curves: SketchEntity[], es: SketchEntity[]): SketchConstraint[] {
  const ids = curves.map((e) => e.id);
  switch (type) {
    case "fix":
      return pts.map((p) => ({ id: uid(), type: "fix", pts: [p], at: pointOf(es.find((e) => e.id === p.e)!, p.p)! }));
    case "distance": {
      const v = 1 + rnd() * 30;
      return [{ id: uid(), type: "distance", pts, ...(ids.length ? { curves: ids } : {}), value: v }];
    }
    default:
      return [{ id: uid(), type, ...(pts.length ? { pts } : {}), ...(ids.length ? { curves: ids } : {}) }];
  }
}

function step(st: State, n: number): { label: string; next: State | null; opts: { fixed?: string; smooth?: State; sized?: string } } {
  const r = rnd();
  if (r < 0.3) {
    // Add a constraint like the Constraints menu does.
    const type = pick([...TYPES]);
    const { pts, curves } = randomSelection(st);
    if (!applicable(type, pts, curves)) return { label: "", next: null, opts: {} };
    if (pts.length === 2 && pts[0].e === pts[1].e && pts[0].p === pts[1].p) return { label: "", next: null, opts: {} };
    const cs = build(type, pts, curves, st.es);
    const first = curves[0]?.id ?? pts[0]?.e;
    const opts = first && type !== "fix" ? { fixed: new Set([first]) } : {};
    const already = constraintError(st.es, cs) < 1e-9 * scaleOf(st.es);
    lastCall = { es: st.es, cs: st.cs, added: cs, fixed: first && type !== "fix" ? first : null };
    const res = timed(`add ${type}`, () => addStrict(st.es, st.cs, cs, opts));
    const label = `add ${type} (${pts.map((p) => p.e + "." + p.p).join(",")} ${curves.map((e) => e.kind + ":" + e.id).join(",")})`;
    if (!res.ok) {
      if (already && constraintError(st.es, st.cs) < 1e-9 * scaleOf(st.es) && !wouldCollapse(st, cs)) return { label: label + " - refused although already true", next: { es: [], cs: [] }, opts: {} };
      return { label, next: null, opts: {} };
    }
    return { label, next: { es: res.result.entities, cs: res.constraints }, opts: { fixed: type === "fix" ? undefined : first } };
  }
  if (r < 0.55) {
    // Size of a curve, typed (strict, like the size fields).
    const e = pick(st.es);
    const prop = e.kind === "line" ? pick(["length", "angle"]) : e.kind === "circle" ? pick(["radius", "diameter"]) : e.kind === "arc" ? "radius" : e.kind === "rect" ? pick(["w", "h"]) : e.kind === "ellipse" ? pick(["rx", "ry"]) : e.kind === "polygon" ? "radius" : null;
    if (!prop) return { label: "", next: null, opts: {} };
    const cur = sizeOf(e, prop);
    if (cur === null) return { label: "", next: null, opts: {} };
    const v = prop === "angle" ? pick([0, 90, -90, 180, 45, cur + 30, cur - 170, 359]) : Math.max(1e-4, pick([cur * 2, cur / 2, cur * 10, cur / 10, cur * 1.01, 1e-3, 1e4, cur + 1, 0.0001]));
    const old = st.cs.filter((c) => c.type === "dim" && c.curves?.[0] === e.id && c.curves.length === 1 && c.prop === prop);
    const baseCs = st.cs.filter((c) => !old.includes(c));
    const add: SketchConstraint = { id: old[0]?.id ?? uid(), type: "dim", curves: [e.id], prop, value: v };
    lastCall = { es: st.es, cs: baseCs, added: [add] };
    const res = timed(`size ${prop}`, () => addStrict(st.es, baseCs, [add]));
    const label = `${e.kind} ${prop} ${cur.toFixed(3)} → ${v}`;
    if (!res.ok) return { label, next: null, opts: {} };
    const next = { es: res.result.entities, cs: res.constraints };
    return { label, next, opts: { smooth: gradual(st, baseCs, add, cur, v), sized: e.id } };
  }
  if (r < 0.7) {
    // Change an existing dimension's value from its panel (resolved on commit).
    const dims = st.cs.filter((c) => (c.type === "dim" || c.type === "distance") && c.value !== undefined);
    if (!dims.length) return { label: "", next: null, opts: {} };
    const c = pick(dims);
    const v = c.prop === "angle" ? pick([0, 90, 180, 30, (c.value ?? 0) + 90]) : Math.max(1e-4, pick([(c.value ?? 1) * 3, (c.value ?? 1) / 3, 0.0001, 5e4, (c.value ?? 1) + 0.5]));
    const label = `${c.type} ${c.prop ?? ""} value ${c.value} → ${v}`;
    lastCall = { es: st.es, cs: st.cs.filter((x) => x !== c), added: [{ ...c, value: v }] };
    const r2 = timed("dim value", () => setValueStrict(st.es, st.cs, c.id, v));
    if (!r2) return { label, next: null, opts: {} };
    const cs = r2.constraints;
    const baseCs = st.cs.filter((x) => x !== c);
    return { label, next: { es: r2.result.entities, cs }, opts: { smooth: gradual(st, baseCs, c, c.value ?? 0, v) } };
  }
  if (r < 0.92) {
    // Drag a point the way the sketch does: every move solved from where the drag began.
    const e = pick(st.es);
    const p = pick(pointsOf(e));
    const sc = scaleOf(st.es);
    const to: Vec2 = [p.at[0] + (rnd() - 0.5) * sc * pick([0.2, 1, 3]), p.at[1] + (rnd() - 0.5) * sc * pick([0.2, 1, 3])];
    let cur = st.es;
    let prevTo: Vec2[] | null = [p.at];
    const N = 12;
    for (let k = 1; k <= N; k++) {
      const t = k / N;
      const at: Vec2 = [p.at[0] + (to[0] - p.at[0]) * t, p.at[1] + (to[1] - p.at[1]) * t];
      const drag = [{ ref: { e: e.id, p: p.p }, to: at }];
      const fr = timed(`drag (${st.es.length} curves, ${st.cs.length} constraints)`, () => followDrag(cur, st.cs, drag, prevTo));
      const took = times[times.length - 1];
      if (took > 30) slowFrames.push(`${took.toFixed(0)}ms ok=${fr.ok}`);
      if (fr.ok) {
        cur = fr.entities;
        prevTo = fr.to;
      } else {
        dropped++;
        if (process.env.CBREAK_DUMP && !dumped) {
          dumped = true;
          require("node:fs").writeFileSync(process.env.CBREAK_DUMP, JSON.stringify({ es: cur, cs: st.cs, drag, prevTo }));
        }
      }
    }
    // Frame by frame is the gradual way: compare with the shape before the drag.
    const path = { es: cur, cs: st.cs };
    return { label: `drag ${e.kind}:${e.id}.${p.p} by ${Math.hypot(to[0] - p.at[0], to[1] - p.at[1]).toFixed(1)}`, next: { es: cur, cs: st.cs }, opts: { smooth: path } };
  }
  // Delete a constraint.
  if (!st.cs.length) return { label: "", next: null, opts: {} };
  const c = pick(st.cs);
  return { label: `delete ${c.type}`, next: { es: st.es, cs: st.cs.filter((x) => x !== c) }, opts: {} };
  void n;
}

function wouldCollapse(st: State, cs: SketchConstraint[]): boolean {
  void st;
  void cs;
  return false;
}

/** The same value change made in small steps (what a careful user would get). */
function gradual(st: State, baseCs: SketchConstraint[], c: SketchConstraint, from: number, to: number): State | undefined {
  let es = st.es;
  const N = 16;
  for (let k = 1; k <= N; k++) {
    // Angles the short way round (as the solver reads them).
    const span = c.prop === "angle" ? ((((to - from) % 360) + 540) % 360) - 180 : to - from;
    const v = from + (span * k) / N;
    const r = solve(es, [...baseCs, { ...c, value: v }]);
    if (!r.ok) return undefined;
    es = r.entities;
  }
  return { es, cs: [...baseCs, { ...c, value: to }] };
}


for (let s = 0; s < SCEN; s++) {
  const b = base(s % KINDS);
  // Start from a solved sketch.
  const r0 = solve(b.es, b.cs);
  if (!r0.ok) {
    fails.push(`scenario ${s} (${b.name}): base sketch doesn't solve (error ${r0.error})`);
    continue;
  }
  let st: State = { es: r0.entities, cs: b.cs };
  const trail: string[] = [];
  for (let k = 0; k < STEPS; k++) {
    const { label, next, opts } = step(st, k);
    if (!label) continue;
    if (!next) {
      refused++;
      continue;
    }
    trail.push(label);
    const bad = next.es.length === 0 ? label.split(" - ")[1] : check(label, st, next, opts);
    if (bad) {
      const kind = label.startsWith("drag") ? "drag " + label.split(" ")[1].split(":")[0] : label.split(" ")[0] + " " + (label.split(" ")[1] ?? "");
      why.set(`${kind}: ${bad.replace(/[\d.e+-]+/g, "#")}`, (why.get(`${kind}: ${bad.replace(/[\d.e+-]+/g, "#")}`) ?? 0) + 1);
      if (process.env.CBREAK_FAIL && !label.startsWith("drag") && (process.env.CBREAK_AT ? label.startsWith(process.env.CBREAK_AT) : true) && !failDumped && (failDumped = true)) require("node:fs").writeFileSync(process.env.CBREAK_FAIL, JSON.stringify(lastCall));
      fails.push(`scenario ${s} (${b.name}) step ${k}: ${label}: ${bad}${VERBOSE ? "\n    " + trail.join("\n    ") : ""}`);
      break;
    }
    accepted++;
    st = next;
    // Shrunk below a thousandth of a unit: past what anyone draws (and the solver's precision).
    if (Math.max(...st.es.map(sizeAny)) < 1e-3) break;
  }
}

for (const f of fails.slice(0, 30)) console.log("FAIL", f);
times.sort((a, b) => a - b);
if (process.env.CBREAK_SLOW) console.log(slowFrames.join(" "));
console.log(`drag frames: ${times.length}, ${dropped} couldn't follow; median ${times[times.length >> 1]?.toFixed(2)} ms, 99% ${times[Math.floor(times.length * 0.99)]?.toFixed(1)} ms`);
editTimes.sort((a, b) => a - b);
console.log(`edits (constraints, sizes, values): median ${editTimes[editTimes.length >> 1]?.toFixed(2)} ms, 90% ${editTimes[Math.floor(editTimes.length * 0.9)]?.toFixed(1)} ms, 99% ${editTimes[Math.floor(editTimes.length * 0.99)]?.toFixed(1)} ms`);
console.log(`${accepted} steps ok, ${refused} refused, ${fails.length} broke the sketch; slowest solve ${slowest.toFixed(1)} ms (${slowWhat})`);
for (const [k, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${k}`);
process.exit(fails.length ? 1 : 0);
