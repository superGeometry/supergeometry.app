// Real materials for bodies (BIM). Like a material in the big BIM tools,
// each one carries more than a look: who it is (identity: name, class, the
// standard its grade comes from), how it shows (a colour, see-through for
// glass), and its technical data - physical (density, stiffness, strength)
// and thermal (conductivity, specific heat, expansion). A body's mass, the
// technical sheet and the drawings' parts list are worked out from them.
//
// Values: strengths are the minimums the named standard gives the grade,
// where it has one; the rest are typical values for the material. Thermal
// values for building materials are the ISO 10456 design values. A supplier's
// own data sheet comes first wherever it differs.

import type { MaterialDef, ProjectDoc } from "../doc/types";
import { trim, UNIT_LABEL, UNIT_MM, units } from "../units";

export const MATERIAL_CLASSES = ["Metal", "Plastic", "Concrete & masonry", "Wood", "Glass & stone", "Insulation & boards"] as const;

export const MATERIALS: MaterialDef[] = [
  // ---- Metals
  { id: "steel-s235", name: "Structural steel S235JR", category: "Metal", standard: "EN 10025-2", color: "#8f959c", density: 7850, youngs: 210, poisson: 0.3, yield: 235, tensile: 360, expansion: 12, conductivity: 53, specificHeat: 440 },
  { id: "steel-s355", name: "Structural steel S355J2", category: "Metal", standard: "EN 10025-2", color: "#888e96", density: 7850, youngs: 210, poisson: 0.3, yield: 355, tensile: 470, expansion: 12, conductivity: 53, specificHeat: 440 },
  { id: "ss-304", name: "Stainless steel 1.4301 (304)", category: "Metal", standard: "EN 10088-2", color: "#b8bec5", density: 7900, youngs: 200, poisson: 0.3, yield: 210, tensile: 520, expansion: 16, conductivity: 15, specificHeat: 500 },
  { id: "ss-316", name: "Stainless steel 1.4401 (316)", category: "Metal", standard: "EN 10088-2", color: "#b3b9c0", density: 8000, youngs: 200, poisson: 0.3, yield: 220, tensile: 520, expansion: 16, conductivity: 15, specificHeat: 500 },
  { id: "al-6061", name: "Aluminium EN AW-6061-T6", category: "Metal", standard: "EN 755-2", color: "#c9ced4", density: 2700, youngs: 70, poisson: 0.3, yield: 240, tensile: 260, expansion: 23, conductivity: 167, specificHeat: 896 },
  { id: "al-6082", name: "Aluminium EN AW-6082-T6", category: "Metal", standard: "EN 1999-1-1", color: "#c4c9cf", density: 2700, youngs: 70, poisson: 0.3, yield: 260, tensile: 310, expansion: 23, conductivity: 170, specificHeat: 900 },
  { id: "cast-iron", name: "Grey cast iron EN-GJL-250", category: "Metal", standard: "EN 1561", color: "#5d6066", density: 7200, youngs: 110, poisson: 0.26, tensile: 250, expansion: 11, conductivity: 48, specificHeat: 460 },
  { id: "brass", name: "Brass CW614N (CuZn39Pb3)", category: "Metal", standard: "EN 12164", color: "#c9a64e", density: 8470, youngs: 96, poisson: 0.34, yield: 250, tensile: 430, expansion: 21, conductivity: 113, specificHeat: 377 },
  { id: "copper", name: "Copper Cu-ETP (CW004A)", category: "Metal", standard: "EN 13601", color: "#b87333", density: 8930, youngs: 117, poisson: 0.34, yield: 70, tensile: 200, expansion: 17, conductivity: 390, specificHeat: 385 },
  { id: "ti-5", name: "Titanium Grade 5 (Ti-6Al-4V)", category: "Metal", standard: "ASTM B348", color: "#8c8e91", density: 4430, youngs: 114, poisson: 0.34, yield: 828, tensile: 895, expansion: 8.6, conductivity: 6.7, specificHeat: 526 },
  // ---- Plastics (typical values; a printed part is weaker than a moulded one)
  { id: "pla", name: "PLA", category: "Plastic", color: "#e9e4d8", density: 1240, youngs: 3.5, poisson: 0.36, tensile: 50, expansion: 68, conductivity: 0.13, specificHeat: 1800 },
  { id: "petg", name: "PETG", category: "Plastic", color: "#cfe3e8", opacity: 0.85, density: 1270, youngs: 2, tensile: 50, conductivity: 0.2 },
  { id: "abs", name: "ABS", category: "Plastic", color: "#d9d4c7", density: 1050, youngs: 2.3, poisson: 0.35, tensile: 40, expansion: 90, conductivity: 0.17, specificHeat: 1400 },
  { id: "pa6", name: "Nylon PA6 (dry)", category: "Plastic", color: "#e8e2d0", density: 1140, youngs: 3, tensile: 80, expansion: 80, conductivity: 0.25, specificHeat: 1700 },
  { id: "pc", name: "Polycarbonate (PC)", category: "Plastic", color: "#dfe8ee", opacity: 0.6, density: 1200, youngs: 2.4, poisson: 0.37, yield: 62, tensile: 65, expansion: 70, conductivity: 0.2, specificHeat: 1200 },
  { id: "pmma", name: "Acrylic (PMMA)", category: "Plastic", color: "#e3f1f3", opacity: 0.4, density: 1190, youngs: 3.2, poisson: 0.37, tensile: 70, expansion: 70, conductivity: 0.19, specificHeat: 1470 },
  { id: "pom", name: "Acetal (POM)", category: "Plastic", color: "#f1efe9", density: 1410, youngs: 2.9, tensile: 65, expansion: 110, conductivity: 0.31, specificHeat: 1470 },
  { id: "epdm", name: "Rubber (EPDM)", category: "Plastic", standard: "ISO 10456", color: "#2e2f31", density: 1150, conductivity: 0.25, specificHeat: 1000 },
  // ---- Concrete and masonry
  { id: "concrete-c25", name: "Concrete C25/30", category: "Concrete & masonry", standard: "EN 1992-1-1", color: "#a3a29d", density: 2400, youngs: 31, poisson: 0.2, compressive: 25, tensile: 2.6, expansion: 10, conductivity: 2, specificHeat: 1000 },
  { id: "concrete-c30-rc", name: "Reinforced concrete C30/37 (1 % steel)", category: "Concrete & masonry", standard: "EN 1992-1-1", color: "#9c9b96", density: 2500, youngs: 33, poisson: 0.2, compressive: 30, tensile: 2.9, expansion: 10, conductivity: 2.3, specificHeat: 1000 },
  { id: "brick", name: "Clay brickwork (outer leaf)", category: "Concrete & masonry", color: "#a55a3f", density: 1700, conductivity: 0.77, specificHeat: 800 },
  // ---- Wood
  { id: "c24", name: "Softwood C24", category: "Wood", standard: "EN 338", color: "#d8b77e", density: 420, youngs: 11, bending: 24, tensile: 14.5, compressive: 21, expansion: 5, conductivity: 0.12, specificHeat: 1600 },
  { id: "d30", name: "Hardwood D30 (oak)", category: "Wood", standard: "EN 338", color: "#a97a4c", density: 640, youngs: 11, bending: 30, tensile: 18, compressive: 24, expansion: 5, conductivity: 0.18, specificHeat: 1600 },
  { id: "plywood", name: "Plywood", category: "Wood", standard: "ISO 10456", color: "#cfa86f", density: 500, conductivity: 0.13, specificHeat: 1600 },
  // ---- Glass and stone
  { id: "glass", name: "Float glass (soda-lime)", category: "Glass & stone", standard: "EN 572-1", color: "#bfdde0", opacity: 0.3, density: 2500, youngs: 70, poisson: 0.2, bending: 45, expansion: 9, conductivity: 1, specificHeat: 720 },
  { id: "granite", name: "Granite", category: "Glass & stone", standard: "ISO 10456", color: "#8b8580", density: 2700, conductivity: 2.8, specificHeat: 1000 },
  // ---- Insulation and boards
  { id: "plasterboard", name: "Gypsum plasterboard", category: "Insulation & boards", standard: "ISO 10456", color: "#ece9e2", density: 900, conductivity: 0.25, specificHeat: 1000 },
  { id: "mineral-wool", name: "Mineral wool", category: "Insulation & boards", color: "#d8c27a", density: 30, conductivity: 0.035, specificHeat: 1030 },
  { id: "eps", name: "Expanded polystyrene (EPS)", category: "Insulation & boards", color: "#f3f3f0", density: 20, conductivity: 0.035, specificHeat: 1450 },
];

