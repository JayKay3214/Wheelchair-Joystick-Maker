/**
 * Bore fit tester — a flat rectangular test coupon with one true through-hole per candidate
 * diameter, each with its size raised beside it in 7-segment digits. Print it, find the hole
 * that grips the controller stem the way you want, then type that number into the handle's
 * "Hole diameter".
 *
 * This module owns the whole 2D description of the plate: which sizes, how they are laid
 * out, how the digits are drawn. geometry.js turns that description into a mesh and knows
 * nothing about typography; models.js carries only the registry entry.
 */

import { MM_PER_IN } from "./units.js";

// The sweep is fixed rather than exposed as sliders: target ±0.4 mm in 0.1 mm steps covers
// the adjustment range this tool tells you to try with a step to spare at each end, and it
// keeps the tester a one-decision job — set the size you're aiming at, print, read the
// winner off the plate. Widening the sweep is a matter of changing these two numbers.
// Nine also happens to tile as a perfect 3x3, which is why it beats seven: same plate size,
// no half-empty row, two extra sizes free.
export const SIZE_STEP = 0.1;  // mm between adjacent sizes
export const SIZE_COUNT = 9;   // odd, so the target lands dead centre

// Plate proportions. All fixed: they suit any printer, and none of them change what the
// test actually measures.
export const PLATE_THICKNESS = 8; // how much bore the stem engages
const HOLE_GAP = 6;      // material between neighbouring holes
const LABEL_HEIGHT = 5;  // label cap height
const LABEL_RAISE = 0.6; // how far the labels stand off the plate
const LABEL_SINK = 0.3;  // how far they sink in, so label and plate fuse into one solid
const CORNER_R = 3;      // plate corner radius
// Cost added per empty cell when picking the grid, in units of aspect ratio. Enough to
// break a near-tie toward a grid that comes out full (nine lands on an exact 3x3).
const EMPTY_CELL_COST = 0.15;

// Label precision, per unit, chosen so two adjacent holes can never print the same number.
// Both derive from the step: in inches a 0.1 mm step is only 0.0039", so 2 dp would collapse
// nine sizes onto four labels. 3 dp keeps them distinct AND survives the round trip back into
// Hole diameter, whose 0.05 mm snap absorbs the 0.0005" (0.0127 mm) rounding error.
const LABEL_DP_MM = Math.max(2, Math.ceil(-Math.log10(SIZE_STEP)));
const LABEL_DP_IN = Math.max(3, Math.ceil(-Math.log10(SIZE_STEP / MM_PER_IN)));

/**
 * The candidate diameters, ascending, centred on the target. A size that would come out
 * below 0.5 mm is DROPPED rather than clamped: clamping would emit several holes of the
 * same diameter carrying the same label, which is exactly the confusion this tool exists
 * to remove. Unreachable at the shipped SIZE_COUNT — it only bites if the sweep is widened.
 */
function testerSizes(targetDia) {
  const out = [];
  for (let i = 0; i < SIZE_COUNT; i++) {
    const d = targetDia + (i - (SIZE_COUNT - 1) / 2) * SIZE_STEP;
    if (d >= 0.5) out.push(parseFloat(d.toFixed(3)));
  }
  // A target small enough to drop every size would leave nothing to lay out; keep the
  // target itself so the plate is always buildable.
  return out.length ? out : [targetDia];
}

/**
 * Label text for a diameter, in the unit currently on screen — the number you read off the
 * printed plate has to be the number you can type straight into Hole diameter.
 */
export function sizeLabel(d, unit = "mm") {
  return unit === "in" ? (d / MM_PER_IN).toFixed(LABEL_DP_IN) : d.toFixed(LABEL_DP_MM);
}

/** Export filename: the range, in whatever unit the plate is marked in. */
export function testerFileName(targetDia, unit = "mm") {
  const sizes = testerSizes(targetDia);
  const range = `${sizeLabel(sizes[0], unit)}-${sizeLabel(sizes[sizes.length - 1], unit)}`;
  return `bore-test_${range}${unit}_step${sizeLabel(SIZE_STEP, unit)}`;
}

// ---- 7-segment digits ----------------------------------------------------------
// No font file to load (the app stays buildless), legible down to ~3 mm, and every stroke
// is a rectangle so it slices and prints cleanly.

const SEG7 = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};

/** Stroke proportions for a digit of a given cap height. */
function glyphMetrics(height) {
  return { height, width: height * 0.58, stroke: height * 0.17, gap: height * 0.16 };
}

