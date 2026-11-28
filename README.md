# superGeometry.app

**Free 3D CAD in your browser.** Sketch an idea, turn it into a solid part, and
send it to your printer, on a computer, a tablet, a phone or a VR headset.

👉 **Open it:** [superGeometry.app](https://supergeometry.app)

No account. No download. No subscription. Your work stays on your device.

## Why try it

- **Works on every device.** The same app with a mouse or a finger, and it
  keeps working without a connection once Offline mode is on.
- **Real CAD, not a toy.** Exact sizes, constraints and variables, and a
  History you can go back into: change a size from ten steps ago and the rest
  follows.
- **Made for 3D printing.** Screw holes by size, threads that fit, shells,
  lips, bosses, snap fits and ribs for cases, an overhang check, and export to
  STL, 3MF and STEP.
- **Your files, your formats.** Opens STEP, STL, OBJ, 3MF, glTF, FreeCAD, BRep,
  IFC, DXF and SVG. An imported mesh becomes a solid you can keep editing.
- **Free and open source.** No ads, no tracking, no paid tier.

## What is in it

| | |
|---|---|
| **Sketch** | Lines, arcs, splines, text, constraints, dimensions, patterns |
| **Create** | Extrude, Revolve, Sweep, Loft, Hole, Lip, Boss, Snap Fit, Rib |
| **Modify** | Fillet, Chamfer, Shell, Thread, push and pull faces, Split, Repair |
| **Combine** | Union, Subtract, Intersect, Mirror, linear and circular Patterns |
| **Freeform** | Smooth organic shapes pulled by their points, edges and faces |
| **Check** | Measure, Section View, zebra stripes, curvature, overhangs |
| **Share** | 2D drawings, a History timelapse as a video, AR and VR viewing |

## Start in two minutes

1. Open [superGeometry.app](https://supergeometry.app). A new project starts in a sketch.
2. Draw a rectangle and tap the tick.
3. Tap the shape and pull its arrow up: that is your first solid.
4. Tap an edge and drag its dot to round it.

**More → Tutorial** in the app builds a bolt and the nut that fits it with you,
one tap at a time. **More → Help** says what every button does.

The full walkthrough is in the **[manual](docs/MANUAL.md)**.

## Feedback and support

- A bug or an idea: [open an issue](https://github.com/superGeometry/supergeometry.app/issues), or use **More → Feedback** in the app.
- The app is free and one person makes it. If it is useful to you, a free
  [MakerWorld](https://makerworld.com/en/@supergeometry/upload) Boost or a
  coffee on [Ko-fi](https://ko-fi.com/supergeometry) helps a lot.

## For AI assistants

Start at [llms.txt](https://supergeometry.app/llms.txt): how to build a model in
a person's open tab, and how to teach the app step by step. The project file
format is in the [manual](docs/MANUAL.md#for-ai-assistants).

## For developers

```bash
npm install
npm run dev      # local dev server (add --host to open it from a tablet)
npm run build    # static site in dist/ - host it anywhere
npx tsx tests/engine.test.ts   # one of the test suites in tests/
```

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it's built and why
- [docs/FEATURES.md](docs/FEATURES.md): feature list

Stack: TypeScript, Vite, three.js, replicad + OpenCascade (WebAssembly),
no UI framework. Project autosave in IndexedDB.

## License

AGPL-3.0-or-later: anyone can use, study, change and host it, but modified
versions offered to the public must stay open source. OpenCascade (via
`replicad-opencascadejs`) is LGPL-2.1; replicad and three.js are MIT; web-ifc
(the IFC reader) is MPL-2.0.
