# superGeometry.app

**A free 3D design (CAD) app that runs in your web browser** - on a computer,
an iPad or Android tablet, a phone, or a VR headset like the Meta Quest 3.
No account, no download, no subscription. Your work stays on your device.

👉 **Open it:** [superGeometry.app](https://supergeometry.app)

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

Inside the app, **More → Help** shows what every button does, and **More →
Tutorial** builds a first part with you: an M10 bolt and the nut that fits it,
one lit tap at a time (the first time the app is opened, the welcome window
has a Tutorial button, and it is offered once more when that window is closed).

---

## The idea in one minute

Almost everything follows the same rhythm:

1. **Draw a flat shape** - a *sketch* - on a plane or on a face of a part.
2. **Turn it into a solid** - pull it up (*Extrude*), spin it around an axis
   (*Revolve*), or move it along a path (*Sweep*).
3. **Select something and change it** - tap a face, an edge or a whole body:
   it can be dragged by itself (or by its arrow or dot), or typed; the buttons
   beside it hold the next likely tools, Delete and More, and the line at the
   bottom has every tool by group.
4. **Every step is remembered** in *History*, so you can go back and change a
   size later - everything after it updates.

There's no wrong order. Undo (bottom left) is always one tap away.

---

## Your first part: a box with a hole

1. A new project opens straight in a sketch on the floor, looking down at
   it, with **Line** on. (Any other time: tap **Sketch** on the line at the
   bottom, then a plane or a flat face.)
2. Tap **Draw**, then **Rectangle**; tap one corner, tap the opposite corner. While you draw,
   type a number for an exact size (e.g. `40`, Tab, `30`, then Enter or a
   click): with a mouse the sizes show in small tags by the pointer, the one
   a typed number goes to lit. The ways a tool can
   be used (Rectangle: Center, Diagonal, 3 Points) are on the line while it is on.
3. Tap **Draw**, then **Circle**; tap a centre inside the rectangle, tap again for the size
   (or type `8`).
4. Tap **Exit** at the end of the line. The view swings round to a
   three-quarter view.
5. Tap inside the rectangle (but outside the circle): that region turns blue
   and an **arrow** appears. Drag the shape itself, or its arrow, up - or type
   `20`: drawn on a plane, up makes a new body (down would cut). Tap the tick.
   You now have a box with a round hole.
6. Tap the top face of the box and drag it to make it taller - the hole
   follows. Tap an edge and drag it **outward** for a rounded edge
   (*fillet*) or **inward** for a bevel (*chamfer*). Tap the hole's wall:
   **Thread** is on a button beside it.
7. **More → Print / Share** says whether it is fit to print and saves it as
   3MF, STL or STEP.

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
| Turn the view | right-drag (or Alt + left-drag) | one-finger drag | drag with the trigger |
| Move the view | middle-drag (or Shift + right-drag) | two-finger drag | - (use the view cube) |
| Zoom | mouse wheel | pinch | thumbstick / pinch |
| Roll the view | ⟲ ⟳ on the view cube | twist two fingers | - |
| Select | click | tap | point and trigger |
| Select several | left-drag a box on empty space, or Ctrl + A for everything | tap one after another | point and trigger |
| Select a whole body | double-click | double-tap | double-trigger |
| Deselect | Esc or click empty space | tap empty space | tap empty space |
| Step back | right-click or Esc | - | - |
| Undo / Redo | Ctrl + Z / Ctrl + Y | tap with two fingers / with three | - |
| A menu by the pointer | right-click | press and hold still (on a part: then lift) | press and hold |

- **Used to another program's mouse?** Settings → Mouse makes the buttons
  turn, move and zoom the view as they do there: Onshape and Tinkercad (the
  way the app comes), Fusion / Inventor / Revit / AutoCAD, SolidWorks,
  Creo / Solid Edge / Blender / SketchUp, NX, CATIA / FreeCAD, or Rhino -
  and sets which way the wheel zooms.
- **Right-click steps back**: first what's half done or picked, then the
  drawing tool, then out of the sketch; in other tools it backs out. With
  something selected, right-click shows its tools by the pointer.
- **A tap picks that thing** and lets the last pick go; tap it again to drop
  it. Shift, Ctrl or the **+** beside the pick's name adds to the pick. With
  a face or an edge picked, **Whole body** beside its name picks the body (a
  double tap on the model does too).
- **A list opened from the line stays up** while you turn, move or zoom the
  view; it goes when you choose something in it or tap the model.

- **Fit**: double-tap the view cube to get everything on screen.
- **View cube** (top right): tap a face for a straight-on view (Top, Front…);
  ⟲ ⟳ at its top corners turn the view by 90°. On a touch screen two fingers
  twisted roll it by any amount, about the point between them; let go near
  level or near a quarter turn and it goes there. A rolled view comes level
  again as you turn it.
- **Orbit centre** (the cube's bottom-left button): tap it, then tap a point -
  the view now turns around that point. Fit resets it.
- **Views** (the cube's bottom-right button): standard and saved views; tap
  again to close.

---

## The screen, piece by piece

**Top bar** (top centre) - the project name (tap to rename), **File** (new / open / save /
export), **Items** (a list of everything, with eyes to hide or show and
folders to group; each kind - Bodies, Sketches, Planes & axes, Images - folds
away under its heading), **History**, **More** (fullscreen, Help, About,
support).

**The line at the bottom** is how every tool is reached. Tap part of the
model: a tag over the line names what is picked, and the line shows the
groups - Sketch, Freeform, Transform, Construct, Modify, Combine, Create -
each a list: what can be done with that pick first, then the group's other
tools in a quieter part (each asks for its own pick as it starts). The group
whose list is open stays lit. **More**, at the end of the line, holds only
what is not on the line already: Insert, BIM, Section View, Measure,
Variables, Print / Share, and the pick's own (Delete, Colour, Isolate). Tap a
tool and the line becomes its settings: tap a number to type it or drag it
sideways, tap a word to change it, tap the model to fill a blank; the tick
finishes, the cross takes it back. On a phone held upright a tool shows its
size and what it still needs tapped, and the rest is one word, **Options**.
In a sketch the line holds Draw, Modify and Transform.

**Looks ahead** - with a mouse, the pointer over a tool draws what it would
do in dashed yellow on the model before anything starts: a face's outline
lifted (Extrude, Offset Face) or sunk (Shell), the lines a Fillet or Chamfer
runs between, a row or a ring of copies for a pattern.

**Quick buttons** - round buttons beside a pick with its next two likeliest
tools (a flat face Sketch and Move, a round face Thread and Fillet, an edge
Chamfer and Move, a body Fillet and Mirror), then **Delete**, then **More**,
which opens every other tool that pick has. In a sketch: Construction and
Delete. On a phone they are smaller, their names the same size.
**Settings → Quick buttons** switches them off, for working from the
line at the bottom alone: every one of those tools is on it too.

**Right edge** - **Fit**, **Display** (shaded, wireframe, X-ray) and
**Settings**: one sheet with Units & grid, Snapping, Appearance and (with a
mouse) Mouse, each row saying how it is set now, then the two switches:
Number pad on screen and Quick buttons.

**Bottom left** - Undo / Redo.

**A tool's settings** - the values for whatever you're doing (sizes, counts,
options) are the words on the line while the tool is open, with Cancel and
Done at its end. The size that is dragged is also in a box on the model:
tap it to type.

---

## Sketching

Tap **Sketch** and pick where to draw: an origin plane (tap it, or the
**XY** floor / **XZ** front / **YZ** side buttons), a flat face of a part, or
one of your construction planes (listed by name on the line). In a
straight-on view (Front, Top…) Sketch goes on the face you're looking at.
Sketches on a face measure X / Y from the model's origin.

**Drawing tools:** Line (keeps going from the last point; tap the first point
to close, which ends the line), Arc (two ends, then the bend - or by centre; an end placed on a line's end shows, dashed, the bend that runs smoothly on from that line, and the third point snaps to it), Spline (smooth curve through points;
*Fit* or *Control* points, or *Draw*: press and drag freehand like a pencil - the stroke
is cleaned up into a few lines, arcs and smooth curves, corners kept, so an extrusion
gets a handful of faces, not hundreds; end where you began to close it), Rectangle (diagonal / centre / 3 points), Circle
(centre, 2 points or 3 points), Ellipse (with an Angle), Polygon, Text (pick a font - Sans, Serif, Mono, Narrow, Bold caps,
Script - or **Import font…** a .ttf / .otf / .woff of your own; each letter keeps the font's curves as
a few lines, arcs and smooth curves, so extruded text has a face per side, not hundreds), Project
(copies body edges or other sketches' curves here).

**Exact sizes on touch screens:** after the first tap of a line, rectangle,
circle, polygon or ellipse the line has the shape's sizes (on a phone, behind
**Values**): a line's **Length and Angle**, a rectangle's Width and Height, a
circle's Diameter; an arc by centre takes its Radius and the Start and End
angles. Type them, and the tick puts the shape in. Grid snapping follows the zoom
(1 / 5 / 10 mm) so a tap lands where a fingertip can tell apart. A typed shape
is placed with Enter or Done.

**Drawing guides** (on a curve, midpoints, extensions, parallel /
perpendicular, where two cross) are kept as constraints. Dragging a point onto
another joins them.

**Fill Pattern:** a closed shape filled with lines from edge to edge (straight, crossed, zigzag, waves) or with
small shapes (dots, honeycomb, squares, diamonds). One tap inside the shape fills it; its spacing and size are a
share of the shape, in percent (5 gives about twenty rows on a shape of any size), and the pattern follows when
they or its angle are changed. The strips and cells are shapes to extrude or cut, for textures.

**Edit tools:** Offset Edge (parallel copy; several edges together, or whole outlines; an ellipse's
offset is the curve the same distance from it all along, a spline), Fillet and
Chamfer (round or bevel a corner where lines or arcs meet; tap the next corner
to go on), Mirror (the selected shapes, across a line or an axis), Trim (cut
away between crossings - tap, or swipe across several - or *Join* two lines
on one axis), Align (put a line onto another line's axis), Extend (arcs carry
on along their circle), Split, Move/Rotate (gimbal, or Rotate About a tapped
centre), Scale, Pattern (linear with an arrow you drag, or circular around a
centre), Delete. Tools with options start with the option you used last.
Tapping empty space finishes Offset, Move, Scale, Pattern, Rotate and Mirror.
A copy made with the **Copy** switch (by the gimbal, or in Move/Rotate, Rotate
About and Scale) keeps the constraints that lie within it: joined corners,
level and upright lines, sizes. Change one of its sizes and the rest follows.
So does the blue tick: while a tool is on, the line at the bottom holds only that tool's own
buttons, Sketch view and the tick. The tick finishes what the tool has set up and puts it down,
and Draw, Modify, Transform, Delete and Exit are on the line again.

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
kind, and never catch a tap meant for the drawing. Show or hide their column
with the **Constraints** button at the right edge while sketching.

Any closed shape becomes a **region** (blue when selected) you can extrude,
revolve, sweep or loft. Overlapping shapes split into separate regions.
Tapping a region shows Extrude's arrow - drag it or the shape itself, or
type a height - with Sketch and Revolve on the buttons beside it. While the
arrow is still at 0, tapping more regions of the same sketch adds them;
**All shapes** takes every shape at once. Double-tap a shape to open its
sketch. A sketch stays in view until every region of it is used.

---

## Making and changing solids

- **Extrude** - pull a region or a face. **Operation** (Auto, New body, Add,
  Cut, Intersect): Auto goes by direction - on a plane + is a new body and -
  a cut, on a face out adds and in cuts. Several shapes of a sketch pulled up as a new body are a body
  each where they stand apart (shapes that touch are one). **Taper end %** sizes the far end (100 none, 0 a
  point: a spire, a pyramid or a cone in one step) - type it or drag the box
  left / right. Extrude starts at the last distance.
- **Revolve** - spin a region around an axis (a separate line, a side of a
  rectangle or outline, a round edge, or one of your axes by name);
  **Travel** moves it along the axis at the same time (threads, springs).
- **Sweep** - move a region along a path (one tap takes the whole joined run
  of lines and arcs; tap a piece again to drop it). **Loft** - blend between
  profiles.
- **Shell** - hollow a body; tapped faces become openings (Clear empties the
  list).
- **Starting sizes** - a tool starts at a size taken from what it is used on, so the change shows on a
  small part and on one a metre across: a fillet or chamfer at a tenth of the shortest edge picked, a
  shell at a twentieth of the body, an offset plane at a quarter of its face. If that size cannot be
  built, the tool steps down to one that can. Type or drag to change it.
- **Fillet / Chamfer** - tap edges, drag the dot (outward rounds, inward
  bevels) or type a size in the box on the model; variables work too. A
  fillet that can't be made leaves the edge sharp with a note in History.
- **Direct touch** - what is picked is dragged by itself: a face pushed or
  pulled, a sketch's shape pulled up into a solid, an edge rounded, a body
  slid over the floor. On a touch screen press and hold a face, shape or edge
  and pull, in one touch. Lifted without pulling, the press brings the list of
  what can be done with it, as a right-click does.
- **Faces** - drag the arrow to push/pull a face: its neighbours follow,
  curved ones included; fillets next to it are kept. **Move/Rotate Face**
  (a gimbal on the face) moves it every way and turns it about its normal. A
  picked face lists only what works on the face; body tools (patterns,
  mirror, translate, move body) come with a picked body. Scale, Replace (onto
  another face's plane) or **Delete** a face, fillet or chamfer: the
  neighbours carry on along their own surfaces until they meet, as if it was
  never there.
- **Edges and corners** - a straight edge picked shows its Move/Rotate
  gimbal; the faces around it tilt to follow (Fillet / Chamfer are in the
  list). Every edit is checked: one that would tear the body open stops with a
  message instead.
- **Transform** - Move/Rotate (gimbal, with a Copy switch: after a drag the
  panel stays for exact values; copies are independent bodies, **Link** keeps a
  freeform copy following its original), Scale (its three ways are on its line: Uniform,
  X / Y / Z for each direction by itself, By reference for two points and the distance they should be), Translate (from a point to a point; the origin, 0, 0, 0, can be tapped too), Mirror,
  Rotate Around Axis (a round edge gives an axis through its centre),
  Patterns. A body of a pattern picked: **Whole Pattern** selects the rest.
- **Union / Subtract / Intersect** - combine bodies (they need to touch to
  unite), cut one from another, or keep the overlap. Subtract and Intersect
  open a tool: tap the body to change (marked **+**), then the bodies to cut
  with (marked **−**); **Keep modified body** / **Keep subtracted bodies**
  leave copies. Two overlapping bodies picked: all three are in the list.
  Many tools at once are one checked cut.
- **Split Body** - by a plane (yours, by name) or a face.
- **Hole** - tap a flat face where a screw goes, then Hole: choose the screw
  (M2 to M12) and the head (none, a counterbore for a cap screw, a countersink)
  and the hole has the right sizes, right through or to a depth. Each size can
  be typed over (a printer that makes holes tight wants a few tenths more).
  Drag its dot to move it: it catches on the middle of the face and on the
  centre of a round edge (a boss) and stays there; anywhere else, type its two
  distances from the nearest edges, which it keeps when the part is resized.
  It also catches on the point where an axis passes through the face, and on a
  sketch drawn on the face: the end of a line, where lines meet or cross, the
  centre of a circle. Lay the holes out as a sketch, then tap each one.
  It is one step in History, opened again like any other.
- **Thread** - tap a round face or a hole's rim: a shank at the nominal size
  gets an outside thread, a hole at the tap-drill size an inside one. The
  pitch starts at the ISO coarse pitch (the line says what it makes, e.g.
  M10 × 1.5); left-hand as an option; free ends get a 45° lead-in.
- **Repair Body** - fixes an imported or broken body (gaps, bad faces,
  slivers, inside-out) without changing its shape or size.
- **Fill to Plane** - an open freeform surface becomes a solid by filling
  the gap down (or up, or across) to a plane.
- **Freeform** - organic shapes: start from a box, sphere, cylinder or plane
  (its size and rows on the line) and pull its cage points, edges and faces.
  Tap picks the closest point, edge or face (tap a face again for the one
  behind it); press on empty space and drag a box to pick the points inside
  (on a touch screen: switch on **Pick in a box** on the line, and a finger
  draws the box - the points behind are picked too, a whole slice from a side view).
  Move / Turn / Scale take exact X, Y, Z values on the line. Cage tools:
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
- **Colour** - six soft colours or **Custom…** for any colour; and
  **Fade**, how see-through a body is.
- **Section View** - cut the view (not the part) to look inside; the cut
  shows as a solid face with a thick outline. **Place Plane** on the line
  puts a construction plane where the cut is (to sketch on or split with).
- **Measure** - distances and angles; pin a measurement to keep it.
- **BIM** (under More) - **Materials**: a real material for each body, which
  gives it its mass. **Technical Sheet**: the parts list with masses and the
  materials' data. **Drawings**: sheets with views, dimensions, item numbers
  and a title block.
- **Assemblies** (More → BIM, still being tried out) - how the parts move.
  The parts stay where you modelled them; a **joint** only says how two of
  them move against each other. **Add joint**, tap a face on each part, and
  the kind is read off the faces: two round faces on one axis, or two flat
  faces one above the other, make a **Hinge** (a **Screw** of the thread's
  pitch when one part is threaded - a thread's own faces can be tapped too);
  two flat faces side by side, a **Slide**;
  anything else, **Fixed**. Drag a part to move it by its joint, or type its
  angle or distance; **Limits** keep it between two values; **Follows** makes
  one joint go with another by a ratio (gears); **Explode** pulls the parts
  apart. The pose is kept with the project and shown after OK; **Home** puts
  every part back where it was modelled. **Stop on contact** keeps a dragged
  part from running into another. No weight or forces.

---

## Exact sizes, variables and the numpad

- Every drag shows a **value box** by the pointer that stays when you let go:
  tap it to type. While dragging or drawing, **just type a number** - it goes
  into that box. Enter confirms. **Press on any value box and drag left or
  right** to turn the value down or up like a wheel. Units come from **Units & grid** (mm, cm, m, in, ft);
  you can also type units (`2in`, `5cm`) and maths (`40/3 + 2`).
- **Variables** are named sizes like `wall = 3`. The Variables button (under
  Measure) switches them on: a tag shows where each one acts on the model -
  ↔ a length, ∠ an angle, # a number - and follows it as the model moves.
  Tap a tag to type its value or a formula, or drag the value: the model
  follows as you go, and lines show what it's made from and what uses it.
  The line has New Variable and the whole list; tap Variables again to switch off.
  Type them into any field (`wall * 2`) or pick them from the **ƒx** menu
  next to a value. Change the variable later and everything using it updates.
  A size that follows a variable says so on the line (`od / 2 = 60 mm`).
  Formulas take `+ - * / ^`, brackets, units (`2 in + 5 mm`) and `sqrt`,
  `abs`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `floor`, `ceil`,
  `round`, `min`, `max` - `floor(length / pitch)` is how many fit. Changing
  the project's unit changes no size: plain numbers in formulas are given
  the unit they were typed in.
- The **on-screen numpad** (Settings at the right edge, Number pad on
  screen) replaces the system keyboard for value boxes. It's on by default,
  on a computer too: there it opens beside the box, and the keyboard types
  into the box as ever. Tapping a box selects its value, so typing
  replaces it; nothing is applied until you press ↵. After the second tap of
  a line, its length box opens right away. Drag the numpad by its grip where
  you want it; double-tap the grip to put it back by the box.
  Its **ƒx** key adds + × / and a key per variable (tap one to type its
  name), and **+ New** makes a variable from the value in the box.

---

## History: change anything later

The **History** panel lists every step. Tap a step to edit it (its tool opens
with the old values). The eye switches a step off; the bin deletes it. Hover
a step to see what it works on, outlined in dashed orange. A sketch's own
steps fold out from the ▸ next to it. Select several steps (Ctrl/Shift+click)
to **group** them: fold, rename, switch all off or on, ungroup. Tick steps in
a group and **Ungroup** (beside Group) takes just them out, in their own place
in the timeline - a group they were in the middle of splits around them. If a step
can't be rebuilt after a change, it's marked and the reason is shown.

**Play** (the triangle beside the panel's title) builds the model again before
your eyes, one step at a time: each step's name is shown, and the view goes
round to where the change can be seen. It ends with one slow turn round the
finished model. The
button is *Pause* while it plays; paused, it is *Reset*, which brings the model
back as it is (Esc does too). Nothing in the project is changed by it.

**Record** (the dot beside Play, or **File → Export MP4 timelapse**) plays it
from the first step and saves it as a video: the model and each step's name,
without the panels or the grid, the app's name in the corner, 1280 × 720 (upright on a phone held upright). The time a
step takes to build is left out. The file is an MP4; a browser that can't
record MP4 saves a WebM instead. Keep the app on screen while it records.
Pause then Reset stops it and saves nothing. The dot takes two taps, like the
bins: the first turns it red and the guide text says to tap again, the second
starts the recording; a tap anywhere else calls it off. While it plays or
records, the guide text says what the buttons do.

---

## Saving, opening, exporting, printing

- Your project **saves itself** in this browser as you work, and every project
  you've worked on is **kept on this device**.
- **File → Open** shows them as a gallery of pictures, newest first (it also
  greets you each time the app opens): tap one to carry on with it, start a
  **New project**, or **Open file…** for any `.super` file (it joins the
  gallery); with many, the row scrolls side to side. Each card can be saved
  as a file or deleted. They live in the
  browser's storage for this site: **More → Update** keeps them, but
  clearing the site's data in the browser's settings deletes them.
- **File → Save project** downloads a `.super` file (keep it as a backup or
  move it to another device).
- **On Android**, Save project and the exports open the device's own *Save to* window where the
  browser has it (Chrome): Google Drive and the device's other places are in it. Where it has none, the
  file is downloaded as before.
- **File → Import file…** brings a STEP, STL, OBJ, 3MF, glTF, FreeCAD, BRep, IFC, DXF or SVG file into the project that is
  open (the same as More → Insert → File).
- **File → Export STL** or **Export 3MF** for 3D printing (3MF keeps body
  names and colours), **Export STEP** for other CAD programs. With bodies
  selected (or isolated), only those are exported. On phones and tablets the
  **share mark** next to each export (and Save) sends the file straight to
  another app - mail, messages, a slicer…
- **File → Export DXF (sketch)** saves a sketch's curves as a 2D drawing for
  laser cutters, CNC and drawing programs: open **Items**, tap the sketch, then
  File → Export DXF. Construction lines go on their own layer.
- **File → Export MP4 timelapse** plays History from the first step to the last
  and saves it as a video (see [History](#history-change-anything-later)).
- **File → New project** starts an empty one; the open project stays in the
  gallery.
- **More → Insert** brings in files (STEP, STL, OBJ, 3MF, glTF, FreeCAD, BRep, IFC, DXF, SVG), another
  project's parts (**Project**), and pictures to trace over (**Image on
  plane**: on the floor, front or side, its middle at the X / Y you type).
- An inserted **project** is kept together: its steps are one group in History
  and its bodies, sketches and planes one folder in Items, both named after the
  file. Its own folders are inside that folder, and its names, colours, hidden
  sketches and variables come along (a variable this project already has keeps
  this project's value). One Undo takes it all out again.
- A **FreeCAD** document (`.FCStd`) brings in the bodies on show in it as the
  exact solids FreeCAD last built, each a body by its name - without their
  history (save it from FreeCAD with *Save shapes in binary format* off, which
  is how it comes). A **BRep** file (`.brep`, `.brp`) is one such shape.
- **glTF** (`.glb`, or a `.gltf` with its data inside it) and **IFC** (a
  building model) come in as a mesh, in millimetres with Z up: an IFC's walls,
  slabs, doors and the rest together, its rooms' volumes left out. The reader
  for IFC is fetched the first time an IFC file is picked.
- A mesh (**STL**, OBJ, glTF, IFC, the meshes in a 3MF) comes in as a solid with real
  faces, so it can be worked on: every flat side is one face, whichever way
  it leans, and the round parts are truly round - a hole, a boss, a pin, a
  rounded upright corner each become one round face, at its exact size. Then
  Hole, Thread, Fillet, push/pull, Measure and joints work on it as on a part
  drawn here. Left as they came: cones (a countersink), balls, rounded rims,
  rounds of fewer than 12 sides, and sculpted or scanned shapes. A mesh put in
  before this has **Make Faces** on its body.
- A **.super** file is the whole project: every step and sketch, variables,
  saved views, names, colours, and the BIM side - materials, drawings, joints
  and the assembly's pose.

---

## Tips for phones, tablets and headsets

- **Deleting takes two taps** in Items, History and the project gallery: the
  first turns the bin red, the second deletes. It goes back by itself after 3
  seconds, or at a tap anywhere else. Delete in the tools and in a tool's
  window takes one tap (Undo brings it back).
- With a pen, fingers are ignored while the pen touches the screen.
- iPad / Android: **More → Fullscreen** gives the whole screen. On phones and
  tablets the app offers to be **installed on the home screen** (or More →
  Install app); on iPhone/iPad it's *Share → Add to Home Screen*.
- The window the app opens with has a **Full screen** button. On an iPhone,
  Apple lets only videos go full screen, not web pages: in Safari the button
  says so and how to add the app to the Home Screen, and opened from the Home
  Screen it is not offered. Since iOS 26.1 an iPhone does not give a web app on
  its Home Screen the whole screen either (a fault in iOS that Apple has
  open): the app says so once and uses the room it gets.
- Fit frames the model in the part of the screen the bars leave
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
  take a moment. **Stop** next to it ends the work before its next step and
  takes back the change that started it (like an undo). On a project just
  opened there is no change to take back: the steps not reached yet are rolled
  back in **History**, to build again when you remove the breakpoint.
- **A change you expected isn't there yet**: when a newer version is out,
  **More** pulses and its **Update** item says NEW. **More → Update** loads the newest
  version right away (your project is kept).

---

## For AI assistants

This section describes the app so an assistant can explain it, guide a user
step by step, or read and write project files.

**Assistants: start at https://supergeometry.app/llms.txt** (`public/llms.txt` here), a short page written for
you: how to build a model in the person's open tab with the page's `sg` handle, one call per change
(`sg.make`, `sg.add`, `sg.change`; see `src/assist.ts`). The full reference, with the project file format and
complete examples, is https://supergeometry.app/llms-full.txt; everything both pages say is tested against the
app on every change (`tests/llms.test.ts`).

**Learning the app with an assistant:** ask it to teach you. Its course (`public/llms-teach.txt`) builds
one thing from start to finish, a desk lamp, in nine lessons: a base, a pole drawn on it, a flared hollow
shade, a freeform bulb, three feet as a pattern of holes, the head tilted, then the tilt, the wall and the
number of feet made variables, and out to the printer. You do the tapping, it says what to tap and why,
and checks what you did (`sg.now()`) before going on. Three more lessons cover what the lamp does not
need: exact sizes and constraints, Revolve, two parts that fit. The lamp as the lessons build it is
tested on every change (`tests/courselamp.test.ts`).

**People:** on a computer, the **Claude** button at the bottom right shows how to model by asking. It needs
Claude's extension for Chrome: open it beside the app, say what you want, and Claude builds the model in your
tab. The app sends nothing anywhere; the extension works in your own browser.

**What it is.** A browser-based parametric solid modeler. Geometry is
OpenCascade (via replicad) running in a Web Worker; the UI is plain DOM over a
three.js view. Units are millimetres internally; the display unit is a setting.

**Interaction model.**
- Nothing selected → the line at the bottom has every tool (one that needs a pick asks for it as it starts): Sketch, Freeform,
  Extrude, Revolve, Sweep, Loft, Shell, Transform ▸ (Move/Rotate, Scale,
  Translate, Mirror, Rotate Around Axis, Patterns), Boolean ▸ (Union,
  Subtract, Intersect), Construct ▸ (planes, axes), Insert ▸ (variables,
  images, files), Tools ▸ (Offset Face, Offset Edge, Split Body, Fill to Plane, Thread,
  Repair Body…).
- Something selected → each group lists the tools valid for it first, then
  its other tools (those ask for their own pick). The pick is dragged by
  itself or by its handle: faces an arrow (offset), edges a dot (fillet,
  inward a chamfer), bodies a gimbal (move/rotate, with Copy; its middle dot
  moves the pivot). A sketch region gets Extrude's arrow plus Revolve /
  Sweep / Loft.
- Every operation is a *feature* in History; editing a feature replays
  everything after it.
- Values: type while dragging, or tap a number on the line at the bottom (the tool's options); expressions and
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
- Beside `features`, the project holds `joints` (`type`: `fixed`, `hinge`,
  `slide`, `screw`; the two bodies `a` and `b`; the joint's line `origin`,
  `axis`; `min`, `max`; a screw's `pitch`; `drive {joint, ratio}`), `ground`
  (the body that stands still) and `pose {values, exploded}` (each joint's
  value by its id: degrees, or mm for a slide). They move what is shown, not
  the model.
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
`replicad-opencascadejs`) is LGPL-2.1; replicad and three.js are MIT; web-ifc
(the IFC reader) is MPL-2.0.
