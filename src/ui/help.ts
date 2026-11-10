// Help: a panel (More → Help, or "?") explaining every button, grouped the way
// they appear on screen. Toggle it on and off; it scrolls and fits any screen.

import { icons, type IconName } from "./icons";
import { el } from "./ui";

interface Entry {
  icon: IconName;
  name: string;
  text: string;
}

const SECTIONS: { title: string; intro?: string; items: Entry[] }[] = [
  {
    title: "Getting around",
    intro: "Drag with one finger or the left mouse button to turn the view, two fingers or the right button to move it, pinch or scroll to zoom. On touch screens, press and hold a tool to see its name - let go on it to use it, slide off to cancel. Esc steps back: first what's half done or picked, then the tool, then out of the sketch. Right-click (on touch screens and headsets: press and hold still) opens a menu by the pointer: a tool's Done and Cancel, what can be done with what's picked, and the view's switches.",
    items: [
      { icon: "fit", name: "Fit", text: "Zooms so everything fits on screen (F)." },
      { icon: "views", name: "View cube", text: "Tap a face of the cube for a straight-on view; ⟲ ⟳ at its top corners turn the view by 90°." },
      { icon: "pivot", name: "Orbit centre", text: "The cube's bottom-left button: tap it, then tap a point - the view turns around that point. Fit resets it." },
      { icon: "views", name: "Views & appearance", text: "The cube's bottom-right button opens (and closes) standard and saved views and the look of the view." },
    ],
  },
  {
    title: "Top bar",
    items: [
      { icon: "file", name: "File", text: "New, open and save projects (.super). Every project you work on is kept on this device: Open shows them as pictures - tap one to carry on, or Open file… for any .super file (each copy can be saved as a file or deleted there). New keeps the open one. Clearing the site's data in the browser deletes them, so save the ones that matter as files too. Export STL or 3MF for 3D printing, STEP for other CAD programs, DXF of a sketch (tap it in Items first) for laser cutters and CNC. The share mark next to each sends the file straight to another app (phones and tablets)." },
      { icon: "body", name: "Items", text: "Every body, sketch, plane and image, with an eye to hide or show it. Each kind (Bodies, Sketches, Planes & axes, Images) folds away under its heading; a plane's icon shows how it was made. Group things into folders (Select, tick them, New folder); tick items all in one folder for New subfolder inside it. Remove takes ticked items out of their folder (one level up); Move, then tick a folder or subfolder, puts them in it. A tool waiting for a body takes one tapped here. What is selected in the view (a body double-clicked, a plane) lights up in the list." },
      { icon: "more", name: "More", text: "Fullscreen (also in the window the app opens with), Update (loads the newest version - when one is out, More pulses and this item shows a pulsing NEW), this Help, Feedback (a bug report, suggestion or discussion, posted on r/supergeometry), About, and support links." },
    ],
  },
  {
    title: "Making shapes (left column, nothing selected)",
    intro: "Most work starts with a sketch on a plane or a flat face, then Extrude or Revolve turns it into a solid body.",
    items: [
      { icon: "sketch", name: "Sketch", text: "Pick a plane (tap it, or the XY floor / XZ front / YZ side buttons), one of your construction planes by name, or a flat face, then draw lines, arcs, circles, rectangles… In a straight-on view (Front, Top…) Sketch goes on the face you're looking at. Closed shapes become profiles you can extrude." },
      { icon: "freeform", name: "Freeform", text: "Smooth organic shapes: start from a box, sphere, cylinder or plane (its size in the card) and pull its control points, edges and faces. Drag a box on empty space to pick the points inside. Cage tools: Extrude faces (Length, Bend, Taper, Steps - a spout in one go), Bridge two faces (a tube, or an arched handle), Inset, Add edge loop, Add detail. Symmetry mirrors every move across X / Y / Z, a tapped edge, or midway between two facing faces picked first; the plane is kept with the shape. A hole: tap its edge → Fill hole, or Thickness… for a solid wall. Points on an open border → Extend surface adds faces beyond them. Connect: pick border edges on one or two surfaces (Shift adds) - two edges get a face between them, two hole rims a tube." },
      { icon: "extrude", name: "Extrude", text: "Pull a profile or a face straight out into a solid. Drag the arrow or type a distance; negative values cut. Running into another body cuts through it. Taper end % sizes the far end: 100 none, 50 half, 0 to a point (a spire, a cone) - type it, or press on the box and drag left / right. All shapes takes every shape of the sketch at once. A tapped shape shows Extrude's arrow, with Revolve, Sweep and Loft beside it in the column." },
      { icon: "revolve", name: "Revolve", text: "Turn a profile around an axis (vases, wheels). Travel moves it along the axis while turning - with more than 360° that makes threads and springs." },
      { icon: "sweep", name: "Sweep", text: "Move a profile along a path curve (pipes, handles)." },
      { icon: "loft", name: "Loft", text: "Blend between two or more profiles, e.g. a square into a circle." },
      { icon: "shell", name: "Shell", text: "Hollow a body out, leaving walls of the thickness you choose; picked faces become openings." },
      { icon: "transform", name: "Transform", text: "Move/Rotate, Scale (all ways at once, along X / Y / Z only, or by reference: tap two points and type what their distance should be - in sketches too), Translate (from a point to a point - a corner, edge, face, sketch point, or the origin 0, 0, 0 where the axes cross), Mirror, Rotate Around Axis and Patterns (copies in a row or around a centre)." },
      { icon: "union", name: "Union / Subtract / Intersect", text: "Combine bodies, cut one from another, or keep only where they overlap. Union needs the bodies to touch. Subtract / Intersect: tap the body to change (marked +), then the bodies to cut with (marked −); Keep modified body / Keep subtracted bodies leave copies. Two overlapping bodies picked: all three are in the list." },
      { icon: "tools", name: "Tools", text: "Split Body (by a plane or face), Fill to Plane (an open freeform surface filled down to a plane becomes a solid), Thread (tap a round face or a hole's rim: ISO pitch, outside or inside, left-hand as an option), Repair Body (fixes an imported or broken body without changing its shape), Offset Face, Offset Edge (tap a straight edge, then a flat face: a line on that face parallel to the edge at the distance you type, running right across the face from edge to edge - it splits the face into shapes to extrude or cut; with a face selected it's Offset from Edge: tap the edge next)." },
      { icon: "construct", name: "Construct", text: "Helper planes - offset, midplane, through 3 points, on a curve, perpendicular to an edge, through an edge at an angle, parallel to a face - each with its own mark at a corner. Tap a plane you made: its gimbal moves it (the blue arrow changes its offset) or turns it; with Copy on beside it a drag makes a new plane, selected after so the next drag copies again; and axes (from a face or edge, or along X / Y / Z through a point you type)." },
      { icon: "insert", name: "Insert", text: "Images to trace over (on the floor, front or side, at the X / Y you type), STEP/STL/SVG/DXF files." },
    ],
  },
  {
    title: "With something selected",
    intro: "Tap a face, edge, corner or body: the left column shows only what can be done with it, in groups apart with a dim line. On touch screens every tap adds to the selection (tap again to drop it). The most likely tool is ready at once: a shape extrudes, a face offsets, an edge rounds, a body moves - drag its handle, or just type the value. Right-click (or press and hold) shows the same list by the pointer.",
    items: [
      { icon: "offsetFace", name: "Face", text: "Drag the arrow to push/pull it (its neighbours follow), Move/Rotate it (every way, and turned about its normal), Scale it, Replace it with another face's plane, sketch on it, or delete it (the neighbours close up as if it was never there - fillets too)." },
      { icon: "moveEdge", name: "Edge", text: "Fillet is ready: drag the dot outward to round, inward to bevel, or type the radius. Chamfer can use two distances (Flip sides swaps them). Move/Rotate Edge (M) tilts the faces round a straight edge." },
      { icon: "move", name: "Body", text: "The gimbal moves (arrows), slides (squares) and turns (rings) it. With Copy on, a drag makes a copy; the panel stays when you let go so you can type exact values. A copy is its own body; switch Link on to keep a freeform copy shaped like its original. A body of a pattern: Whole Pattern picks the rest." },
      { icon: "copy", name: "Sketch → Copy to Plane", text: "Tap a sketch region, then Copy to Plane: drag the blue arrow to a parallel plane (or red/green to slide it), or type the distance. Turn Copy off to move the sketch instead." },
      { icon: "color", name: "Colour / Transparency", text: "Pick a colour for the selected bodies (or Custom… for any colour), and how see-through they are (Solid, 75%, 50%, 25%)." },
    ],
  },
  {
    title: "Values and cards",
    items: [
      { icon: "numpad", name: "Value boxes", text: "Every drag shows a value box by the pointer that stays when you let go: tap it to type. Just type while dragging - it goes into that box. Press on a box and drag left or right to turn the value down or up like a wheel. The model follows each key as you type (one undo step for the whole value). On the numpad a minus stays when you type over a negative value; ⌫ first clears it all, sign too, to type it positive." },
      { icon: "menu", name: "Tool cards", text: "A tool's values, its own actions and Cancel / Done, apart with dim lines. Drag the card (or the numpad) by its grip where you want it - remembered per screen type; double-tap the card's grip to fold it down to its name, and again to open it." },
      { icon: "line", name: "Exact points on touch screens", text: "Right after the first tap of a line, rectangle, circle… the card has X / Y for that point; a line also takes Length and Angle, or Across and Up for a slope; an arc by centre takes the centre, Radius and the Start and End angles." },
    ],
  },
  {
    title: "In a sketch",
    items: [
      { icon: "line", name: "Line, Arc, Spline, Rectangle, Circle…", text: "Tap points to draw. Type a value while drawing (or use the numpad) to set an exact size. Arcs by 3 points or by centre; circles by centre, 2 or 3 points. Guides (on a curve, midpoints, extensions, parallel, perpendicular, crossings) are kept as constraints." },
      { icon: "spline", name: "Spline > Draw (freehand)", text: "Press and drag to draw, like a pencil (on touch: one finger draws, two move the view). When you let go the stroke is cleaned up into a few pieces: straight parts become lines, round parts arcs, the rest smooth curves through as few points as keep them within a couple of pixels of what you drew; sharp corners stay corners. End where you began to close it (a round loop becomes a circle), then extrude it like any shape. Starting or ending on a point joins it there." },
      { icon: "project", name: "Project", text: "Copy body edges or curves of other sketches into this sketch. Or the other way: tap lines of this sketch, then a plane or flat face parallel to it - they're copied onto it as a new sketch." },
      { icon: "offset", name: "Offset Edge", text: "A parallel copy of a curve (or a whole outline) at a distance. Tap empty space to finish." },
      { icon: "sketchFillet", name: "Fillet / Chamfer", text: "Round or bevel a corner where lines or arcs meet; tap the next corner to go on." },
      { icon: "trim", name: "Trim / Join", text: "Cut away the piece of a curve between crossings (tap, or swipe across several) - or join two lines on the same axis." },
      { icon: "mirror", name: "Mirror, Move/Rotate, Pattern", text: "Mirror the selected shapes across a line or an axis; Move/Rotate with its gimbal (turns about the selection's own centre); Rotate About turns the whole selection rigidly about a point you tap - an end, a midpoint or another shape's centre - so its own centre swings round that point (the dotted arc shows the path); Pattern in a row or round a centre." },
      { icon: "alignLine", name: "Align", text: "Move a line onto another line's axis; lines joined to it stretch along." },
      { icon: "extend", name: "Extend", text: "Carry a line or arc on until it meets another curve." },
      { icon: "constraints", name: "Constraints", text: "Rules that keep the drawing in shape: horizontal, parallel, equal, a fixed distance… Tap a line, shape or point (or several): its card shows just the constraints that fit, one tap each; one already on is lit - tap it again to take it off. They show as small faint marks, a colour per kind; tap a mark to change or delete it. A new rule replaces the ones in its way (an old angle or parallel), and says which; locked points stay put. Dragging a point onto another joins them, and dragging a corner of a rectangle or polygon moves just that corner." },
      { icon: "lineDashed", name: "Construction", text: "Helper lines that guide the drawing but don't make faces. Tap to switch the selection or new lines." },
    ],
  },
  {
    title: "Right column",
    items: [
      { icon: "magnet", name: "Snapping", text: "What the pointer snaps to: grid, end and middle points, guide lines." },
      { icon: "ruler", name: "Units & grid", text: "mm, cm, m, inch, foot; grid size; degree format." },
      { icon: "numpad", name: "Numpad", text: "Tap to switch the on-screen numpad on or off: value boxes then open it instead of the keyboard. Typing replaces the value; ↵ applies it. ƒx adds + × / and your variables (tap one to type its name), and + New makes a variable from the value." },
      { icon: "display", name: "Display", text: "Shaded, wireframe or X-ray; edges and hidden edges." },
      { icon: "camera", name: "Screenshot", text: "Save a picture of the view, marked faintly at the bottom right with the project's name, the isolated bodies (when isolating) and supergeometry.app." },
      { icon: "history", name: "History", text: "Every step in order. Tap one to change it, hover to see what it works on, the eye switches it off, the bin deletes it (two taps, as in Items and the projects: the first turns it red). Select several (Ctrl/Shift+click) to group them: fold, rename, switch all off or on, ungroup. Ticked steps in a group: Ungroup (beside Group) takes just them out, in their own place in the timeline (a group they were in the middle of splits around them); a group's tick box ticks all its steps." },
    ],
  },
  {
    title: "Bottom left",
    items: [
      { icon: "undo", name: "Undo / Redo", text: "Step back and forward (Ctrl Z / Ctrl Y)." },
      { icon: "section", name: "Section View", text: "Cut the view open to see inside - the cut shows as a solid face with a thick outline; tap again to hide it (it's remembered). Place Plane in its card puts a construction plane where the cut is." },
      { icon: "measure", name: "Measure", text: "Distances, angles and sizes between anything you tap; pin them to keep them on screen." },
      { icon: "variable", name: "Variables", text: "Named sizes like wall = 3, to use in any field (wall * 2). Tap to switch on: a tag shows where each acts on the model (↔ length, ∠ angle, # number). Tap a tag to type its value or a formula, or drag the value - the model follows; lines show what it's made from and what uses it. Tap again to switch off." },
      { icon: "isolate", name: "Isolate", text: "Show only the selected bodies (and sketches drawn on their faces - tap a shape on one to extrude, offset... it); tap again to show everything." },
    ],
  },
];

