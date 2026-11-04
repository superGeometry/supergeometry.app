# supergeometry.app

A free 3D solid modeler that runs in the browser on any device: desktop, iPad (with
Apple Pencil), Android tablets and phones. No account, no server, no subscription.

The workflow is inspired by tablet-first CAD apps: you select something and the
tools for it appear; you drag a handle or type a number; every step lands in an
editable history. Geometry is computed by [OpenCascade](https://dev.opencascade.org/)
(via [replicad](https://replicad.xyz)) compiled to WebAssembly, running in a Web Worker.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL. `--host` is on, so a tablet on the same Wi-Fi can open the
"Network" URL too.

## Build & publish

```bash
npm run build
```

`dist/` is a static site. Upload it anywhere: GitHub Pages, Cloudflare Pages,
Netlify, any web server. No backend needed.

## Using it

| | Mouse / keyboard | Touch / pen |
|---|---|---|
| Orbit | left-drag empty space | one-finger drag |
| Pan | right/middle-drag, shift+drag | two-finger drag |
| Zoom | wheel | pinch |
| Select | click (adds to selection) | tap (pen or finger) |
| Select body | double-click | double-tap |
| Clear selection | Esc / click empty | tap empty |

While the pen touches the screen, fingers are ignored (palm rejection).

Shortcuts: `S` sketch · in sketch `L` line, `R` rectangle, `C` circle, `G` polygon,
`V` select · `E` extrude · `F` fillet · `C` chamfer · `Del` delete · `Enter` done ·
`Esc` cancel/exit · `Ctrl Z / Ctrl Y` undo/redo · `Ctrl S` save.

## Docs

- [docs/FEATURES.md](docs/FEATURES.md): what exists and what's planned
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it's built and why

## License

AGPL-3.0-or-later: anyone can use, study, change and host it, but modified
versions that are offered to the public must stay open source.
OpenCascade (via `replicad-opencascadejs`) is LGPL-2.1; replicad and three.js are MIT.
