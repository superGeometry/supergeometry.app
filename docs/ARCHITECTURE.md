# Architecture

supergeometry.app is a static web app. There is no server: everything (geometry kernel
included) runs in the browser, so it can be hosted for free and works offline.

```
 ┌──────────────── main thread ────────────────┐        ┌──────── Web Worker ────────┐
 │  UI (toolbar, history, hints)               │        │  Kernel adapter            │
 │  Tools (sketch, extrude, fillet, …)         │  doc   │   replicad + OpenCascade   │
 │  Document store  ── features[] (JSON) ──────┼───────▶│   (WebAssembly)            │
 │    undo/redo, autosave                      │        │  Regenerate features[]     │
 │  Viewport (three.js) ◀── meshes + topology ─┼────────┤  → bodies → meshes         │
 │  Input (pointer events: pen/touch/mouse)    │        │  feature cache             │
 └─────────────────────────────────────────────┘        └────────────────────────────┘
```

## Key decisions

1. **The document is a list of features, not geometry.** `src/doc/types.ts`.
   A project file is small JSON (`{ features: [...] }`). Geometry is always
   *regenerated* from features, which is what makes history editable. Undo/redo
   is just snapshots of that JSON.

2. **The kernel runs in a Web Worker behind an interface.** `src/kernel/`.
   The main thread never blocks on geometry. Only `worker.ts` knows about
   replicad/OpenCascade; everything else talks to it through `protocol.ts`.
   Swapping the kernel later means rewriting one file.

3. **References to faces/edges are geometric, not index-based.**
   The "topological naming problem": after you edit an early feature, face #7
   may not be face #7 anymore. Features therefore store a *signature* of the
   face/edge they act on (center, normal, area / midpoint, direction, length),
   and the kernel resolves it to the best-matching face/edge in the rebuilt
   body (`resolveFace` / `resolveEdge` in `worker.ts`). This is simple and
   survives most edits; it can be upgraded to a smarter naming scheme later
   without changing the file format (the signature is just data).

4. **Incremental regeneration.** The worker caches the bodies produced after
   each feature, keyed by a hash of all features up to that point. Editing
   feature *k* rebuilds only from *k* onwards. Live previews (dragging an
   extrude arrow) only rebuild the last feature.

5. **One input model for every device.** `src/view/input.ts`
   - Pen or mouse-left: tool actions (tap = place/select, drag = handle).
   - Touch: tap = place/select; one-finger drag on empty space = orbit;
     two fingers = pan + pinch zoom. While a pen is touching the screen,
     touches are ignored (palm rejection).
   - Mouse: left-drag on empty = orbit, right/middle-drag = pan, wheel = zoom
     to cursor.

6. **Z-up, millimetres.** World units are mm, Z is up, sketches live on planes
   `{ origin, xDir, normal }`.

## Folder layout

```
src/
  main.ts, app.ts    bootstrap; app state (selection, tools, section, pins), menus
  settings.ts        per-device preferences (snapping, grid, display, camera)
  units.ts           units + expression evaluation (variables, unit suffixes)
  doc/
    types.ts         feature & document types (the file format)
    store.ts         undo/redo, IndexedDB autosave, file migration
  sketch/            pure 2D code, shared by UI and kernel
    curves.ts        entities → primitives (line/arc/ellipse/spline), evaluation
    regions.ts       planar arrangement → regions with holes (+ stable refs)
    edit.ts          trim, extend, offset, fillet, transforms, edge projection
    text.ts          text → outline curves (opentype.js + Roboto)
  kernel/
    protocol.ts      messages between main thread and worker
    engine.ts        feature replay on OpenCascade/replicad (testable in Node)
    sketchGeom.ts    regions → exact OpenCascade faces/wires
    worker.ts        Web Worker entry
    client.ts        promise-based client for the worker
  view/
    viewport.ts      three.js scene, display modes, section, picking
    camera.ts        orbit camera, ortho/perspective, plane-aligned views
    grid.ts          adaptive grid shader
    viewcube.ts      CSS-3D view cube
    input.ts         pointer-event router (pen/touch/mouse)
  tools/
    tool.ts          tool interface, selection → reference helpers
    featureOp.ts     base for operations: pick slots + values + preview
    slots.ts         axis / plane / direction / path / faces / profiles slots
    ops.ts           extrude, fillet, revolve, sweep, loft, shell, transforms, split, plane, axis
    select.ts        selection-driven menus + default handles
    sketch.ts        the sketch tool (all drawing & editing tools)
    section.ts, measure.ts
  io/insert.ts       STEP/STL/OBJ/DXF/project import, images, variables
  ui/                DOM chrome: tool column + flyouts, right column, panel, history
tests/               Node tests (npx tsx tests/<name>.test.ts)
```

## Roadmap (order matters)

1. ✅ Skeleton: viewport, input, kernel worker, document + history.
2. ✅ Sketch (line/rect/circle/polygon) → extrude → push/pull → fillet/chamfer → booleans.
3. Sketch constraints + driving dimensions with PlaneGCS (`@salusoft89/planegcs`).
4. Region detection (overlapping sketch shapes split into selectable regions).
5. Revolve, sweep, loft, shell, offset face.
6. Transform tools (gizmo), patterns, mirror.
7. Construction planes/axes, variables.
8. Import (STEP/STL/images), measure, section view.
9. Service worker (offline), file handling, iPad polish (Apple Pencil hover).
