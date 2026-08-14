// Copyright 2026 Jayden Collier and Jayke Collier
// SPDX-License-Identifier: Apache-2.0

import { PLATE_THICKNESS, testerFileName } from "./boreTester.js";

/** The tester is a mode, not a style; several modules need to recognise it. */
export const BORE_TESTER_ID = "boretester";

/** The style the app opens on, and falls back to. */
export const DEFAULT_MODEL_ID = "ball";

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

// Global edge-rounding (fillets sharp outer edges; never touches the bore). Appended only
// to models that declare `edgeRoundMax`, which scales the ceiling to their own shape — 32
// is above every value they can ask for, so the declared max never binds first. The entry
// is shared BY REFERENCE across those models, which is why the per-model part dispatches
// through the model rather than living on the entry.
const COMMON_SHAPE = [
  { key: "edgeRound", label: "Edge rounding", min: 0, max: 32, step: 0.25, group: "shape", unit: "mm", def: 1,
    fitFn: (p, m) => Math.max(0.25, m.edgeRoundMax(p)) },
];

// Common stem + bore controls appended to every model.
const STEM_PARAMS = [
  { key: "stemDia", label: "Stem diameter", min: 8, max: 26, step: 0.5, group: "stem", unit: "mm", def: 14 },
  { key: "stemHeight", label: "Stem height", min: 0, max: 35, step: 0.5, group: "stem", unit: "mm", def: 10 },
];

const STEM_HEIGHT = STEM_PARAMS.find((s) => s.key === "stemHeight");

const BORE_MIN_DEPTH = 2;   // shallower than this is not a hole worth cutting
const BORE_MIN_RADIUS = 0.4; // narrower than this is not a hole worth cutting either
const BORE_WALL = 1.2;      // material left between the bore and the outside of the stem

/**
 * Radius of the bore inside a stem of radius `stemR` — or NULL when the wall allowance
 * leaves nothing to cut. Pairs with boreCeiling: both return null for "no bore", so a
 * caller needs one shape of check rather than two.
 */

const BORE_PARAMS = [
  { key: "boreDia", label: "Hole diameter", min: 3, max: 16, step: 0.05, group: "mount", unit: "mm", def: 6.7 },
  // Three separate jobs, so three separate hooks — one ceiling doing all of them is how the
  // slider ended up promising depth the model never built. See js/schema.js for the contract.
  //
  //   reachFn  how far the SLIDER travels: as deep as the shape could go with the stem wound
  //            all the way out, because asking for a deep hole is how you tell the app to
  //            grow the stem. Capping at the CURRENT stem would make that unreachable.
  //   fitFn    what the shape can hold RIGHT NOW. Shortening the stem trims the depth to it.
  //   growFn   the other direction: raise the stem to meet the depth you asked for.
  //
  // 45 mm is the hard ceiling over all of it. Powerchair handles are built to grip a stem of
  // 1" (25.4 mm) or more — Bodypoint's fit both the 4.8 mm (Invacare) and 6.4 mm (Permobil /
  // Pride / Quantum / Quickie) stems — so 45 is comfortably past any real one, and roughly
  // triple our own 15-22 mm defaults. A bore deeper than the stem removes material around
  // thin air.
  //
  // Floor is 0 so the slider can say "no hole", and `normalise` collapses everything below
  // the minimum cuttable depth onto it: between the two there is no hole, and a readout of
  // "1.0 mm" over a solid part is the exact lie this whole mechanism exists to prevent.
  { key: "boreDepth", label: "Hole depth", min: 0, max: 45, step: 0.5, group: "mount", unit: "mm", def: 16,
    reachFn: (p, m) => boreDepthCeiling(m, { ...p, stemHeight: STEM_HEIGHT.max }),
    fitFn: (p, m) => boreDepthCeiling(m, p),
    growFn: (p, m) => ({ stemHeight: stemHeightForBore(m, p) }),
    normalise: (v) => (v < BORE_MIN_DEPTH ? 0 : v) },
];

const BORE_DIA = BORE_PARAMS.find((s) => s.key === "boreDia");

// The bore has to stop short of the top of the solid it sits in, or it would blow out
// through the crown. geometry.js enforces this margin; the two helpers below let the UI
// see the same limit instead of letting a slider promise depth that never gets built.
const BORE_HEADROOM = 3; // mm of material left above the bore ceiling