/** Every material the project can use: the library, and its own. */
export function allMaterials(doc: ProjectDoc): MaterialDef[] {
  return [...MATERIALS, ...(doc.customMaterials ?? [])];
}

/** The material given to a body (undefined: none yet). */
export function materialOf(doc: ProjectDoc, body: string): MaterialDef | undefined {
  const id = doc.materials?.[body];
  return id ? allMaterials(doc).find((m) => m.id === id) : undefined;
}

/** The technical data of a material, as rows to show: [label, value with its unit]. Only what it has. */
export function materialRows(m: MaterialDef): { group: string; rows: [string, string][] }[] {
  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  const row = (label: string, v: number | undefined, unit: string): [string, string][] => (v === undefined ? [] : [[label, `${n(v)} ${unit}`.trim()]]);
  const groups = [
    { group: "Identity", rows: [["Class", m.category], ...(m.standard ? [["Standard", m.standard]] : []), ...(m.note ? [["Note", m.note]] : [])] as [string, string][] },
    {
      group: "Physical",
      rows: [
        ...row("Density", m.density, "kg/m³"),
        ...row("Young's modulus", m.youngs, "GPa"),
        ...row("Poisson's ratio", m.poisson, ""),
        ...row("Yield strength", m.yield, "MPa"),
        ...row("Tensile strength", m.tensile, "MPa"),
        ...row("Compressive strength", m.compressive, "MPa"),
        ...row("Bending strength", m.bending, "MPa"),
      ],
    },
    {
      group: "Thermal",
      rows: [...row("Thermal conductivity", m.conductivity, "W/(m·K)"), ...row("Specific heat", m.specificHeat, "J/(kg·K)"), ...row("Thermal expansion", m.expansion, "µm/(m·K)")],
    },
  ];
  return groups.filter((g) => g.rows.length);
}

