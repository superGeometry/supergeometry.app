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
    intro: "Drag with one finger or the left mouse button to turn the view, two fingers or the right button to move it, pinch or scroll to zoom. On touch screens, press and hold a tool to see its name — let go on it to use it, slide off to cancel.",
    items: [
      { icon: "fit", name: "Fit", text: "Zooms so everything fits on screen (F)." },
      { icon: "views", name: "View cube", text: "Tap a face of the cube for a straight-on view; ⟲ ⟳ at its top corners turn the view by 90°." },
      { icon: "pivot", name: "Orbit centre", text: "The cube's bottom-left button: tap it, then tap a point — the view turns around that point. Fit resets it." },
      { icon: "views", name: "Views & appearance", text: "The cube's bottom-right button opens (and closes) standard and saved views and the look of the view." },
    ],
  },
  {
    title: "Top bar",
    items: [
      { icon: "file", name: "File", text: "New, open and save projects (.super); export STL or 3MF for 3D printing, STEP for other CAD programs, DXF of a sketch (tap it in Items first) for laser cutters and CNC." },
      { icon: "body", name: "Items", text: "Every body, sketch, plane and image, with an eye to hide or show it. Group things into folders." },
      { icon: "more", name: "More", text: "Fullscreen, Reset cache & update (loads the newest version), this Help, About, and support links." },
    ],
  },
  {
    title: "Making shapes (left column, nothing selected)",
    intro: "Most work starts with a sketch on a plane or a flat face, then Extrude or Revolve turns it into a solid body.",
    items: [
      { icon: "sketch", name: "Sketch", text: "Pick a plane (XY, XZ, YZ) or a flat face, then draw lines, arcs, circles, rectangles… Closed shapes become profiles you can extrude." },
      { icon: "freeform", name: "Freeform", text: "Smooth organic shapes: start from a box, sphere, cylinder or plane and pull its control points, edges and faces." },
      { icon: "extrude", name: "Extrude", text: "Pull a profile or a face straight out into a solid. Drag the arrow or type a distance; negative values cut. Running into another body cuts through it." },
      { icon: "revolve", name: "Revolve", text: "Turn a profile around an axis (vases, wheels). Travel moves it along the axis while turning — with more than 360° that makes threads and springs." },
      { icon: "sweep", name: "Sweep", text: "Move a profile along a path curve (pipes, handles)." },
      { icon: "loft", name: "Loft", text: "Blend between two or more profiles, e.g. a square into a circle." },
      { icon: "shell", name: "Shell", text: "Hollow a body out, leaving walls of the thickness you choose; picked faces become openings." },
      { icon: "transform", name: "Transform", text: "Move/Rotate, Scale, Translate (from a point to a point), Mirror, Rotate Around Axis and Patterns (copies in a row or around a centre)." },
      { icon: "union", name: "Union / Subtract / Intersect", text: "Combine bodies, cut one from another, or keep only where they overlap. Union needs the bodies to touch." },
      { icon: "construct", name: "Construct", text: "Helper planes (offset, midplane) and axes to sketch or mirror on." },
      { icon: "insert", name: "Insert", text: "Variables (named sizes used in any field), images to trace over, STEP/STL/SVG/DXF files." },
    ],
  },
  {
    title: "With something selected",
    intro: "Tap a face, edge, corner or body: the left column shows only what can be done with it.",
    items: [
      { icon: "offsetFace", name: "Face", text: "Drag the arrow to push/pull it (its neighbours follow), Move/Rotate it, Scale it, Replace it with another face's plane, sketch on it, or delete it." },
      { icon: "fillet", name: "Edge", text: "Drag the dot outward for a rounded Fillet, inward for a Chamfer; or move the edge (the faces tilt)." },
      { icon: "move", name: "Body", text: "The gimbal moves (arrows), slides (squares) and turns (rings) it. The Copy switch makes copies as you drag." },
      { icon: "color", name: "Colour", text: "Pick a colour for the selected bodies." },
    ],
  },
  {
    title: "In a sketch",
    items: [
      { icon: "line", name: "Line, Arc, Spline, Rectangle, Circle…", text: "Tap points to draw. Type a value while drawing (or use the numpad) to set an exact size." },
      { icon: "project", name: "Project", text: "Copy body edges or curves of other sketches into this sketch." },
      { icon: "offset", name: "Offset Edge", text: "A parallel copy of a curve (or a whole outline) at a distance. Tap empty space to finish." },
      { icon: "sketchFillet", name: "Fillet", text: "Round a corner where two lines meet." },
      { icon: "trim", name: "Trim / Join", text: "Cut away the piece of a curve between crossings — or join two lines on the same axis." },
      { icon: "alignLine", name: "Align", text: "Move a line onto another line's axis; lines joined to it stretch along." },
      { icon: "extend", name: "Extend", text: "Carry a line or arc on until it meets another curve." },
      { icon: "constraints", name: "Constraints", text: "Rules that keep the drawing in shape: horizontal, parallel, equal, a fixed distance… A new rule replaces one it contradicts." },
      { icon: "lineDashed", name: "Construction", text: "Helper lines that guide the drawing but don't make faces. Tap to switch the selection or new lines." },
    ],
  },
  {
    title: "Right column",
    items: [
      { icon: "magnet", name: "Snapping", text: "What the pointer snaps to: grid, end and middle points, guide lines." },
      { icon: "ruler", name: "Units & grid", text: "mm, cm, m, inch, foot; grid size; degree format." },
      { icon: "numpad", name: "Numpad", text: "Tap to switch the on-screen numpad on or off: value boxes then open it instead of the keyboard. Typing replaces the value; ↵ applies it." },
      { icon: "display", name: "Display", text: "Shaded, wireframe or X-ray; edges and hidden edges." },
      { icon: "camera", name: "Screenshot", text: "Save a picture of the view." },
      { icon: "history", name: "History", text: "Every step in order. Tap one to change it, hover to see what it works on, the eye switches it off, the bin deletes it." },
    ],
  },
  {
    title: "Bottom left",
    items: [
      { icon: "undo", name: "Undo / Redo", text: "Step back and forward (Ctrl Z / Ctrl Y)." },
      { icon: "section", name: "Section View", text: "Cut the view open to see inside; tap again to hide it (it's remembered)." },
      { icon: "measure", name: "Measure", text: "Distances, angles and sizes between anything you tap; pin them to keep them on screen." },
      { icon: "isolate", name: "Isolate", text: "Show only the selected bodies; tap again to show everything." },
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
        txt.append(el("b", "", it.name), el("span", "", ` — ${it.text}`));
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