/**
 * Height the bore reaches inside a solid whose top is at `topY` — or NULL when the solid is
 * too short to hold one at all.
 *
 * Returning null rather than a number is the whole point. This used to be a bare
 * `min(max(depth, 2), topY - 3)`, which on a very short stem goes NEGATIVE, and a negative
 * ceiling revolves the bore BACKWARDS: instead of a cavity you get a solid peg hanging below
 * the print bed, on a part the UI still claims has a hole in it. No room now means no bore.
 */
export function boreRadius(boreDia, stemR) {
  const r = Math.min(Math.max(boreDia / 2, BORE_MIN_RADIUS), stemR - BORE_WALL);
  return r > BORE_MIN_RADIUS ? r : null; // collapsed to nothing: no bore
}

export function boreCeiling(boreDepth, topY) {
  if (boreDepth < BORE_MIN_DEPTH) return null; // asked for no hole
  const ceiling = Math.min(boreDepth, topY - BORE_HEADROOM);
  return ceiling >= BORE_MIN_DEPTH ? ceiling : null; // no room for one
}

/**
 * Top of the solid the bore runs up into, in mm above the bed. For revolution handles that
 * is the crown of the head; for the swept ones (Goal Posts, T-Bar) the bore lives in the
 * stem, so it is the stem top. Every model's profile starts at that point, which is the
 * same value geometry.js measures against.
 */
function boreTopY(model, params) {
  return model.buildOuterProfile(params)[0].y;
}

/** Deepest hole this model can actually build at its current settings. */
function boreDepthCeiling(model, params) {
  return boreTopY(model, params) - BORE_HEADROOM;
}

/**
 * Stem height needed to hold a given hole depth. The head sits on top of the stem, so the
 * room above the stem is fixed and the stem makes up the difference.
 */
function stemHeightForBore(model, params) {
  const headroom = boreTopY(model, params) - params.stemHeight;
  return params.boreDepth + BORE_HEADROOM - headroom;
}

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
// The whole head (base + side walls) is ONE watertight solid: a heightfield whose top
// surface simply RISES to wall height in the wall regions. The walls are the base's own
// outer edges raised straight up (their outer face is literally the base's side, extended
// upward) — no separate wall blocks, so there are no overlapping/coincident faces and
// therefore no z-fighting. Geometry.js builds it via gpTopHeight; the 2D editor reuses it.
//
//   * base: a rectangular slab (flat bottom, four straight sides), top domed by `hump`;
//   * walls: at the left/right edges (a band `wallThk` wide, inward from each side),
//     spanning only the middle `wallLength` of the depth, rising `wallHeight` above the
//     floor, with a rounded inside corner (`wallCorner`).

const GP_BASE_THK = 10; // base slab thickness (floor height above the stem top)
const GP_WALL_THK = 8;  // side-wall thickness (mm band, inward from each base edge)

// Smooth 0->1 ramp between edge0 and edge1 (used for the rounded inside corners).
function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Footprint half-width (x half-extent) at depth z: straight sides at `halfW`, with a rounded
// corner of radius `frontCornerR` at the front (z = -halfD) and `backCornerR` at the back
// (z = +halfD) — the top-down outline is a rounded rectangle with asymmetric corners.
export function gpHalfWidthAt(P, z) {
  const halfW = P.halfW, halfD = P.halfD;
  if (P.frontCornerR > 0.01 && z < -halfD + P.frontCornerR) {
    const dz = z - (-halfD + P.frontCornerR);
    return (halfW - P.frontCornerR) + Math.sqrt(Math.max(0, P.frontCornerR * P.frontCornerR - dz * dz));
  }
  if (P.backCornerR > 0.01 && z > halfD - P.backCornerR) {
    const dz = z - (halfD - P.backCornerR);
    return (halfW - P.backCornerR) + Math.sqrt(Math.max(0, P.backCornerR * P.backCornerR - dz * dz));
  }
  return halfW;
}

