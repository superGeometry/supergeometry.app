# Feature catalog

Functionality list. Implemented from scratch on OpenCascade.
Visualization, cloud sync, XR, sharing and accounts are out of scope.

Legend: ✅ done · 🚧 partial · ⬜ planned

## Sketch
| Feature | Status |
|---|---|
| Sketch → origin planes (XY/XZ/YZ), flat faces, construction planes, existing sketches | ✅ |
| Camera turns normal to the plane, orthographic; Line armed | ✅ |
| Line (chains; tap first point to close) | ✅ |
| Arc (2 endpoints + bend point) | ✅ |
| Spline (fit points / control points, open or closed) | ✅ |
| Rectangle (diagonal / center / 3 points) | ✅ |
| Circle, Ellipse, Polygon (n sides) | ✅ |
| Text (outline font → regions) | ✅ |
| Project body edges onto the sketch | ✅ |
| Offset edge | ✅ |
| Sketch fillet (corner of two lines) | ✅ |
| Move/Rotate, Scale, Pattern linear/circular, Rotate around point, Mirror (with copy) | ✅ |
| Trim, Extend, Delete | ✅ |
| Construction geometry toggle | ✅ |
| Overlapping shapes split into selectable regions (with holes) | ✅ |
| Live dimensions + type exact values while drawing | ✅ |
| Edit size of a selected curve (length, W/H, radius, sides…) | ✅ |
| Snapping: grid, guide points (end/mid/center), guide lines (H/V alignment), 3D points, distant edges | ✅ |
| Constraints (parallel, tangent, coincident…) + driving dimensions | ⬜ next (PlaneGCS) |

## Selection-driven tools
| Selection | Tools | Status |
|---|---|---|
| Profile | Sketch, Move/Rotate, Scale Sketch, Patterns, **Extrude**, Axis ⊥, Plane offset, Text, Rotate, Mirror, Loft, Split, Revolve, Sweep, Offset Edge, Delete | ✅ |
| Profile | Fill, Project as Sketch/Edge, Wrap & Emboss | ⬜ |
| Face | Sketch, Move/Rotate, Scale, **Offset Face**, Fillet/Chamfer (face edges), Extrude, Shell, Axis ⊥, Plane offset, Patterns, Translate, Rotate, Mirror, Loft, Split, Revolve, Sweep, Project as Sketch, Offset Edge, Text, Delete | ✅ |
| Face | Align, Fill, Replace Face, Project as Edge | ⬜ |
| Edge | **Fillet**, Chamfer, Move/Rotate, Axis along edge, Plane ⊥ edge, Translate, Rotate | ✅ |
| Body | Move/Rotate, Scale, Translate, Patterns, Rotate, Mirror, Union/Subtract/Intersect, Split, Shell, Delete | ✅ |
| Plane / Axis | Sketch, Plane offset, Split, Delete | ✅ |

## Top-level menus
| Feature | Status |
|---|---|
| Insert → Variable (usable in every field: `width*2`, `1in + 3mm`) | ✅ |
| Insert → Image (reference on a plane) | ✅ |
| Insert → File: STEP/STP, STL, OBJ, DXF; DWG explains how to convert | ✅ |
| Insert → Project (append another .super history) | ✅ |
| Construct → Offset plane, Midplane, Axis | ✅ |
| Construct → Plane through 3 points / on curve | ⬜ |
| Transform → Move/Rotate, Scale, Translate, Pattern, Rotate Around Axis, Mirror | ✅ |
| Transform → Align | ⬜ |
| Tools → every solid tool (waits for the right selection) | ✅ |
| Section View: plane/face, drag, flip, caps, stays on | ✅ |
| Section View: 2D section, section only | ⬜ |
| Measure: area, length, radius, size, volume, distance, min distance, angle, XYZ deltas, pins | ✅ |

## Right column
| Feature | Status |
|---|---|
| Snapping toggles | ✅ |
| Units (mm/cm/m/in/ft), lock grid size, degree format | ✅ |
| Adaptive grid 0.001 mm … 1 000 000 mm, on the sketch plane while sketching | ✅ |
| Views: default, 6 presets, saved views; Appearance (animate, ortho, grid, axes, pins) | ✅ |
| Display modes: Shaded / X-Ray / Wireframe, edges, hidden edges | ✅ |
| Zebra / curvature analysis | ⬜ |
| Screenshot (PNG) | ✅ |
| View cube (click faces, drag to orbit, 90° roll) | ✅ |
| History (edit, suppress, delete any step) | ✅ |

## Document & platform
| Feature | Status |
|---|---|
| Editable history for every feature type | ✅ |
| Undo / redo, autosave (IndexedDB), open/save `.super`, export STL/STEP | ✅ |
| Migration of older project files | ✅ |
| Any browser; pen/finger/mouse; palm rejection; phone layout | ✅ |
| Offline service worker | ⬜ |
