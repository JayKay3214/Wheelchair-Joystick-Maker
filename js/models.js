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
// `max` here is only a fallback; roundable models with an `edgeRoundMax(params)`
// function get a dynamic max scaled to the shape (e.g. the top radius).
const COMMON_SHAPE = [
  { key: "edgeRound", label: "Edge rounding", min: 0, max: 25, step: 0.25, group: "shape", unit: "mm", def: 1 },
];

// Common stem + bore controls appended to every model.
const STEM_PARAMS = [
  { key: "stemDia", label: "Stem diameter", min: 8, max: 26, step: 0.5, group: "shape", unit: "mm", def: 14 },
  { key: "stemHeight", label: "Stem height", min: 0, max: 35, step: 0.5, group: "shape", unit: "mm", def: 10 },
];

const BORE_PARAMS = [
  { key: "boreDia", label: "Hole diameter", min: 3, max: 16, step: 0.05, group: "mount", unit: "mm", def: 6.7 },
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

// ---- goal-post geometry recipe -------------------------------------------------
// The goal-post is NOT a solid of revolution or a simple extrusion. It is:
//   * a thin contoured BASE (palm rest): the top is shaped front-to-back with a tight
//     curve at the FRONT (fingers) and a long gradual slope at the BACK (palm), plus an
//     optional central MOUND over the stem;
//   * two curved SIDE WALLS (arms) that rise from the left/right of the base and hook
//     inward, spanning only PART of the base depth (not its whole length);
//   * a bored stem, centred under the base.
// This recipe is shared by the 3D builder (geometry.js) and the 2D front-view preview.

const GP_BASE_THK = 7; // nominal base-pad thickness (mm) — deliberately thin
const GP_ARM_THK = 9;  // side-wall (arm) thickness (mm)

// Sample a Catmull-Rom spline through the control points (`per` samples per segment).
function gpCatmull(pts, per) {
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    const f = (a, b, c, d) =>
      0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
    return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
  };
  const out = [], n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
    for (let s = 0; s < per; s++) out.push(cr(p0, p1, p2, p3, s / per));
  }
  out.push(pts[n - 1]);
  return out;
}