// Top-surface height of the head at (x,z). The floor is a smooth palm-rest DOME (peaks in
// the centre, falls to the edges) scaled by the "Palm Rest" slider. The wall top is a FLAT
// fixed height so the walls stay flat/unaffected by the dome; the wall inner face is vertical
// with a concave fillet at its base and the front/back ends use a small fixed transition.
export function gpTopHeight(P, x, z) {
  const u = x / P.halfW, w = z / P.halfD;
  // Palm-rest dome: peaks at the centre and falls to the side edges (1 - u^2). Along the depth
  // the top stays FLAT near the centre and curves down MORE the closer you get to the edge
  // (|w|^p — zero slope at the centre, steepest at the edge, so there is no convex lip). It is
  // ASYMMETRIC: only a little droop toward the front (-w), a lot toward the back (+w).
  const frontKeep = 0.75, backKeep = 0.05, p = 2.6;
  const dp = 1 - (1 - (w <= 0 ? frontKeep : backKeep)) * Math.pow(Math.abs(w), p);
  const floorTop = P.B0 + P.baseThk + P.hump * Math.max(0, 1 - u * u) * dp;
  if (P.wallHeight <= 0.01 || P.wallLen <= 0.01) return floorTop;
  const ax = Math.abs(x);
  // Walls are STRAIGHT and live only on the straight side region — never on the rounded
  // corners. Centre them in that region and cap their length to it.
  const straightLo = -P.halfD + P.frontCornerR, straightHi = P.halfD - P.backCornerR;
  const wl = Math.min(P.wallLen, straightHi - straightLo);
  if (wl < 1) return floorTop;
  const zc = (straightLo + straightHi) / 2, zLo = zc - wl / 2, zHi = zc + wl / 2;
  if (z <= zLo || z >= zHi) return floorTop;
  const fEnd = Math.min(1.5, wl / 2 - 0.1);
  const gz = Math.min(smoothstep(zLo, zLo + fEnd, z), 1 - smoothstep(zHi - fEnd, zHi, z));
  if (gz <= 0) return floorTop;
  const X0 = P.halfW - P.wallThk, r = P.wallFillet; // straight wall band (fixed inner face)
  const wallTopY = P.B0 + P.baseThk + P.wallHeight; // FLAT wall top, independent of the dome
  let target;
  if (ax >= X0) target = wallTopY;
  else if (r > 0.01 && ax >= X0 - r) { const d = ax - (X0 - r); target = floorTop + (r - Math.sqrt(Math.max(0, r * r - d * d))); }
  else target = floorTop;
  return floorTop + (target - floorTop) * gz;
}

export function goalPostShape(p) {
  const P = {
    halfW: p.baseWidth / 2,
    halfD: p.baseLength / 2,
    B0: p.stemHeight,            // base underside sits on the stem top
    baseThk: GP_BASE_THK,
    hump: p.hump || 0,           // models without a hump slider get a flat floor
    wallHeight: p.wallHeight,
    wallThk: GP_WALL_THK,
    stemR: Math.max(p.stemDia / 2, 2),
    stemTopY: p.stemHeight + 4,  // pokes up into the base so the two solids fuse
  };
  // Rounded-rectangle footprint corners (0 = square). Front small, back large by default.
  P.frontCornerR = Math.max(0, Math.min(p.frontCornerR || 0, P.halfW - 1, P.halfD - 0.5));
  P.backCornerR = Math.max(0, Math.min(p.backCornerR || 0, P.halfW - 1, P.halfD - 0.5));
  const sumR = P.frontCornerR + P.backCornerR, maxSum = 2 * P.halfD - 1;
  if (sumR > maxSum && sumR > 0) { const s = maxSum / sumR; P.frontCornerR *= s; P.backCornerR *= s; }
  P.wallLen = Math.max(0, Math.min(p.wallLength, p.baseLength)); // never exceeds the base length
  // Inside-corner fillet radius (0 = sharp), clamped so the vertical inner face keeps some
  // height and the fillet stays on the floor side of the wall band.
  P.wallFillet = Math.max(0, Math.min(p.wallCorner, p.wallHeight - 0.5, P.halfW - P.wallThk - 1));
  P.boreR = boreRadius(p.boreDia, P.stemR);
  P.boreCeil = boreCeiling(p.boreDepth, P.stemTopY); // null = no room, so no bore

  // Front-view (X-Y) silhouette for the 2D editor: the top profile at mid-depth (z=0, i.e.
  // through the walls) then down the sides to the flat bottom.
  const NS = 90, top = [];
  for (let i = 0; i <= NS; i++) { const x = -P.halfW + (2 * P.halfW * i) / NS; top.push({ x, y: gpTopHeight(P, x, 0) }); }
  P.front = { parts: [[...top, { x: P.halfW, y: P.B0 }, { x: -P.halfW, y: P.B0 }]] };
  return P;
}