export class HelpPanel {
  private el = el("div", "help-panel");

  constructor() {
    this.el.hidden = true;
    const head = el("div", "help-head");
    head.append(el("h2", "", "How supergeometry.app works"));
    const close = el("button", "icon-btn help-close");
    close.innerHTML = icons.close;
    close.title = "Close help";
    close.addEventListener("click", () => this.toggle(false));
    head.append(close);
    const body = el("div", "help-body");
    for (const sec of SECTIONS) {
      body.append(el("h3", "", sec.title));
      if (sec.intro) body.append(el("p", "help-intro", sec.intro));
      const list = el("ul", "help-list");
      for (const it of sec.items) {
        const li = el("li", "");
        const ic = el("span", "help-icon");
        ic.innerHTML = icons[it.icon] ?? "";
        const txt = el("div", "");
        txt.append(el("b", "", it.name), el("span", "", ` - ${it.text}`));
        li.append(ic, txt);
        list.append(li);
      }
      body.append(list);
    }
    body.append(el("p", "help-intro", "More: the README on GitHub (More → About) walks through a first project step by step."));
    this.el.append(head, body);
    // Clicks inside don't reach the model.
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.append(this.el);
    window.addEventListener("keydown", (e) => e.key === "Escape" && !this.el.hidden && this.toggle(false));
  }

  toggle(open = this.el.hidden): void {
    this.el.hidden = !open;
  }
}