// Offset a centreline into a constant-thickness closed ribbon outline (CCW for extrude).
function gpRibbon(cp, thk, per) {
  const c = gpCatmull(cp, per), h = thk / 2, m = c.length, top = [], bot = [];
  for (let i = 0; i < m; i++) {
    const a = c[Math.max(0, i - 1)], b = c[Math.min(m - 1, i + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    top.push({ x: c[i].x - ty * h, y: c[i].y + tx * h });
    bot.push({ x: c[i].x + ty * h, y: c[i].y - tx * h });
  }
  let out = [...top, ...bot.reverse()];
  let area = 0;
  for (let i = 0; i < out.length; i++) { const q = out[i], r = out[(i + 1) % out.length]; area += q.x * r.y - r.x * q.y; }
  if (area < 0) out.reverse();
  return out;
}

// Top-surface height of the base pad at (x,z). z<0 = front (fingers), z>0 = back (palm).
export function gpTopHeight(P, x, z) {
  const u = x / P.halfW, w = z / P.halfD;
  // edge falloff -> the pad thins to a rounded rim (rounded-rectangle footprint).
  const ef = Math.pow(Math.max(0, (1 - Math.pow(Math.abs(u), 8)) * (1 - Math.pow(Math.abs(w), 8))), 0.5);
  // palm contour: a skewed bump peaking just behind the front edge (tight curve at the
  // front for fingers, long gradual slope to the back where the palm rests).
  const wp = P.palmPeak;
  const t = Math.min(1, w <= wp ? (wp - w) / (wp + 1) : (w - wp) / (1 - wp));
  const palm = P.palmAmt * (0.5 + 0.5 * Math.cos(Math.PI * t));
  // central mound over the stem (flat when moundAmt = 0).
  const hill = P.moundAmt * Math.exp(-((u / 0.5) ** 2 + (w / 0.55) ** 2));
  const rim = 2.0; // minimum edge thickness so the rim isn't a knife edge
  return P.B0 + rim + (P.baseThk - rim + palm + hill) * ef;
}

export function goalPostShape(p) {
  const width = p.width, height = p.height;
  const depth = Math.min(Math.max(width * 0.52, 42), 60);
  const P = {
    width, depth, height,
    halfW: width / 2, halfD: depth / 2,
    B0: p.stemHeight,                 // base pad underside sits on the stem top
    baseThk: GP_BASE_THK, armThk: GP_ARM_THK,
    palmAmt: Math.min(11, depth * 0.22), palmPeak: -0.12,
    moundAmt: p.mound,
    wallSpan: p.wallSpan, wallCurve: p.wallCurve,
    stemR: Math.max(p.stemDia / 2, 2),
    stemTopY: p.stemHeight + 4,        // pushes up into the base so the solids fuse
  };
  P.boreR = Math.min(Math.max(p.boreDia / 2, 0.4), P.stemR - 1.2);
  P.boreCeil = Math.min(Math.max(p.boreDepth, 2), P.stemTopY - 3);
  P.armDepth = Math.max(6, P.wallSpan * depth); // side walls span only part of the depth

  // Side-wall (arm) centrelines in the front (X-Y) plane: rise from the base, hook inward.
  const halfW = P.halfW, H = height, curve = P.wallCurve;
  // Arms rise almost vertically from the base, then hook inward near the top (a slight
  // outward belly, controlled amount of inward hook via wallCurve).
  const rootX = 0.80 * halfW, yRoot = gpTopHeight(P, rootX, 0);
  const cpR = [
    { x: rootX, y: yRoot },
    { x: rootX + 0.04 * halfW, y: yRoot + 0.45 * H },
    { x: rootX - 0.02 * halfW, y: yRoot + 0.78 * H },
    { x: rootX - (0.14 + 0.30 * curve) * halfW, y: yRoot + H },
  ];
  P.armRightOutline = gpRibbon(cpR, P.armThk, 14);
  P.armLeftOutline = gpRibbon(cpR.map((q) => ({ x: -q.x, y: q.y })), P.armThk, 14);

  // Front-view base silhouette for the 2D editor.
  const baseOutline = []; const NS = 44;
  for (let i = 0; i <= NS; i++) { const x = -halfW + (2 * halfW * i) / NS; baseOutline.push({ x, y: gpTopHeight(P, x, 0) }); }
  baseOutline.push({ x: halfW, y: P.B0 }, { x: -halfW, y: P.B0 });
  P.front = { parts: [baseOutline, P.armRightOutline, P.armLeftOutline] };
  return P;
}

// ---- T-bar geometry recipe -----------------------------------------------------
// A rounded horizontal handle bar (a flattened-oval tube swept along the X axis whose
// ends droop down and taper off) sitting on a central bored stem. Shared by the 3D
// builder (geometry.js) and the 2D front-view preview (profileEditor.js).

const TBAR_WIDTH_RATIO = 1.35; // cross-section is this much WIDER (front-back) than tall

// Height of the bar centreline at normalised position t in [-1,1] (0 = centre).
export function tbarCenterY(P, t) {
  return P.barY - P.droop * t * t; // ends sag below the centre
}

// Cross-section scale (0..1) at t: blends a blunt/rounded end (taper 0) into a long
// pointed end (taper 1). 1 at the centre, 0 at each tip. Both blend terms are EVEN in t
// and flat (zero-slope) at t=0, so the middle is a smooth dome with no crease/ridge.
export function tbarScale(P, t) {
  const t2 = Math.min(1, t * t);
  const blunt = Math.sqrt(Math.max(0, 1 - t2 * t2 * t2)); // 1 - t^6: full middle, rounded ends
  const pointed = 1 - t2;                                 // 1 - t^2: tapered, pointed ends
  return (1 - P.taper) * blunt + P.taper * pointed;
}

export function tbarShape(p) {
  const ry = p.thickness / 2;          // vertical semi-axis (thickness = top-to-bottom)
  const P = {
    ry,
    rz: ry * TBAR_WIDTH_RATIO,          // front-back semi-axis (wider than tall)
    halfL: p.length / 2,
    droop: p.endDroop,
    taper: p.endTaper,
    stemR: Math.max(p.stemDia / 2, 2),
  };
  P.barY = p.stemHeight + ry;           // centreline height (bar bottom ~ on the stem)
  P.stemTopY = P.barY;                  // stem reaches the centreline so the solids fuse
  P.boreR = Math.min(Math.max(p.boreDia / 2, 0.4), P.stemR - 1.2);
  P.boreCeil = Math.min(Math.max(p.boreDepth, 2), P.stemTopY - 3);

  // Front-view (X-Y) silhouette for the editor: top edge then bottom edge back.
  const NS = 60, top = [], bot = [];
  for (let i = 0; i <= NS; i++) {
    const t = -1 + (2 * i) / NS;
    const cx = t * P.halfL, cy = tbarCenterY(P, t), s = tbarScale(P, t);
    top.push({ x: cx, y: cy + s * ry });
    bot.push({ x: cx, y: cy - s * ry });
  }
  P.front = { parts: [[...top, ...bot.reverse()]] };
  return P;
}

// ---- icons ---------------------------------------------------------------------

const ICON = {
  ball: `<svg viewBox="0 0 40 40"><circle class="stroke fill" cx="20" cy="15" r="10.5" stroke-width="2"/><rect class="stroke fill" x="16.5" y="24" width="7" height="11" rx="1.5" stroke-width="2"/></svg>`,
  mushroom: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M7 17 C7 8 33 8 33 17 C33 21 26 22 20 22 C14 22 7 21 7 17 Z" stroke-width="2"/><rect class="stroke fill" x="16" y="21" width="8" height="13" rx="1.5" stroke-width="2"/></svg>`,
  chincup: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M6 16 C6 22 34 22 34 16 C34 13 28 11 20 11 C12 11 6 13 6 16 Z" stroke-width="2"/><rect class="stroke fill" x="16" y="21" width="8" height="13" rx="1.5" stroke-width="2"/></svg>`,
  carrot: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M11 9 L29 9 L24 30 L16 30 Z" stroke-width="2"/></svg>`,
  ihandle: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M14 6 L24 8 L21 27 L15 26 Z" stroke-width="2"/><rect class="stroke fill" x="13" y="26" width="7" height="9" rx="1.5" stroke-width="2"/></svg>`,
  goalpost: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M5 13 C5 9 10 9 10 13 L10 19 C16 22 24 22 30 19 L30 13 C30 9 35 9 35 13 L35 20 C35 27 5 27 5 20 Z" stroke-width="2"/><rect class="stroke fill" x="17" y="26" width="6" height="9" rx="1.5" stroke-width="2"/></svg>`,
  tbar: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M4 14 C14 9 26 9 36 14 C26 18 14 18 4 14 Z" stroke-width="2"/><rect class="stroke fill" x="17" y="16" width="6" height="18" rx="1.5" stroke-width="2"/></svg>`,
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
    edgeRoundMax: (p) => Math.min(p.height, p.rimDia / 2),
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
    label: "Carrot",
    icon: ICON.carrot,
    smoothProfile: false,
    roundable: true,
    edgeRoundMax: (p) => p.topDia / 2,
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
    edgeRoundMax: (p) => p.topDia / 2,
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

  {
    id: "goalpost",
    label: "Goal Posts",
    icon: ICON.goalpost,
    // Hidden from the picker for now — the shape still needs work (see project memory).
    hidden: true,
    // Not a solid of revolution: geometry.js builds it from goalPostShape() instead of
    // revolving a profile. custom -> the 2D editor shows a static front view (no drag).
    smoothProfile: false,
    custom: true,
    geometryKind: "goalpost",
    shape2D: goalPostShape,
    schema: [
      { key: "width", label: "Width", min: 60, max: 130, step: 1, group: "shape", unit: "mm", def: 92 },
      { key: "height", label: "Side-wall height", min: 12, max: 55, step: 0.5, group: "shape", unit: "mm", def: 34 },
      { key: "mound", label: "Base mound", min: 0, max: 12, step: 0.5, group: "shape", unit: "mm", def: 4 },
      { key: "wallSpan", label: "Side-wall length", min: 0.25, max: 0.9, step: 0.05, group: "shape", unit: "x", def: 0.5 },
      { key: "wallCurve", label: "Side-wall inward curve", min: 0, max: 1, step: 0.05, group: "shape", unit: "x", def: 0.4 },
    ],
    defaults: { stemDia: 14, stemHeight: 20, boreDepth: 22 },
    // Placeholder profile so the store stays valid; the custom builder ignores it.
    buildOuterProfile(p) {
      const S = goalPostShape(p);
      return [{ x: 0, y: S.stemTopY }, { x: S.stemR, y: 0, lockY: true }];
    },
  },

  {
    id: "tbar",
    label: "T-Bar",
    icon: ICON.tbar,
    smoothProfile: false,
    custom: true,
    geometryKind: "tbar",
    shape2D: tbarShape,
    schema: [
      { key: "thickness", label: "Handle thickness", min: 12, max: 40, step: 0.5, group: "shape", unit: "mm", def: 22 },
      { key: "length", label: "Handle length", min: 40, max: 130, step: 1, group: "shape", unit: "mm", def: 82 },
      { key: "endDroop", label: "End droop", min: 0, max: 25, step: 0.5, group: "shape", unit: "mm", def: 5 },
      { key: "endTaper", label: "End taper", min: 0, max: 1, step: 0.05, group: "shape", unit: "x", def: 0.4 },
    ],
    defaults: { stemDia: 14, stemHeight: 18, boreDepth: 18 },
    buildOuterProfile(p) {
      const S = tbarShape(p);
      return [{ x: 0, y: S.stemTopY }, { x: S.stemR, y: 0, lockY: true }];
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