// ---- Goal Post 2: oval "Pringles" saddle base ----------------------------------
// The base is an OVAL (ellipse: wide left-right where the walls go, shorter front-to-back)
// shaped like a Pringles chip: a constant-thickness slab whose mid-surface curves UP toward
// the left/right (wall) ends and droops DOWN toward the front/back ends. The centre stays
// fixed; the "Palm Rest" slider only sets how much the front/back droop. (Walls come later.)
const GPO_SLAB_THK = 12; // saddle slab thickness (mm)
const GPO_WALL_THK = 8;  // side-wall thickness (x, mm)
const GPO_TAB_OUT = 12;  // how far the rectangular tab sticks out past the oval edge (mm)

// Elliptical footprint half-width (x half-extent) at depth z; a small floor keeps the
// front/back ends slightly rounded instead of collapsing to a degenerate point.
export function gpOvalHalfWidth(P, z) {
  const e = 1 - (z / P.halfD) * (z / P.halfD);
  return e <= 0 ? 0.8 : Math.max(0.8, P.halfW * Math.sqrt(e));
}

// Saddle mid-surface height at (x,z): fixed centre, left/right bend DOWN by `sideBend`,
// front/back droop DOWN by `droop` (Palm Rest). Highest at the centre (convex).
export function gpOvalMid(P, x, z) {
  const u = x / P.halfW, w = z / P.halfD;
  return P.midCentre - P.sideBend * u * u - P.droop * w * w;
}


