// More → Version: what is new. A short list per update, newest first, written for whoever uses the app.
//
// EVERY PUSH adds to this list: a new entry at the top for a new day, or more lines in today's. Plain words, what
// it does for the person, where it is. No other programs' names.

import { icons } from "./icons";
import { el } from "./ui";

interface Update {
  /** The day it went out, YYYY-MM-DD. */
  date: string;
  /** New things. */
  added?: string[];
  /** Things put right. */
  fixed?: string[];
}

export const UPDATES: Update[] = [
  {
    date: "2026-11-28",
    added: [
      "STEP files keep colours: a body's colour is written into the STEP file with it, and a STEP file's own colours come in with its bodies. (A body with no colour was marked red in the file, and showed red in other programs: it is the app's grey now.)",
      "AR on an iPhone or iPad: More > Enter AR now works there too. The model opens in the device's own AR viewer, standing in your room at its true size. File > Export USDZ saves the same file, for AR and 3D viewers.",
      "Import file reads four more kinds. FreeCAD documents (.FCStd): the bodies on show come in as the exact solids FreeCAD last built, each by its name, without their history. BRep files (.brep, .brp): one such shape. glTF (.glb) and IFC building models: as a mesh, in millimetres. Nothing new to tap - pick the file in File > Import file as before.",
      "Sketch: pick a line that has no length set and its length shows in a box right beside it. Type the length there and press Enter; no trip down to the Length field. It becomes the line's dimension, shown on the sketch from then on.",
      "Sketch, Arc by 3 points: with an end placed on the end of a line, the bend that runs smoothly on from that line shows as a dashed yellow arc while the third point is being placed, and the pointer snaps to it (Tangent). The arc placed there stays tangent to the line; where one bend suits both lines, to both.",
      "A project inserted into another (More > Insert > Project) is kept together: its steps are one group in History and its bodies, sketches and planes one folder in Items, both named after the file. Its own folders are inside that folder, and its names, colours, hidden sketches and variables come along. One Undo takes it all out again.",
      "History has a Play button (the triangle beside its title): the model is built again before your eyes, one step at a time. Each step's name is shown, and the view goes round to where the change can be seen. It ends with one slow turn round the finished model. While it plays the button is Pause; paused, it is Reset, which brings the model back as it is. Nothing in the project is changed by it.",
      "The timelapse can be saved as a video: the dot beside Play in History (tap it twice: the first tap lights it, the second records), or File > Export MP4 timelapse. It plays from the first step and saves the model with each step's name, without the panels or the grid, the app's name in the corner, 1280 x 720 (upright on a phone held upright). The time a step takes to build is left out. A browser that can't record MP4 saves a WebM instead, with its length written in so players show how long it is and can jump about in it. Keep the app on screen while it records.",
    ],
    fixed: [
      "Sketch: a constraint put on picked curves changes those curves and leaves the rest where it is, whenever it can be met that way. A line and an arc made tangent no longer move the line at the arc's other end.",
      "Sketch: a corner's round (a fillet between two lines) given a new radius leaves the lines where they are. Each line stays on its own line and keeps its far end; only the ends at the round move along them. Before, both lines slid sideways a little, though nothing told them to.",
      "Sketch: changing a size moves only what it has to. In a sketch that nothing locks in place, giving a corner's round a new radius shifted the whole shape a little; now only the round and the two lines it joins change, and the rest stays exactly where it is.",
      "Sketch: a line joined to another line at one end, given a new length, grows or shrinks at its free end. The joined end stays where it is, and the other line is no longer dragged along.",
      "Wireframe is easy to read: the model's lines are light and drawn whole. They were dark on the dark background, and only faint dashes over them showed.",
      "A round or a chamfer that ends on a flat face no longer leaves curved lines across that face. The face was left in several flat pieces; it is one face again.",
      "With a mouse, a sketch started on a body's face keeps the plain arrow. The pointer could stay a hand, left over from the picked body, and it hid where the next point would go.",
    ],
  },
  {
    date: "2026-11-27",
    added: [
      "On Android, Save project and the exports open the device's own Save to window where the browser has it: pick Google Drive there (or any other place the device knows) and the file is on your computer without moving it by hand. Close the window and nothing is saved. Where the browser has no such window, the file is downloaded as before.",
      "With a tool open, just type: the number goes into the tool's main value (Extrude's Distance, Fillet's Radius, a plane's Offset) with no click on its box first. Enter sets it, and Enter again finishes the tool.",
      "Extrude keeps the Operation you chose for a sketch: after New body (or Add, or Cut) is picked for one shape, the next shapes of that same sketch start with it. Other sketches start on Auto as before.",
      "AR on a phone or tablet has a camera button at the bottom: it takes a picture of the model as it stands in your room and hands it to the share sheet, or saves it. The browser asks once to use the camera for it. Where a browser does not give the camera picture, the button says so and a screenshot does the same.",
      "Several shapes of a sketch picked and pulled up together are a body each, where they stand apart: two circles give Body 1 and Body 2, not one body in two pieces to split by hand. Shapes that touch are still one body, and adding to a body or cutting is as before. Extrudes in projects you made earlier stay as they were.",
      "On a computer and a tablet the round buttons beside a pick are smaller and closer together, the size they have on a phone (52 by 40). Their names stay the same size, a long one narrowed to stay inside its button, and the icon is over the name as before.",
      "Learn the app with Claude by building something: its course now makes one desk lamp from start to finish, in nine lessons. A base, a pole drawn on it, a flared hollow shade, a bulb shaped with Freeform, three feet as a pattern of holes, the head tilted, then the tilt, the wall and the number of feet as variables, and out to the printer. Three more lessons hold what the lamp does not need: exact sizes and constraints, Revolve, two parts that fit.",
      "File has Import file…, between Save project and the exports: it brings a STEP, STL, OBJ, 3MF, DXF or SVG file into the project that is open, as More > Insert > File does.",
      "Tools start at a size that fits what you use them on, so the change shows at once. A fillet or a chamfer starts at a tenth of the shortest edge picked (2 on a 20 mm edge, 100 on a metre), a shell at a twentieth of the body, an offset plane at a quarter of the face it starts from, and sketch text at a size that reads in the view until you type one. If a starting size does not fit, the tool steps down to one that does. Type or drag as before to change it.",
      "Offset Edge takes several edges: with Edge chosen, tap one edge and then any others (tap one again to let it go). They are offset together at one distance, and the ones that join keep their corners. Chain still takes the whole outline.",
      "Fill Pattern sizes are a share of the shape (Spacing %, Size %): 5 gives about twenty rows on a small shape and on a big one, so a big shape no longer fills with thousands of lines. One tap inside a shape fills it, and a pattern or size changed after that follows at once. With a mouse, the shape under the pointer lights up before you click.",
      "Settings has a new switch, Quick buttons, at the end of its list beside the number pad's. Off, the round buttons beside what you pick are not shown (Extrude's Add and Cut beside a face go too), and you work from the bottom line alone. The Tutorial then leads you through the line.",
      "On a phone the round buttons beside a pick are smaller (a row of four took most of the screen's width, over the model). Their names are the same size as before, a long one only narrowed, and a button still takes a touch a little past its edge.",
      "The number pad on screen now comes switched on, on computers too: it opens beside a value you click, and the keyboard still types into the box. If you had it off, it is on again once; Settings > Number pad on screen switches it off.",
      "On a touch screen, tap the view with two fingers to undo and with three to redo. A word on the screen says which it did.",
      "On a touch screen, twist two fingers to roll the view about the point between them. Let go near level, or near a quarter turn, and it goes there. A rolled view now comes level smoothly as you turn it, not at a jump.",
      "On a touch screen, press and hold a face, an edge or a sketch's shape and lift without dragging: the list of what can be done with it opens by your finger, as a right-click gives. Hold and drag still pulls it.",
    ],
    fixed: [
      "Items: two or more bodies selected by clicking their names now get the New folder and Move buttons. Before, only ticked items did, and a selected row looks just like a ticked one, so the buttons seemed to come and go. Select starts with the selected items already ticked.",
      "Big projects with many curved faces rebuild faster again. Each cut and join is checked by measuring the body, and every face was measured afresh each time; a face a step leaves as it was is now measured once. A project that had slowed to 55 seconds is back to 35, and an edit late in a long project went from 0.9 to 0.2 seconds.",
      "A Smooth (G2) fillet in an inside corner stays inside the corner. It was built longer than the edge and stood out past both ends, with a block hanging under each end where a face stopped short (the flat top of a round boss against a wall). It now ends where the two faces end.",
      "Smooth (G2) fillets leave alone what stands beside the edge. An edge that ends at a wall, or the foot of a rib, was refused as too big for the faces: it is rounded now, up to the wall. A wall or a pin standing nearer to the edge than the radius is no longer cut into, and the fill round a boss near a plate's edge no longer hangs over that edge.",
      "A project file with a mesh in it far over what can be brought in opens with that step switched off, and says so; inserted into another project, that mesh is left out. Either way it no longer runs the page out of memory.",
      "Scale in the list of a picked body starts at once, the way you used last: its three ways are on the tool's own line, so the list no longer asks first.",
      "A plane typed further than 10 km from the origin is refused as a typo, as a body that far is. A step that could not be made now says so in plain words where it showed the kernel's own.",
      "A mesh with too many triangles (an STL, OBJ or 3MF over 250,000) is refused as it is picked, with its count, before it is put into the project. It used to be taken in first and could run the page out of memory; saved by then, it crashed the app again at every start.",
      "If the page does die while building a file you brought in, the next start opens the project with that step switched off and says so, instead of dying again. The step is still in History: delete it, or tap its eye to try once more. A project already stuck this way opens again too.",
      "Scale shows its three ways again: Uniform, X / Y / Z (each direction by itself) and By reference (two points, and the distance they should be). They are on the line the moment Scale is open, and it starts the way you used last. From the bottom line it had only opened by a factor, with nothing to say there were two more.",
      "The guide text is shorter: the longest ones (Move/Rotate, Fillet, Chamfer, Shell, Scale, Loft, Offset, the sketch tools and others, 35 in all) say what to do next in a line or two, without the asides.",
      "A hole's flat bottom starts a pattern of the hole, as its round wall does. A shallow recess has a wall too thin to tap, and a pattern started from its bottom made copies of the whole body.",
      "On a phone the warning line (a sketch whose constraints can't all be met, a body not closed) stands clear above undo and redo, and above the guide text when that is shown. Half of it was hidden under the buttons.",
      "Polygon: Triangle, Square, Pentagon and Octagon each have their own picture in the list. All five showed the hexagon.",
      "On a phone, a sketch shape with two or three ways to draw it (Rectangle, Circle, Arc, Spline) shows them side by side on the bottom line, with Draw after them, as on a wider screen. They were folded into one button that had to be tapped again to see them, with half the line empty. Spline names them Fit, Control and Freehand there.",
      "Offset Edge on part of an ellipse (a rounded edge seen at a slant, projected into a sketch) left the outline open: its offset stopped a little short of the offsets of the lines beside it, so the shape looked closed and could not be picked or extruded. The offset of an ellipse is now the curve that is the same distance from it all along, it meets its neighbours, and Chain takes an outline with such a piece in it whole. An offset made before stays as it was: delete it and offset again.",
      "In a sketch, a tool that is on has the bottom line to itself: its own buttons, Sketch view and the blue tick. Draw, Modify, Transform, Delete and Exit come back when the tick puts the tool down. A shape being drawn (Line, Rectangle, Circle, Arc, Spline, Polygon, Ellipse) keeps Draw, to switch to another shape.",
      "The blue tick finishes what the tool has set up and puts the tool down: a spline keeps the points placed, a line being drawn ends there, a pattern or an offset is applied, a text is set down. The cross beside it drops what is under way.",
      "Text: its X and Y are in its window only, no longer on the bottom line too.",
      "Polygon: Across flats is gone. Radius sets its size.",
      "Constraints list: the links a mirror, an offset or a pattern keeps between a copy and its original are no longer buttons named follow or pattern that one tap removed. They are in List all, by name.",
      "The bottom line no longer stays stretched after the Constraints list has been open.",
      "Opening another project while one is still being built: the new one is built right away. With a slow step under way it could stay unbuilt, the old model still on screen under the new project's name.",
      "Stop: a project whose slow step comes first can be stopped (it was built again from the start each time). Pressed while a project is opening, or after the page was loaded again, it rolls the steps not reached yet back in History and leaves your last change alone. What you do while it says Stopping… stays as you did it.",
      "Stop ends the rebuild only: an export or a drawing under way at that moment is not what stops.",
      "Learning with Claude: the size it reads for a round part is right (a cylinder was read as having no width one way, and a turned knob too). An ellipse it draws without saying how it is turned is taken as level.",
      "Help, the README and the lessons say what the bottom line shows now: the tick, Constraints as one button, Fill Pattern in percent.",
      "Sketch: a copy keeps its constraints. A shape copied with the Copy switch (dragged aside, or by Move/Rotate, Rotate About or Scale) came out with none, so its lines were not even joined at the corners. The copy now keeps what lies within it: joined corners, level and upright lines, parallel and equal ones, sizes and distances. Change one size on the copy and the rest of it follows. Locks, and ties to curves left behind, stay with the original.",
      "iPhone, the app opened from the Home Screen: Fullscreen is off the More menu and off the opening window. The app has the screen already there, and the button only said to add it to the Home Screen.",
      "iPhone on iOS 26.1 or later, the app opened from the Home Screen: the phone lays the page out shorter than the screen and leaves an empty strip along the bottom. That is a fault in iOS itself, still open with Apple. The app now works round it as far as a page can: its bottom line sits lower, and the 3D view goes on down through the strip where the phone shows it.",
      "More > Install app is off the menu where the app is installed already or the browser cannot install it. It was always shown.",
      "The opening window has its Tutorial button on a first visit only. After that the tutorial is under More > Tutorial.",
      "iPhone, in Safari: Fullscreen now says why it cannot (on an iPhone, Apple lets only videos go full screen, not web pages) and how to add the app to the Home Screen. It was a tip that went by in three seconds.",
      "iPhone on iOS 26.1 or later, the app opened from the Home Screen: it says once that the tools at the bottom cannot reach the bottom of the screen because of a fault in iOS, so it is not taken for a fault of the app.",
    ],
  },
  {
    date: "2026-11-26",
    added: [
      "More → GitHub opens the project's page: the code, the open issues and where to report one.",
      "Color and Fade beside a picked body: tap the body, then More in the round buttons next to it. The choices open in the same card, so you can try one colour after another. Teal is gone from the colours, so they fit in two rows; bodies already teal stay teal (shown as Custom).",
      "Transparency is now called Fade, and an image's Opacity too: one word for how see-through something is, 0% solid, 75% very faint. Your bodies and images look the same as before.",
      "Learn the app with Claude: ask it to teach you. It has a course of eight lessons, from a first block to holes, round parts, parts that fit and variables. You do the tapping; it tells you what to tap and why, and checks each step.",
    ],
    fixed: [
      "Right-clicking a face or a body on a computer opens only the app's list of tools, not the browser's own menu on top of it.",
      "Sketch constraints in one place: pick a line or a shape and Constraints on the bottom line opens two rows, the ones in use (tap one to take it off, or List all to see every size and join) and the ones you can add (Parallel, Tangent, Equal...). The hint says so too.",
      "Construction (dashed lines) is in the Draw list now, at its end, not only under More.",
      "Drawing on a phone: a shape's values are just its sizes - a line's Length and Angle, a rectangle's Width and Height, a circle's Diameter (the first point's X and Y are gone, and a line's Across and Up).",
      "On a phone, a sketch's bottom bar is even: every button the same width, in one or two rows right across it (they were two blocks, the names cut short).",
      "The round buttons beside a pick are all one size, and a long name (Perpendicular, Coincident) is made smaller to fit instead of running over the edge.",
      "Transform lists Move/Rotate, Translate and Rotate Around Axis itself, not under Move.",
      "On a phone, a shape's first tap (a centre rectangle's centre) shows its yellow dot right away, and every point placed so far stays marked.",
      "In a sketch, More is gone: it held only Normal to Sketch, now a button of its own at the end of the bar called Sketch view. Other plane is gone too: a new empty sketch on the wrong plane is left with Exit (it leaves nothing behind).",
      "Constraints beside picked curves: a Constraints button between Construction and Delete opens the ones that fit (Parallel, Tangent, Equal...).",
      "Tangent between a line and an arc that meet end to end now joins them too: moving a line no longer pulls the arc's end off the other line. And a line ending on the origin: an arc drawn from there is joined to the line, not just held to the origin.",
      "Stop now stops. It ends the work before the next step and keeps everything already built, instead of throwing it all away and building the whole project again. A change is taken back; while a project is opening, the steps it had not reached are rolled back in History, so you can look at the part and remove the breakpoint when you are ready.",
      "Deleting a face of a big body (hundreds of faces) is about four times faster and takes far less memory: a 128-step part with one now opens in about half the time.",
      "A big project no longer gets built over again in the background after every change, which could keep a slower computer or a Chromebook busy for minutes.",
    ],
  },
  {
    date: "2026-11-25",
    added: [
      "Hole catches on more: tap near the point where an axis passes through the face, or near a sketch drawn on the face (the end of a line, where lines meet or cross, the centre of a circle), and the hole sits exactly there.",
      "A mesh you can edit: an STL, OBJ or 3MF mesh now comes in with real faces where it can. Flat sides are one face each, and plain holes, bosses, pins and rounded upright corners are truly round, so Hole, Thread, Fillet and push/pull work on them. It helps simple parts most: chamfered holes, rounded edges and sculpted shapes come in as before. A mesh already in a project: tap its body, then Make Faces.",
      "A mesh file that holds several separate parts comes in as one body for each part.",
      "Dimensions in a sketch are drawn as dimensions: lines out from what is measured, a line with arrows and the size on it. Click a size and type a new one right there.",
      "Pick a line, click Length and press Enter: that length is now a dimension, without retyping it.",
      "Constraints show what they tie together: a mark on every line involved, and pointing at a mark (or tapping it) lights up everything it ties. Pick a line and the lines it is tied to show faintly.",
      "Extrude, Revolve and Sweep say when only one part of a cut-up shape is picked, and that tapping its other parts adds them.",
      "In a sketch, Constraints (n) on a picked line or shape opens the list of its constraints: delete one, type a new size, or delete them all.",
      "More → About: the app's name at the top opens the project's page on GitHub.",
      "Model with Claude, on a computer: open Claude's extension for Chrome beside the app and say what you want. It builds it in your tab, every step in History for you to change. The Claude button at the bottom right says where to get it.",
      "For any AI assistant: the app has a page written for assistants (supergeometry.app/llms.txt) that says how to build models here.",
      "Claude builds with far fewer steps, so a part costs much less of your Claude usage and appears sooner. Its changes go into your open project one at a time: Ctrl + Z steps back through them, and your project list is not filled with copies.",
    ],
    fixed: [
      "Every change to a body with very many faces is quicker.",
      "In a sketch, constraint marks and dimension boxes no longer sit on top of each other.",
      "A shell's rim can be rounded on both edges by half the wall (two 0.5 mm fillets on a 1 mm wall), for a fully round rim.",
      "Two edges in one line with different walls beside them, rounded together, come out as two clean rounds.",
      "In a sketch, a line that ends on a circle closes the shape it should: the area between them fills and can be extruded.",
      "Several touching areas of a sketch extruded together always come out whole. A ring could go missing from the body when one of its circles ran a hair from another line.",
    ],
  },
  {
    date: "2026-11-24",
    added: [
      "Hole (Create → Hole): tap a flat face where a screw goes and choose the screw, M2 to M12, and its head: none, counterbore or countersink. The hole gets the right sizes, and each can be typed over. Drag its dot to move it, or type its distances from the edges.",
      "This window: More → Version shows what is new.",
      "Settings → Mouse: turn, move and zoom the view the way other CAD programs do it. The app's own way stays the default. The wheel can be turned round too.",
      "While drawing a shape with a mouse, its sizes show by the pointer: type a number, Tab to the next size, Enter to place it.",
      "A box dragged round the shapes of a sketch picks them all, and Ctrl + A picks everything. Useful for an imported drawing with hundreds of shapes.",
      "The guide text at the top has an × that puts it away (More → Guide text brings it back).",
    ],
    fixed: [
      "A rounding was lost on one edge when its extrude was edited to go the other way.",
      "The edge of a thickened freeform surface could not be rounded.",
      "On an iPad, STL and other files were greyed out in the file picker.",
      "On an iPhone with the app installed, the number pad's keys did not line up with where they were drawn.",
    ],
  },
  {
    date: "2026-11-23",
    added: [
      "Tutorial (More → Tutorial): build a real M10 bolt and its nut, one tap at a time.",
      "Assemblies, a first version (More → BIM → Assemblies): joints between bodies, parts dragged by them, and Stop on contact.",
      "A pattern of a hole repeats the hole itself. Threads can have several starts, like a jar's lid.",
      "A variable can be renamed everywhere at once. Sketch patterns and fill patterns can follow variables.",
      "Offsets, mirrored copies and projected curves follow the sketch curves they were made from.",
    ],
    fixed: [
      "The tutorial could stop taking taps at step 3 on some phones.",
      "A narrow shape in a sketch can be picked without zooming in on it.",
    ],
  },
  {
    date: "2026-11-22",
    added: [
      "Linked copies and patterns: change one, and the others follow.",
      "Fill Pattern in sketches.",
      "Freeform solids take every body tool.",
    ],
    fixed: ["A section's cut face looks the same whatever the body's colour."],
  },
];

