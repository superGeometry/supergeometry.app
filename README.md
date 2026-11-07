# supergeometry.app

**A free 3D design (CAD) app that runs in your web browser** - on a computer,
an iPad or Android tablet, a phone, or a VR headset like the Meta Quest 3.
No account, no download, no subscription. Your work stays on your device.

👉 **Open it:** [supergeometry.app](https://supergeometry.app)

Use it to design things for 3D printing, woodworking, laser cutting or just to
think in 3D: brackets, boxes, vases, knobs, threads, enclosures, furniture parts…

---

## Contents

1. [The idea in one minute](#the-idea-in-one-minute)
2. [Your first part: a box with a hole](#your-first-part-a-box-with-a-hole)
3. [Second part: a vase](#second-part-a-vase)
4. [Moving around](#moving-around)
5. [The screen, piece by piece](#the-screen-piece-by-piece)
6. [Sketching](#sketching)
7. [Making and changing solids](#making-and-changing-solids)
8. [Exact sizes, variables and the numpad](#exact-sizes-variables-and-the-numpad)
9. [History: change anything later](#history-change-anything-later)
10. [Saving, opening, exporting, printing](#saving-opening-exporting-printing)
11. [Tips for phones, tablets and headsets](#tips-for-phones-tablets-and-headsets)
12. [Keyboard shortcuts](#keyboard-shortcuts)
13. [When something doesn't work](#when-something-doesnt-work)
14. [For AI assistants](#for-ai-assistants)
15. [For developers](#for-developers)
16. [License](#license)

Inside the app, **More → Help** shows what every button does.

---

## The idea in one minute

Almost everything follows the same rhythm:

1. **Draw a flat shape** - a *sketch* - on a plane or on a face of a part.
2. **Turn it into a solid** - pull it up (*Extrude*), spin it around an axis
   (*Revolve*), or move it along a path (*Sweep*).
3. **Select something and change it** - tap a face, an edge or a whole body:
   only the tools that make sense for it appear on the left. Drag the arrow or
   type a number.
4. **Every step is remembered** in *History*, so you can go back and change a
   size later - everything after it updates.

There's no wrong order. Undo (bottom left) is always one tap away.

---

## Your first part: a box with a hole

1. Tap **Sketch** (left column), then tap the blue **XY** square near the
   middle of the screen. The view turns to look straight down at that plane.
2. Tap **Rectangle**, tap one corner, tap the opposite corner. While you draw,
   type a number for an exact size (e.g. `40`, Tab, `30`).
3. Tap **Circle**, tap a centre inside the rectangle, tap again for the size
   (or type `8`).
4. Tap **Exit Sketch** (top left of the tools) - or just tap an empty spot
   while looking at it from the side.
5. Tap inside the rectangle (but outside the circle): that region turns blue
   and an **arrow** appears. Drag the arrow up, or type `20`. You now have a
   box with a round hole.
6. Tap the top face of the box. Drag its arrow to make it taller - the hole
   follows. Tap an edge and drag the dot **outward** for a rounded edge
   (*fillet*) or **inward** for a bevel (*chamfer*).
7. **File → Export STL** to 3D-print it.

## Second part: a vase

1. **Sketch** on the **XZ** plane (a standing plane).
2. Draw the outline of *half* the vase with **Line** and **Spline**: a
   vertical line on the centre (this is the axis), a line along the bottom,
   a spline for the side and a line across the top, back to the axis.
3. Exit the sketch, tap the region, then **Revolve** and tap the vertical
   line as the axis. 360° makes a full vase.
4. Want a thread or a spring instead? In Revolve, drag the arrow on the axis
   (**Travel**) and set the angle above 360°.

---

## Moving around

| | Mouse | Touch / pen | Headset controller |
|---|---|---|---|
| Turn the view | left-drag empty space | one-finger drag | drag with the trigger |
| Move the view | right or middle-drag | two-finger drag | - (use the view cube) |
| Zoom | mouse wheel | pinch | thumbstick / pinch |
| Select | click | tap | point and trigger |
| Select a whole body | double-click | double-tap | double-trigger |
| Deselect | Esc or click empty space | tap empty space | tap empty space |
| Step back | right-click or Esc | - | - |

- **Right-click steps back**: first what's half done or picked, then the
  drawing tool, then out of the sketch; in other tools it backs out. With
  something selected, right-click shows its tools by the pointer.
- On touch screens **every tap adds to the selection**; tap again to drop it.

- **Fit** (right column) zooms so everything is on screen.
- **View cube** (top right): tap a face for a straight-on view (Top, Front…);
  ⟲ ⟳ at its top corners turn the view by 90°.
- **Orbit centre** (the cube's bottom-left button): tap it, then tap a point -
  the view now turns around that point. Fit resets it.
- **Views** (the cube's bottom-right button): standard and saved views, and
  how the view looks; tap again to close.
- On touch screens, **press and hold a tool** to see its name in the middle
  of the screen; let go on it to use it, slide off to cancel.

---

## The screen, piece by piece

**Top bar** (top centre) - the project name (tap to rename), **File** (new / open / save /
export), **Items** (a list of everything, with eyes to hide or show and
folders to group; each kind - Bodies, Sketches, Planes & axes, Images - folds
away under its heading, and a plane's icon shows how it was made), **More**
(fullscreen, Help, About, support). On tablets and computers Items runs the
full height of the screen, like History.

**Left column** - the tools. With nothing selected you get the ones that
*make* things (Sketch, Freeform, Extrude, Revolve, Transform, Construct,
Insert…). With something selected you only see what can be done with it,
in groups (picking, moving and patterns, making, combining, construction,
colour, delete) apart with a dim line.

**Right column** (middle of the right edge) - Fit, Snapping, Units & grid,
Display mode, Screenshot, Numpad (on / off), History, and in a sketch,
Constraints.

**Bottom left** - Undo / Redo, Section View (cut the view open), Measure and
Isolate (show only the selected bodies).

**The tool card** - the values for whatever you're doing (sizes, counts,
options), its own actions, and Cancel / Done, each apart with a dim line. It
keeps clear of what you're drawing; drag it by its grip where you want it
(remembered per screen type), double-tap the grip to let it place itself.

---

## Sketching

Tap **Sketch** and pick where to draw: an origin plane (tap it, or the
**XY** floor / **XZ** front / **YZ** side buttons), a flat face of a part, or
one of your construction planes (listed by name in the card). In a
straight-on view (Front, Top…) Sketch goes on the face you're looking at.
Sketches on a face measure X / Y from the model's origin.

**Drawing tools:** Line (keeps going from the last point; tap the first point
to close), Arc (two ends, then the bend - or by centre), Spline (smooth curve through points;
*Fit* or *Control* points, or *Draw*: press and drag freehand like a pencil - the stroke
is cleaned up into a few lines, arcs and smooth curves, corners kept, so an extrusion
gets a handful of faces, not hundreds; end where you began to close it), Rectangle (diagonal / centre / 3 points), Circle
(centre, 2 points or 3 points), Ellipse (with an Angle), Polygon, Text (pick a font - Sans, Serif, Mono, Narrow, Bold caps,
Script - or **Import font…** a .ttf / .otf / .woff of your own), Project
(copies body edges or other sketches' curves here).

**Exact points on touch screens:** right after the first tap of a line,
rectangle, circle, polygon or ellipse the card has **X / Y** for that point
(a fingertip can't hit a 1 mm grid). A line then takes **Length and Angle**,
or **Across and Up** for a slope ("in 10, up 12"); an arc by centre takes the
centre, Radius and the Start and End angles. Grid snapping follows the zoom
(1 / 5 / 10 mm) so a tap lands where a fingertip can tell apart. A typed shape
is placed with Enter or Done.

**Drawing guides** (on a curve, midpoints, extensions, parallel /
perpendicular, where two cross) are kept as constraints. Dragging a point onto
another joins them.

**Edit tools:** Offset Edge (parallel copy; whole outlines too), Fillet and
Chamfer (round or bevel a corner where lines or arcs meet; tap the next corner
to go on), Mirror (the selected shapes, across a line or an axis), Trim (cut
away between crossings - tap, or swipe across several - or *Join* two lines
on one axis), Align (put a line onto another line's axis), Extend (arcs carry
on along their circle), Split, Move/Rotate (gimbal, or Rotate About a tapped
centre), Scale, Pattern (linear with an arrow you drag, or circular around a
centre), Delete. Tools with options start with the option you used last.
Tapping empty space finishes Offset, Move, Scale, Pattern, Rotate and Mirror.
On phones the tool column shrinks to icons once you place a point; tap the
tool in use to see the names again.

**Select** (in a sketch): tap curves to select them, double-tap for a whole
shape. Drag points or curves, or use the gimbal. Tap an arc or circle to type
its radius. The panel's **Select last** picks what your last step made.

**Construction lines** are helpers: they guide the drawing but don't make
regions. The Construction / Regular button switches the selection (or new
lines).

**Constraints** keep a drawing in shape: horizontal, vertical, parallel,
perpendicular, tangent, equal, coincident, lock, distance, angle and size
dimensions. Select one or two things, then tap a constraint (the first thing
picked stays put, the others adapt to it). Constraints are strict: one that
contradicts those already there isn't added - remove the old one first, or
switch **Auto constrain** off; a typed value that can't be met is refused
rather than bending the sketch. Their marks are small and faint, a colour per
kind, and never catch a tap meant for the drawing. Toggle the column with the
**Constraints** button on the right.

Any closed shape becomes a **region** (blue when selected) you can extrude,
revolve, sweep or loft. Overlapping shapes split into separate regions.
Tapping a region shows Extrude's arrow - drag it, or type a height - and
Revolve, Sweep and Loft beside it in the column for the same shape. While the
arrow is still at 0, tapping more regions of the same sketch adds them;
**All shapes** takes every shape at once. Double-tap a shape to open its
sketch. A sketch stays in view until every region of it is used.

---

## Making and changing solids

- **Extrude** - pull a region or a face. Negative distances cut. In *Auto*
  mode an extrusion that runs into another body cuts through it; choose *New*
  for a separate body. **Taper** shrinks the far end, down to a point: a
  spire, a pyramid or a cone in one step. Extrude starts at the last distance.
- **Revolve** - spin a region around an axis (a separate line, a side of a
  rectangle or outline, a round edge, or one of your axes by name);
  **Travel** moves it along the axis at the same time (threads, springs).
- **Sweep** - move a region along a path (one tap takes the whole joined run
  of lines and arcs; tap a piece again to drop it). **Loft** - blend between
  profiles.
- **Shell** - hollow a body; tapped faces become openings (Clear empties the
  list).
- **Fillet / Chamfer** - tap edges, drag the dot (outward rounds, inward
  bevels) or type a size in the box on the model; variables work too. A
  fillet that can't be made leaves the edge sharp with a note in History.
- **Faces** - drag the arrow to push/pull a face: its neighbours follow,
  curved ones included; fillets next to it are kept. **Move/Rotate Face**
  moves it every way and turns it about its normal. Scale, Replace (onto
  another face's plane) or **Delete** a face, fillet or chamfer: the
  neighbours carry on along their own surfaces until they meet, as if it was
  never there.
- **Edges and corners** - a straight edge picked shows its Move/Rotate
  gimbal; the faces around it tilt to follow (Fillet / Chamfer are in the
  list). Every edit is checked: one that would tear the body open stops with a
  message instead.
- **Transform** - Move/Rotate (gimbal, with a Copy switch: after a drag the
  panel stays for exact values; copies are independent bodies, **Link** keeps a
  freeform copy following its original), Scale (uniform,
  or X/Y/Z on freeform bodies), Translate (from a point to a point), Mirror,
  Rotate Around Axis (a round edge gives an axis through its centre),
  Patterns. A body of a pattern picked: **Whole Pattern** selects the rest.
- **Union / Subtract / Intersect** - combine bodies (they need to touch to
  unite), cut one from another, or keep the overlap. Subtract and Intersect
  open a tool: tap the body to change (marked **+**), then the bodies to cut
  with (marked **−**); **Keep modified body** / **Keep subtracted bodies**
  leave copies. Two overlapping bodies picked: all three are in the list.
  Many tools at once are one checked cut.
- **Split Body** - by a plane (yours, by name) or a face.
- **Thread** - tap a round face or a hole's rim: a shank at the nominal size
  gets an outside thread, a hole at the tap-drill size an inside one. The
  pitch starts at the ISO coarse pitch (the card says what it makes, e.g.
  M10 × 1.5); left-hand as an option.
- **Repair Body** - fixes an imported or broken body (gaps, bad faces,
  slivers, inside-out) without changing its shape or size.
- **Fill to Plane** - an open freeform surface becomes a solid by filling
  the gap down (or up, or across) to a plane.
- **Freeform** - organic shapes: start from a box, sphere, cylinder or plane
  (its size and rows in the card) and pull its cage points, edges and faces.
  Tap picks the closest point, edge or face (tap a face again for the one
  behind it); press on empty space and drag a box to pick the points inside.
  Move / Turn / Scale take exact X, Y, Z values in the card. Cage tools:
  **Extrude faces** (Length, Bend, Taper and Steps sliders - a spout in one
  go), **Bridge faces** (two faces become a tube; two looking the same way
  arch into a handle, with Arch and Segments), **Inset**, **Add edge loop**,
  **Add detail**. **Symmetry** mirrors every move across X / Y / Z, across a
  tapped cage edge, or midway between two facing faces picked first; the
  plane is kept with the shape and shown with its mark. Points picked on an
  open border → **Extend surface** adds a face beyond each border edge
  between them. Undo / Redo step through the cage changes. A shape that
  passes through itself shows red and is refused. Delete faces to open it up; tap
  an edge of a hole → **Fill hole** to close it again, or **Thickness…** to
  turn the open shape into a solid wall. A hole with an odd number of edges
  is closed by making the cage twice as fine first (the shape doesn't change).
  **Connect**: pick border edges (Shift adds) on one surface or on two - two
  edges get a face between them, two rows a strip, two hole rims a tube; two
  surfaces become one, ready for a Thickness. Both sides need the same number
  of edges.
- **Copy a sketch to another plane** - tap a region of a finished sketch →
  **Copy to Plane**: drag the blue arrow to a parallel plane, or type the
  distance (Copy off moves it instead).
- **Construct** - helper planes: offset (drag its arrow), midplane, through
  3 points, on a curve at a point, perpendicular to an edge at a point,
  through an edge at an angle, parallel to a face at a point. Each kind has
  its own small mark at the plane's corner (⇡ ⇹ ∴ ∿ ⊥ ∠ ∥) and on its icon.
  Axes from a face or edge, or along X / Y / Z through a point you type.
- **Colour** - ten soft colours or **Custom…** for any colour; and how
  see-through a body is.
- **Section View** - cut the view (not the part) to look inside; the cut
  shows as a solid face with a thick outline.
- **Measure** - distances and angles; pin a measurement to keep it.

---

## Exact sizes, variables and the numpad

- Every drag shows a **value box** by the pointer that stays when you let go:
  tap it to type. While dragging or drawing, **just type a number** - it goes
  into that box. Enter confirms. **Press on any value box and drag left or
  right** to turn the value down or up like a wheel. Units come from **Units & grid** (mm, cm, m, in, ft);
  you can also type units (`2in`, `5cm`) and maths (`40/3 + 2`).
- **Variables** (Insert → Variables → New Variable / Edit Variables) are named sizes like `wall = 3`.
  Type them into any field (`wall * 2`) or pick them from the **ƒx** menu
  next to a value. Change the variable later and everything using it updates.
- The **on-screen numpad** (the keypad button in the right column - tap it
  on or off) replaces the system keyboard for value boxes. It's on by default
  on phones, tablets and headsets. Tapping a box selects its value, so typing
  replaces it; nothing is applied until you press ↵. After the second tap of
  a line, its length box opens right away. Drag the numpad by its grip where
  you want it; double-tap the grip to put it back by the box.

---

## History: change anything later

The **History** panel lists every step. Tap a step to edit it (its tool opens
with the old values). The eye switches a step off; the bin deletes it. Hover
a step to see what it works on, outlined in dashed orange. A sketch's own
steps fold out from the ▸ next to it. Select several steps (Ctrl/Shift+click)
to **group** them: fold, rename, switch all off or on, ungroup. If a step
can't be rebuilt after a change, it's marked and the reason is shown.

---

## Saving, opening, exporting, printing

- Your project **saves itself** in this browser as you work.
- **File → Save project** downloads a `.super` file (keep it as a backup or
  move it to another device); **File → Open** loads one.
- **File → Export STL** or **Export 3MF** for 3D printing (3MF keeps body
  names and colours), **Export STEP** for other CAD programs. With bodies
  selected (or isolated), only those are exported. On phones and tablets the
  **share mark** next to each export (and Save) sends the file straight to
  another app - mail, messages, a slicer…
- **File → Export DXF (sketch)** saves a sketch's curves as a 2D drawing for
  laser cutters, CNC and drawing programs: open **Items**, tap the sketch, then
  File → Export DXF. Construction lines go on their own layer.
- **File → New project** asks whether to save the open project first or
  discard it.
- **Insert** brings in STEP, STL, SVG and DXF files, and images to trace over
  (on the floor, front or side, its middle at the X / Y you type).

---

## Tips for phones, tablets and headsets

- Tools show as icons: press and hold one to see its name.
- With a pen, fingers are ignored while the pen touches the screen.
- iPad / Android: **More → Fullscreen** gives the whole screen. On phones and
  tablets the app offers to be **installed on the home screen** (or More →
  Install app); on iPhone/iPad it's *Share → Add to Home Screen*.
- The app asks to go full screen when it opens. The tool card fits the widest
  clear gap along the bottom (beside undo/redo on a phone on its side), and a
  tool's options open beside a column of tools instead of over it.
- Fit frames the model in the part of the screen the columns and bars leave
  free.
- Meta Quest: open the site in the Quest browser; buttons and pick distances
  are bigger, and the numpad is on.

## Keyboard shortcuts

`S` Sketch · in a sketch: `L` line, `A` arc, `I` spline, `R` rectangle,
`C` circle, `G` polygon, `P` project, `O` offset, `T` trim, `E` extend,
`M` move, `S` scale, `V` select · outside: `E` extrude, `F` fillet,
`M` move, `N` translate, `U` union, `F2` edit freeform · `Del` delete ·
`Enter` done · `Esc` cancel / deselect · `Ctrl Z` / `Ctrl Y` undo / redo ·
`Ctrl S` save · `F` fit.

## When something doesn't work

- **A step turns red in History**: tap it to see why and change its values.
  Often a size became too big or a face it used was removed.
- **"Overlap them more"**: a union or cut that the geometry engine can't do
  reliably (two bodies only just touching) is refused instead of giving a
  wrong shape - move them so they overlap a little more.
- **An imported body won't edit**: try **Tools → Repair Body** first.
- **"Not closed" warning**: a body has a gap (open edges shown in orange). A
  freeform surface without thickness is open on purpose.
- **Can't find a tool**: tools only show when they can be used - select the
  right kind of thing first (a face, an edge, a body, a region).
- **Something is hidden**: check the eyes in **Items**, and whether
  **Isolate** is on.
- **A "Working…" spinner**: the geometry engine is busy; complex steps can
  take a moment. **Stop** next to it drops the work and takes back the change
  that started it (like an undo).
- **A change you expected isn't there yet**: when a newer version is out, a
  notice offers to update. **More → Reset cache & update** loads the newest
  version right away (your project is kept).

---

## For AI assistants

This section describes the app so an assistant can explain it, guide a user
step by step, or read and write project files.

**What it is.** A browser-based parametric solid modeler. Geometry is
OpenCascade (via replicad) running in a Web Worker; the UI is plain DOM over a
three.js view. Units are millimetres internally; the display unit is a setting.

**Interaction model.**
- Nothing selected → the left column shows creation tools: Sketch, Freeform,
  Extrude, Revolve, Sweep, Loft, Shell, Transform ▸ (Move/Rotate, Scale,
  Translate, Mirror, Rotate Around Axis, Patterns), Boolean ▸ (Union,
  Subtract, Intersect), Construct ▸ (planes, axes), Insert ▸ (variables,
  images, files), Tools ▸ (Offset Face, Split Body, Fill to Plane, Thread,
  Repair Body…).
- Something selected → only tools valid for it are shown (unusable ones are
  hidden, not greyed). Faces get a drag arrow (offset), straight edges a
  Move/Rotate gimbal (Fillet / Chamfer in the list), bodies a gimbal
  (move/rotate, with Copy). A sketch region gets Extrude's arrow plus
  Revolve / Sweep / Loft.
- Every operation is a *feature* in History; editing a feature replays
  everything after it.
- Values: type while dragging, or in the bottom panel; expressions and
  variables are accepted everywhere a number is.

**Project file (`.super`, JSON).**

```jsonc
{
  "format": "super", "version": 2, "name": "Bracket", "units": "mm",
  "variables": [{ "name": "wall", "expr": "3" }],
  "hidden": ["<item id>"], "names": { "<body id>": "My name" },
  "features": [
    { "id": "s1", "type": "sketch", "name": "Sketch 01",
      "plane": { "origin": [0,0,0], "xDir": [1,0,0], "normal": [0,0,1] },
      "entities": [{ "id": "r", "kind": "rect", "center": [0,0], "w": 40, "h": 30, "rotation": 0 }],
      "constraints": [] },
    { "id": "e1", "type": "extrude", "name": "Extrude 01",
      "source": { "kind": "profile", "sketch": "s1", "regions": [{ "c": [0,0], "a": 1200 }] },
      "distance": 20, "mode": "auto",
      "exprs": { "distance": "wall * 6" } }
  ]
}
```

- Sketch entity kinds: `line {a,b}`, `arc {a,m,b}` (through 3 points),
  `circle {center,radius}`, `ellipse`, `rect {center,w,h,rotation}`,
  `polygon {center,radius,sides,angle}`, `spline {points,closed,mode}`,
  `polyline {points,closed}`; `construction: true` marks helper geometry.
  Sketch coordinates are 2D in the sketch plane (`xDir`, and `normal × xDir`).
- A region reference `{c, a}` is the region's centroid and area in sketch
  coordinates (it survives small edits).
- Feature types: `sketch`, `extrude`, `revolve` (`axis`, `angle`, `travel`),
  `sweep`, `loft`, `shell`, `fillet` / `chamfer` (`edges`, `radius`),
  `boolean` (`union` / `subtract` / `intersect`; `keepTarget`, `keepTools`),
  `transform` (`move`, `scale`, `scaleXYZ`, `mirror`, `linear`, `circular`),
  `split`, `plane` (`kind`: `offset`, `mid`, `3pt`, `curve`, `perp`, `angle`,
  `parallel`), `axis`, `moveFace` (face / edge / vertex), `scaleFace`,
  `replaceFace`, `deleteGeom`, `freeform` (`cage`, `surface`, `thickness`,
  `symmetry {origin, normal}`), `thread`, `repair`, `import`, `image`.
- Faces and edges are referenced by geometry, not index:
  faces `{body, center, normal, area}`, edges `{body, mid, dir, length}`.
- `exprs` maps a field path (`"distance"`, `"op.translate.2"`) to an
  expression; it's evaluated with the project's variables on every rebuild.

**Scripting in the page.** In the browser console, `window.supergeometry` is
the running app: `supergeometry.store.doc` is the project (as above),
`supergeometry.store.commit(doc => { … })` changes it as one undoable step,
and `supergeometry.result` holds the last rebuild (`bodies`, `errors`).

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
`replicad-opencascadejs`) is LGPL-2.1; replicad and three.js are MIT.