/** Width of a rendered label, used to size the cells the plate is laid out from. */
function textWidth(text, height) {
  const g = glyphMetrics(height);
  let w = 0;
  for (const ch of text) w += (ch === "." ? g.stroke : g.width) + g.gap;
  return Math.max(0, w - g.gap);
}

/** The chosen segments as [u0,v0,u1,v1] rectangles in glyph space (0..width, 0..height). */
function segmentRects(g, keys) {
  const { width: w, height: h, stroke: t } = g;
  const m = (h - t) / 2; // underside of the middle bar
  // Horizontal bars are inset at their ends by q: they still overlap the vertical bars (so
  // each digit fuses into one solid) but no two segments share an exact vertex, which would
  // otherwise turn the STEP export's closed shells into open ones.
  const q = t * 0.35;
  const R = {
    a: [q, h - t, w - q, h],
    g: [q, m, w - q, m + t],
    d: [q, 0, w - q, t],
    f: [0, m, t, h],
    b: [w - t, m, w, h],
    e: [0, 0, t, m + t],
    c: [w - t, 0, w, m + t],
  };
  return [...keys].map((k) => R[k]);
}

/**
 * Every rectangle making up one label, in plate space: centred on `centreU` with its
 * baseline at `baseV`. geometry.js extrudes each of these into a raised box.
 */
function labelRects(text, height, centreU, baseV) {
  const g = glyphMetrics(height);
  const out = [];
  let u = centreU - textWidth(text, height) / 2;
  for (const ch of text) {
    if (ch === ".") {
      out.push({ u0: u, v0: baseV, u1: u + g.stroke, v1: baseV + g.stroke });
      u += g.stroke + g.gap;
    } else {
      for (const [du0, dv0, du1, dv1] of segmentRects(g, SEG7[ch] || "")) {
        out.push({ u0: u + du0, v0: baseV + dv0, u1: u + du1, v1: baseV + dv1 });
      }
      u += g.width + g.gap;
    }
  }
  return out;
}

// ---- plate layout ---------------------------------------------------------------

/**
 * The column count whose grid comes out closest to square. Cells are usually wider than
 * they are deep — the label sets the width, not the hole — so this isn't ceil(sqrt(n)).
 */
function squarestColumnCount(n, cellW, cellH) {
  let best = n, bestScore = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = cols * cellW, d = rows * cellH;
    const score = Math.max(w, d) / Math.min(w, d) + (cols * rows - n) * EMPTY_CELL_COST;
    if (score < bestScore) { bestScore = score; best = cols; }
  }
  return best;
}

/**
 * Plate layout. Cells run left-to-right, smallest first, in the grid that comes out closest
 * to SQUARE — a long thin coupon overruns small beds (a row of nine would be 160 mm) and
 * lifts at the corners. Each cell holds one hole with its label underneath. Everything is in
 * "plate space": u = across (+ right), v = up the page (+ toward the back of the print),
 * origin at the plate centre.
 */
export function testerPlate(targetDia, unit = "mm") {
  const sizes = testerSizes(targetDia);
  const n = sizes.length;
  const maxDia = Math.max(...sizes);
  // Inch labels are a character longer ("0.248" vs "6.30"), so the cells — and the plate —
  // size themselves around whichever text is actually going to be embossed.
  const labelW = Math.max(...sizes.map((d) => textWidth(sizeLabel(d, unit), LABEL_HEIGHT)));

  // A cell is as wide as its widest content plus one full gap, so neighbouring holes always
  // keep at least `gap` of material between them (half that at the plate edge).
  const cellW = Math.max(maxDia, labelW) + HOLE_GAP;
  const cellH = maxDia + LABEL_HEIGHT + 1.5 * HOLE_GAP;

  const cols = squarestColumnCount(n, cellW, cellH);
  const rows = Math.ceil(n / cols);
  const plateW = cols * cellW;
  const plateD = rows * cellH;

  const cells = sizes.map((d, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inRow = Math.min(cols, n - row * cols); // last row may be short — centre it
    const u = -(inRow * cellW) / 2 + (col + 0.5) * cellW;
    const vTop = plateD / 2 - row * cellH;
    return {
      dia: d,
      label: sizeLabel(d, unit),
      holeU: u,
      holeV: vTop - HOLE_GAP / 2 - maxDia / 2,
      // Finished label geometry: u is the hole's centre, so the text sits under it.
      rects: labelRects(sizeLabel(d, unit), LABEL_HEIGHT, u, vTop - cellH + HOLE_GAP / 2),
    };
  });

  return {
    cells, plateW, plateD,
    thickness: PLATE_THICKNESS,
    cornerR: CORNER_R,
    labelRaise: LABEL_RAISE,
    labelSink: LABEL_SINK,
  };
}