const day = (iso: string): string => {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
};

/** The window: the newest update on top, the ones before it under it. */
export function showWhatsNew(version: string): void {
  const back = el("div", "dialog-back");
  const box = el("div", "dialog about whats-new");
  const head = el("div", "library-head");
  head.append(el("div", "panel-title", `What's new · Version ${version}`));
  const closeBtn = el("button", "icon-btn library-close");
  closeBtn.type = "button";
  closeBtn.title = "Close";
  closeBtn.innerHTML = icons.close;
  head.append(closeBtn);
  const body = el("div", "about-body");
  UPDATES.forEach((u, i) => {
    const h = el("h3", "", day(u.date));
    if (i === 0) h.append(el("span", "whats-new-tag", "Latest"));
    body.append(h);
    for (const [title, lines] of [["New", u.added], ["Fixed", u.fixed]] as const) {
      if (!lines?.length) continue;
      body.append(el("div", "whats-new-kind", title));
      const ul = el("ul", "");
      for (const line of lines) ul.append(el("li", "", line));
      body.append(ul);
    }
  });
  box.append(head, body);
  back.append(box);
  const close = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") (e.preventDefault(), close());
    e.stopPropagation();
  };
  closeBtn.addEventListener("click", close);
  back.addEventListener("pointerdown", (ev) => ev.target === back && close());
  window.addEventListener("keydown", onKey, true);
  document.body.append(back);
}