export function gpOvalShape(p) {
  const P = {
    halfW: p.baseWidth / 2,
    halfD: p.baseLength / 2,
    halfThick: GPO_SLAB_THK / 2,
    stemR: Math.max(p.stemDia / 2, 2),
  };
  // droop (front/back) and side bend (left/right) both capped so the low edges stay above bed.
  P.droop = Math.max(0, Math.min(p.palmRest || 0, p.stemHeight - 3));
  P.sideBend = Math.max(0, Math.min(p.sideBend || 0, p.stemHeight - 3));
  P.midCentre = p.stemHeight + P.halfThick; // centre-bottom sits at the stem top
  P.stemTopY = p.stemHeight + 2;            // pokes into the base so the two solids fuse
  // Side walls: a rectangular tab sticks straight out at each widest point (z=0), with a
  // straight vertical wall at the tab's outer tip.
  P.wallHeight = p.wallHeight || 0;
  P.wallLen = Math.max(0, Math.min(p.wallLength || 0, p.baseLength));
  P.tabOut = Math.max(2, p.tabStick ?? GPO_TAB_OUT);  // how far the tab juts past the oval edge
  P.wallThk = Math.max(2, Math.min(GPO_WALL_THK, P.tabOut - 1)); // fixed 8mm wall (auto-thinned if the tab is very short)
  P.tabOuter = P.halfW + P.tabOut;                    // outer tip of the tab / wall (|x|)
  P.wallBandInner = P.tabOuter - P.wallThk;           // inner face of the vertical wall
  // FLAT reference levels (the widest-point base height at z=0). The shelf TOP droops per-depth in
  // geometry.js (so it stays attached to the base edge — no cutoff), but the wall TOP and the tab
  // BOTTOM stay flat at these levels (so the wall top is level and the tab underside isn't a fang).
  P.shelfTopY = (P.midCentre - P.sideBend) + P.halfThick;
  P.shelfBotY = (P.midCentre - P.sideBend) - P.halfThick; // FLAT tab underside
  P.wallTopY = P.shelfTopY + P.wallHeight;                // FLAT wall top
  // Inner-corner fillet, as a quarter-ELLIPSE so it can grow without widening the tab: the
  // horizontal reach is capped by the flat-shelf width (tabOut - wallThk); the vertical reach
  // (the slider) sweeps up the wall, capped only by the wall height. Equal at small values
  // (a normal round), taller-than-wide as the slider increases.
  P.wallCurve = Math.max(0, Math.min(p.wallCorner || 0, P.wallHeight - 0.5));            // vertical reach (ry)
  P.wallCurveX = Math.max(0, Math.min(P.wallCurve, P.tabOut - P.wallThk - 0.3));          // horizontal reach (rx)
  P.boreR = boreRadius(p.boreDia, P.stemR);
  P.boreCeil = boreCeiling(p.boreDepth, P.stemTopY); // null = no room, so no bore

  // Front-view (X-Y) slab cross-section at z=0 for the 2D editor (shows the up-curve).
  const NS = 50, top = [], bot = [];
  for (let i = 0; i <= NS; i++) {
    const x = -P.halfW + (2 * P.halfW * i) / NS, m = gpOvalMid(P, x, 0);
    top.push({ x, y: m + P.halfThick });
    bot.push({ x, y: m - P.halfThick });
  }
  P.front = { parts: [[...top, ...bot.reverse()]] };
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
  P.boreR = boreRadius(p.boreDia, P.stemR);
  P.boreCeil = boreCeiling(p.boreDepth, P.stemTopY); // null = no room, so no bore

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
  // Upright and symmetric about the centre axis — the handle only leans when the Tilt
  // slider says so, and its default is 0, so a leaning icon misrepresented the shape.
  ihandle: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M16 4 L24 4 L25.5 28 L14.5 28 Z" stroke-width="2"/><rect class="stroke fill" x="16.5" y="27" width="7" height="8" rx="1.5" stroke-width="2"/></svg>`,
  goalpost: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M6 13 L11 13 L11 21 L29 21 L29 13 L34 13 L34 26 L6 26 Z" stroke-width="2"/><rect class="stroke fill" x="17" y="26" width="6" height="8" rx="1.5" stroke-width="2"/></svg>`,
  goalpost2: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M6 13 L11 13 L11 20 C18 23 22 23 29 20 L29 13 L34 13 L34 26 L6 26 Z" stroke-width="2"/><rect class="stroke fill" x="17" y="26" width="6" height="8" rx="1.5" stroke-width="2"/></svg>`,
  tbar: `<svg viewBox="0 0 40 40"><path class="stroke fill" d="M4 14 C14 9 26 9 36 14 C26 18 14 18 4 14 Z" stroke-width="2"/><rect class="stroke fill" x="17" y="16" width="6" height="18" rx="1.5" stroke-width="2"/></svg>`,
  boretester: `<svg viewBox="0 0 40 40"><rect class="stroke fill" x="4" y="11" width="32" height="18" rx="2.5" stroke-width="2"/><circle class="stroke" cx="12" cy="18" r="3" stroke-width="2"/><circle class="stroke" cx="20" cy="18" r="3.6" stroke-width="2"/><circle class="stroke" cx="28" cy="18" r="4.2" stroke-width="2"/></svg>`,
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
    label: "Goal Post",
    icon: ICON.goalpost,
    // Simpler goal post: a FLAT rectangular base (no hump) with the two raised side walls.
    // Same builder as the experimental one; it just omits the hump slider (hump -> 0).
    smoothProfile: false,
    custom: true,
    geometryKind: "goalpost",
    shape2D: goalPostShape,
    schema: [
      { key: "baseWidth", label: "Base width", min: 30, max: 120, step: 1, group: "base", unit: "mm", def: 70 },
      { key: "baseLength", label: "Base length", min: 10, max: 120, step: 1, group: "base", unit: "mm", def: 40 },
      { key: "wallHeight", label: "Side-wall height", min: 0, max: 45, step: 0.5, group: "walls", unit: "mm", def: 30 },
      { key: "wallCorner", label: "Inside corner curve", min: 0, max: 20, step: 0.5, group: "walls", unit: "mm", def: 5 },
      // Front-to-back length of the walls, capped to the base length.
      { key: "wallLength", label: "Side-wall length", min: 10, max: 120, step: 1, group: "walls", unit: "mm", def: 25, fitFn: (p) => p.baseLength },
    ],
    // 21 mm is exactly what a 20 mm stem holds; 22 used to be requested and quietly trimmed.
    defaults: { stemDia: 14, stemHeight: 20, boreDepth: 21 },
    // Placeholder profile so the store stays valid; the custom builder ignores it.
    buildOuterProfile(p) {
      const S = goalPostShape(p);
      return [{ x: 0, y: S.stemTopY }, { x: S.stemR, y: 0, lockY: true }];
    },
  },

  {
    id: "goalpost2",
    label: "Goal Post 2",
    icon: ICON.goalpost2,
    // Oval "Pringles" saddle base (walls hidden for now — work in progress).
    smoothProfile: false,
    custom: true,
    geometryKind: "goalpostoval",
    shape2D: gpOvalShape,
    schema: [
      { key: "baseWidth", label: "Base width", min: 40, max: 130, step: 1, group: "base", unit: "mm", def: 84 },
      { key: "baseLength", label: "Base length", min: 20, max: 90, step: 1, group: "base", unit: "mm", def: 56 },
      { key: "palmRest", label: "Palm Rest", min: 0, max: 20, step: 0.5, group: "base", unit: "mm", def: 10 },
      { key: "sideBend", label: "Side bend", min: 0, max: 20, step: 0.5, group: "base", unit: "mm", def: 4 },
      { key: "wallHeight", label: "Side-wall height", min: 0, max: 45, step: 0.5, group: "walls", unit: "mm", def: 26 },
      { key: "wallLength", label: "Side-wall length", min: 8, max: 90, step: 1, group: "walls", unit: "mm", def: 26, fitFn: (p) => p.baseLength },
      { key: "tabStick", label: "Side Wall Width", min: 9, max: 45, step: 1, group: "walls", unit: "mm", def: 12 },
      { key: "wallCorner", label: "Wall inner curve", min: 0, max: 44, step: 0.5, group: "walls", unit: "mm", def: 2, fitFn: (p) => p.wallHeight - 0.5 },
    ],
    defaults: { stemDia: 14, stemHeight: 24, boreDepth: 18 },
    buildOuterProfile(p) {
      const S = gpOvalShape(p);
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
      { key: "thickness", label: "Handle thickness", min: 12, max: 40, step: 0.5, group: "handle", unit: "mm", def: 22 },
      { key: "length", label: "Handle length", min: 40, max: 130, step: 1, group: "handle", unit: "mm", def: 82 },
      { key: "endDroop", label: "End droop", min: 0, max: 25, step: 0.5, group: "handle", unit: "mm", def: 5 },
      { key: "endTaper", label: "End taper", min: 0, max: 1, step: 0.05, group: "handle", unit: "x", def: 0.4 },
    ],
    defaults: { stemDia: 14, stemHeight: 18, boreDepth: 18 },
    buildOuterProfile(p) {
      const S = tbarShape(p);
      return [{ x: 0, y: S.stemTopY }, { x: S.stemR, y: 0, lockY: true }];
    },
  },

  {
    id: BORE_TESTER_ID,
    label: "Bore Tester",
    icon: ICON.boretester,
    // Not a handle style — reached from the "Print a fit tester" button in the Mounting
    // Hole panel, so it stays out of the style picker.
    hidden: true,
    bare: true,       // its own sliders only: no stem, no single bore, no edge rounding
    noProfile: true,  // a flat plate has no meaningful revolved cross-section
    unitMarked: true, // its labels are embossed, so mm/in genuinely reshapes the part
    flatThickness: PLATE_THICKNESS, // a plate, not a handle: no diameter, fixed thickness
    smoothProfile: false,
    custom: true,
    geometryKind: "boretester",
    // One decision: the size you're aiming at. Everything else about the plate is fixed.
    // Derived from the handle bore slider rather than restated, so the two can never drift
    // apart — the number you read off the plate has to be typeable into "Hole diameter".
    schema: [
      { ...BORE_DIA, label: "Target hole diameter" },
    ],
    // Entering the tester brings the bore you were designing across as the target.
    seedFor: (params) => ({ boreDia: params.boreDia }),
    fileName: (params, unit) => testerFileName(params.boreDia, unit),
    // Placeholder so the store stays valid. Nothing reads it: the custom builder ignores
    // profilePoints, the editor is hidden, and boreTopY is only reached via a boreDepth
    // param this bare schema does not define.
    buildOuterProfile() {
      return [{ x: 0, y: 1 }, { x: 0.5, y: 0, lockY: true }];
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
// `bare` models (the Bore Tester) aren't handles and define their own complete schema.
export function fullSchema(model) {
  if (model.bare) return model.schema;
  const rounding = model.edgeRoundMax ? COMMON_SHAPE : [];
  return [...model.schema, ...rounding, ...STEM_PARAMS, ...BORE_PARAMS];
}

export function getModel(id) {
  return MODELS.find((m) => m.id === id) || MODELS[0];
}

export { MODELS };
