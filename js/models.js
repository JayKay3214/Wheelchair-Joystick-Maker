/**
 * Model registry. Each model describes a wheelchair joystick handle head.
 *
 * A model exposes:
 *   - id, label, icon (inline SVG)
 *   - smoothProfile: if true the outer silhouette is resampled with a Catmull-Rom
 *     spline (rounded shapes); if false the control points are used as a polyline
 *     (straight-sided shapes like the carrot / I-handle).
 *   - tiltKey: optional param key (degrees) used by geometry.js to lean the head.
 *   - schema: ordered list of sliders. `group` is "shape" or "mount".
 *   - buildOuterProfile(params): returns the OUTER silhouette of the head + stem as
 *     an ordered array of points { x, y, lockX?, lockY? } where x = radius (mm) and
 *     y = height above the print bed (mm). The list MUST start on the axis at the top
 *     (x = 0) and end at the bottom outer edge (y = 0). geometry.js appends the bore.
 *
 * Adding a new handle style (e.g. T-Bar, Goal Posts) = adding one entry here.
 */

// ---- shared slider definitions -------------------------------------------------

// Global edge-rounding (fillets sharp outer edges; never touches the bore).
const COMMON_SHAPE = [
  { key: "edgeRound", label: "Edge rounding", min: 0, max: 6, step: 0.25, group: "shape", unit: "mm", def: 1 },
];

// Common stem + bore controls appended to every model.
const STEM_PARAMS = [
  { key: "stemDia", label: "Stem diameter", min: 8, max: 26, step: 0.5, group: "shape", unit: "mm", def: 14 },
  { key: "stemHeight", label: "Stem height", min: 0, max: 35, step: 0.5, group: "shape", unit: "mm", def: 10 },
];

const BORE_PARAMS = [
  { key: "boreDia", label: "Hole diameter", min: 3, max: 16, step: 0.05, group: "mount", unit: "mm", def: 6.35 },
  { key: "boreDepth", label: "Hole depth", min: 4, max: 45, step: 0.5, group: "mount", unit: "mm", def: 16 },
];

// Helper: stem side of the silhouette (head junction -> bed). Always ends at y=0.
function stemTail(stemR, stemHeight) {
  const pts = [];
  if (stemHeight > 0.05) pts.push({ x: stemR, y: stemHeight });
  pts.push({ x: stemR, y: 0, lockY: true });
  return pts;
}

// Helper: rounded ball / squashed-sphere head sitting tangent on the stem top.
function ballHead(R, Rv, stemR, stemHeight, N = 26) {
  const sr = Math.min(stemR, R * 0.96);
  const tEnd = Math.PI - Math.asin(Math.min(sr / R, 0.999));
  const Cy = stemHeight - Rv * Math.cos(tEnd); // junction lands exactly on stem top
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = (tEnd * i) / N;
    const x = R * Math.sin(t);
    const y = Cy + Rv * Math.cos(t);
    pts.push({ x, y, lockX: i === 0 });
  }
  return pts;
}

// Helper: quadratic Bezier sampled into points (inclusive of both ends).
function quad(p0, p1, p2, N) {
  const out = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
      y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
    });
  }
  return out;
}

// ---- icons ---------------------------------------------------------------------

const ICON = {
  ball: `<svg viewBox="0 0 40 40"><circle class="stroke fill" cx="20" cy="15" r="10.5" stroke-width="2"/><rect class="stroke fill" x="16.5" y="24" width="7" height="11" rx="1.5" stroke-width="2"/></svg>`,
  mushroom: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M7 17 C7 8 33 8 33 17 C33 21 26 22 20 22 C14 22 7 21 7 17 Z" stroke-width="2"/><rect class="stroke fill" x="16" y="21" width="8" height="13" rx="1.5" stroke-width="2"/></svg>`,
  chincup: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M6 16 C6 22 34 22 34 16 C34 13 28 11 20 11 C12 11 6 13 6 16 Z" stroke-width="2"/><rect class="stroke fill" x="16" y="21" width="8" height="13" rx="1.5" stroke-width="2"/></svg>`,
  carrot: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M11 9 L29 9 L24 30 L16 30 Z" stroke-width="2"/></svg>`,
  ihandle: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M14 6 L24 8 L21 27 L15 26 Z" stroke-width="2"/><rect class="stroke fill" x="13" y="26" width="7" height="9" rx="1.5" stroke-width="2"/></svg>`,
};