/** Mass in kg of `volumeMM3` cubic millimetres of it. */
export function massOf(m: MaterialDef, volumeMM3: number): number {
  return volumeMM3 * 1e-9 * m.density;
}

/** A mass for people: g under a kilo, kg up to a tonne, t above. */
export function fmtMass(kg: number): string {
  if (kg < 1) return `${trim(kg * 1000, 1)} g`;
  if (kg < 1000) return `${trim(kg, 3)} kg`;
  return `${trim(kg / 1000, 3)} t`;
}

export function fmtVolume(mm3: number): string {
  const k = UNIT_MM[units()];
  return `${trim(mm3 / (k * k * k), 3)} ${UNIT_LABEL[units()]}³`;
}

export function fmtArea(mm2: number): string {
  const k = UNIT_MM[units()];
  return `${trim(mm2 / (k * k), 3)} ${UNIT_LABEL[units()]}²`;
}

/** Give bodies a material (its colour, and see-through for glass, come with it); null takes it away. */
export function assignMaterial(d: ProjectDoc, bodies: string[], m: MaterialDef | null): void {
  const materials = { ...(d.materials ?? {}) };
  const colors = { ...(d.colors ?? {}) };
  const opacity = { ...(d.opacity ?? {}) };
  for (const b of bodies) {
    if (!m) {
      delete materials[b];
      continue;
    }
    materials[b] = m.id;
    colors[b] = m.color;
    if (m.opacity !== undefined) opacity[b] = m.opacity;
    else delete opacity[b];
  }
  d.materials = materials;
  d.colors = colors;
  d.opacity = opacity;
}
