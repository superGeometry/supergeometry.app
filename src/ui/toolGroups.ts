// Where each tool sits on the line at the bottom: the group a picked thing's
// tool goes in when it is not named like one of the main tools, the order of
// a group's tools (most used first), and the main tool a pick's tool is under
// another name. (They came with the tool wheel the line took over from.)

const OWN = "own";

/**
 * Where a picked thing's tool goes when it isn't named like one of the main
 * tools (those go where the main tool is). Anything not known: with the pick's own, under More.
 */
export const GROUP_OF: Record<string, string> = {
  text: "sketch", offset: "sketch", projs: "sketch",
  editFreeform: "freeform", fillHole: "freeform", thicken: "freeform",
  planePerp: "construct", planeEdge: "construct", proje: "construct",
  moveBody: "transform", moveVertex: "transform", patl: "transform", patc: "transform", copySketch: "transform", align: "transform",
  offsetFromEdge: "modify", meshFaces: "modify",
  drawing: "more", material: "more",
  deselect: OWN, wholePattern: OWN, color: OWN, opacity: OWN, delete: OWN, deleteBody: OWN,
};

/**
 * Each group's tools, most used first. (Tools not named here come after, as
 * they are listed.)
 */
export const RANK = [
  "extrude", "revolve", "sweep", "loft", "hole",
  "lip", "boss", "snap", "rib",
  "fillet", "chamfer", "shell", "offsetFace", "fix", "offsetEdge", "thread", "wrap",
  "subtract", "union", "intersect", "split",
  // (Move's three ways together: in Transform's own list now, not under Move.)
  "move", "translate", "rotate", "mirror", "pattern", "scale",
  "plane", "axis", "proje",
  "ff-box", "ff-cylinder", "ff-sphere", "ff-torus", "ff-plane", "faceFreeform", "connect",
  "measure", "section", "variables", "insert", "bim",
];

/** A picked thing's tool that is one of the main tools under another name. */
export const ALIAS: Record<string, string> = { patl: "linear", patc: "circular", moveBody: "move", deleteBody: "delete", planePerp: "perp", planeEdge: "angle" };