// ---- models --------------------------------------------------------------------

const MODELS = [
  {
    id: "ball",
    label: "Ball",
    icon: ICON.ball,
    smoothProfile: true,
    schema: [
      { key: "dia", label: "Ball diameter", min: 16, max: 60, step: 0.5, group: "shape", unit: "mm", def: 30 },
      { key: "squash", label: "Squash", min: 0.8, max: 1.2, step: 0.01, group: "shape", unit: "x", def: 1.0 },
    ],
    defaults: { stemDia: 13, stemHeight: 11, boreDepth: 16 },
    buildOuterProfile(p) {
      const R = p.dia / 2;
      const head = ballHead(R, R * p.squash, p.stemDia / 2, p.stemHeight, 26);
      return [...head, ...stemTail(p.stemDia / 2, p.stemHeight)];
    },
  },

  {
    id: "mushroom",
    label: "Mushroom",
    icon: ICON.mushroom,
    smoothProfile: true,
    schema: [
      { key: "capDia", label: "Cap diameter", min: 22, max: 60, step: 0.5, group: "shape", unit: "mm", def: 34 },
      { key: "capHeight", label: "Cap height", min: 8, max: 28, step: 0.5, group: "shape", unit: "mm", def: 16 },
      { key: "undercut", label: "Undercut", min: 0, max: 8, step: 0.25, group: "shape", unit: "mm", def: 3 },
    ],
    defaults: { stemDia: 14, stemHeight: 9, boreDepth: 15 },
    buildOuterProfile(p) {
      const capR = p.capDia / 2;
      const stemR = p.stemDia / 2;
      const baseY = p.stemHeight;
      const topY = baseY + p.capHeight;
      const yRim = baseY + p.capHeight * 0.55;

      // Dome: top centre -> rim, sampled as a flattened super-ellipse.
      const dome = [];
      const N = 16;
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * (Math.PI / 2);
        dome.push({
          x: capR * Math.sin(t),
          y: topY - (topY - yRim) * (1 - Math.cos(t)),
          lockX: i === 0,
        });
      }
      // Underside: rim curls down & inward to the stem (undercut = overhang depth).
      const under = quad(
        { x: capR, y: yRim },
        { x: capR - p.undercut, y: baseY + (yRim - baseY) * 0.35 },
        { x: stemR, y: baseY },
        12
      );
      return [...dome, ...under.slice(1), ...stemTail(stemR, baseY)];
    },
  },

  {
    id: "chincup",
    label: "Chin Cup",
    icon: ICON.chincup,
    // Polyline (densely sampled) so the global "Edge rounding" slider can fillet the
    // sharp rim/lip; with Catmull smoothing the rim would always be auto-rounded.
    smoothProfile: false,
    roundable: true,
    schema: [
      { key: "rimDia", label: "Rim diameter", min: 26, max: 64, step: 0.5, group: "shape", unit: "mm", def: 40 },
      { key: "height", label: "Height", min: 10, max: 30, step: 0.5, group: "shape", unit: "mm", def: 18 },
      { key: "dish", label: "Top dish", min: 0, max: 8, step: 0.25, group: "shape", unit: "mm", def: 3 },
    ],
    defaults: { stemDia: 14, stemHeight: 9, boreDepth: 15, edgeRound: 2 },
    buildOuterProfile(p) {
      const rimR = p.rimDia / 2;
      const stemR = p.stemDia / 2;
      const baseY = p.stemHeight;
      const topY = baseY + p.height; // rim height (highest point)

      // Concave bowl: the centre sits `dish` BELOW the rim and curves up & outward
      // (parabolic), so the top is a true inward bowl rather than a dome.
      const top = [];
      const N = 18;
      for (let i = 0; i <= N; i++) {
        const r = (i / N) * rimR;
        const t = r / rimR;
        top.push({ x: r, y: topY - p.dish * (1 - t * t), lockX: i === 0 });
      }
      // Flared side: tapers from the rim down to the stem. The rim corner between the
      // bowl and this side is what "Edge rounding" smooths into a lip.
      const side = quad(
        { x: rimR, y: topY },
        { x: rimR * 0.92, y: baseY + (topY - baseY) * 0.4 },
        { x: stemR, y: baseY },
        14
      );
      return [...top, ...side.slice(1), ...stemTail(stemR, baseY)];
    },
  },

  {
    id: "carrot",
    label: "Remote+ (Carrot)",
    icon: ICON.carrot,
    smoothProfile: false,
    roundable: true,
    schema: [
      { key: "topDia", label: "Top diameter", min: 16, max: 50, step: 0.5, group: "shape", unit: "mm", def: 30 },
      { key: "bottomDia", label: "Bottom diameter", min: 10, max: 40, step: 0.5, group: "shape", unit: "mm", def: 18 },
      { key: "height", label: "Height", min: 16, max: 55, step: 0.5, group: "shape", unit: "mm", def: 32 },
    ],
    defaults: { stemDia: 14, stemHeight: 6, boreDepth: 18, edgeRound: 3 },
    buildOuterProfile(p) {
      const topR = p.topDia / 2;
      const botR = Math.max(p.bottomDia / 2, p.stemDia / 2);
      const stemR = p.stemDia / 2;
      const baseY = p.stemHeight;
      const topY = baseY + p.height;
      // Sharp frustum; the global "Edge rounding" slider softens the top/bottom edges.
      return [
        { x: 0, y: topY, lockX: true },
        { x: topR, y: topY },
        { x: botR, y: baseY },
        ...stemTail(stemR, baseY),
      ];
    },
  },

  {
    id: "ihandle",
    label: "I-Handle",
    icon: ICON.ihandle,
    smoothProfile: false,
    roundable: true,
    tiltKey: "tilt",
    schema: [
      { key: "topDia", label: "Top diameter", min: 10, max: 34, step: 0.5, group: "shape", unit: "mm", def: 16 },
      { key: "bottomDia", label: "Bottom diameter", min: 12, max: 40, step: 0.5, group: "shape", unit: "mm", def: 22 },
      { key: "length", label: "Grip length", min: 30, max: 90, step: 0.5, group: "shape", unit: "mm", def: 58 },
      { key: "tilt", label: "Tilt", min: 0, max: 30, step: 1, group: "shape", unit: "deg", def: 0 },
    ],
    // Edge rounding defaults to 6 mm so the grip top and the stem/head shoulder are
    // softly rounded out of the box (like the Carrot). The tilt never moves the bore.
    defaults: { stemDia: 16, stemHeight: 6, boreDepth: 20, edgeRound: 6 },
    buildOuterProfile(p) {
      const topR = p.topDia / 2;
      const botR = Math.max(p.bottomDia / 2, p.stemDia / 2);
      const stemR = p.stemDia / 2;
      const baseY = p.stemHeight;
      const topY = baseY + p.length;
      // Sharp tapered grip; "Edge rounding" softens the flat top edge and the shoulder.
      return [
        { x: 0, y: topY, lockX: true },
        { x: topR, y: topY },
        { x: botR, y: baseY },
        ...stemTail(stemR, baseY),
      ];
    },
  },
];

// Build the full default param object for a model (head + stem + bore defaults).
export function defaultParams(model) {
  const out = {};
  for (const s of fullSchema(model)) out[s.key] = s.def;
  if (model.defaults) Object.assign(out, model.defaults);
  return out;
}

// Full ordered schema = model shape params + (edge rounding, if the shape has sharp
// edges) + stem + bore. Smooth shapes (Ball, Mushroom) hide the edge-rounding slider.
export function fullSchema(model) {
  const rounding = model.roundable ? COMMON_SHAPE : [];
  return [...model.schema, ...rounding, ...STEM_PARAMS, ...BORE_PARAMS];
}

export function getModel(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}

export { MODELS };
