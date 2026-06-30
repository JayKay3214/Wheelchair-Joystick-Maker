import * as THREE from "three";

const RADIAL_SEGMENTS = 96;
const STEP_SEGMENTS = 64; // coarser facets keep STEP file size reasonable
const SMOOTH_SAMPLES = 80;

// Shared material so a view-mode change (Solid / Inside) applies to every rebuild.
export const material = new THREE.MeshStandardMaterial({
  color: 0x3a4654,
  roughness: 0.55,
  metalness: 0.05,
  side: THREE.FrontSide,
});

export { RADIAL_SEGMENTS, STEP_SEGMENTS };

/** Remove consecutive points that sit on top of each other (degenerate lathe faces). */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-4) out.push(p);
  }
  return out;
}

/** General Bezier (de Casteljau) sampled into N+1 points. */
function bezier(ctrl, N) {
  const out = [];
  for (let st = 0; st <= N; st++) {
    const t = st / N;
    const tmp = ctrl.map((p) => ({ x: p.x, y: p.y }));
    for (let k = tmp.length - 1; k > 0; k--) {
      for (let j = 0; j < k; j++) {
        tmp[j].x += (tmp[j + 1].x - tmp[j].x) * t;
        tmp[j].y += (tmp[j + 1].y - tmp[j].y) * t;
      }
    }
    out.push({ x: tmp[0].x, y: tmp[0].y });
  }
  return out;
}

/**
 * Round sharp corners of the outer silhouette with arc-length-based fillets.
 *
 * Unlike a naive per-corner chamfer, the fillet size is measured along the curve's
 * arc length, so a dense polyline (the Chin Cup bowl) no longer chokes the radius.
 * Runs of nearby corners (e.g. the I-Handle's stem/head shoulder) are clustered and
 * blended into a single smooth transition. Endpoints (top-on-axis and the point on
 * the bed) are preserved, and the bore is added later, so it is never affected.
 */
function roundCorners(points, r) {
  if (r <= 0.01 || points.length < 3) return points;
  const n = points.length;
  const s = [0];
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);

  const sharp = new Array(n).fill(false);
  for (let i = 1; i < n - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2))));
    if (ang < Math.PI - 0.3) sharp[i] = true; // turn sharper than ~17 deg
  }

  // Cluster adjacent sharp corners sitting within r of each other.
  const clusters = [];
  for (let i = 1; i < n - 1; i++) {
    if (!sharp[i]) continue;
    let j = i;
    while (j + 1 < n - 1 && sharp[j + 1] && s[j + 1] - s[j] < r) j++;
    clusters.push([i, j]);
    i = j;
  }
  if (!clusters.length) return points;

  const at = (q) => {
    if (q <= 0) return { x: points[0].x, y: points[0].y };
    if (q >= s[n - 1]) return { x: points[n - 1].x, y: points[n - 1].y };
    let k = 1;
    while (k < n && s[k] < q) k++;
    const t = (q - s[k - 1]) / ((s[k] - s[k - 1]) || 1);
    return { x: points[k - 1].x + (points[k].x - points[k - 1].x) * t, y: points[k - 1].y + (points[k].y - points[k - 1].y) * t };
  };

  const out = [];
  let cursor = 0;
  for (let ci = 0; ci < clusters.length; ci++) {
    const [i0, i1] = clusters[ci];
    const prevLimit = ci > 0 ? s[clusters[ci - 1][1]] : 0;
    const nextLimit = ci < clusters.length - 1 ? s[clusters[ci + 1][0]] : s[n - 1];
    // Half the gap to a neighbouring corner (so fillets never overlap); the full gap
    // toward an endpoint (lets a big radius dome the top / blend the shoulder to base).
    const dBack = Math.min(r, (s[i0] - prevLimit) * (ci > 0 ? 0.5 : 1));
    const dFwd = Math.min(r, (nextLimit - s[i1]) * (ci < clusters.length - 1 ? 0.5 : 1));
    const sT1 = s[i0] - dBack, sT2 = s[i1] + dFwd;
    while (cursor < n && s[cursor] < sT1 - 1e-9) { out.push(points[cursor]); cursor++; }
    const ctrl = [at(sT1)];
    for (let k = i0; k <= i1; k++) ctrl.push(points[k]);
    ctrl.push(at(sT2));
    for (const p of bezier(ctrl, 6 + (i1 - i0) * 4)) out.push(p);
    while (cursor < n && s[cursor] <= sT2 + 1e-9) cursor++;
  }
  while (cursor < n) { out.push(points[cursor]); cursor++; }
  return out;
}

/** Resample the outer silhouette with a Catmull-Rom spline for smooth shapes. */
function smoothOuter(points) {
  const v3 = points.map((p) => new THREE.Vector3(p.x, p.y, 0));
  const curve = new THREE.CatmullRomCurve3(v3, false, "catmullrom", 0.5);
  const sampled = curve.getPoints(SMOOTH_SAMPLES).map((v) => ({ x: Math.max(0, v.x), y: v.y }));
  sampled[0].x = 0; // keep top cap exactly on the axis
  return sampled;
}

/** Flip triangle winding if the solid came out inside-out (inward normals). */
function ensureOutwardWinding(geometry) {
  const pos = geometry.attributes.position;
  let maxR = -1, idx = 0;
  for (let i = 0; i < pos.count; i++) {
    const r = pos.getX(i) ** 2 + pos.getZ(i) ** 2;
    if (r > maxR) { maxR = r; idx = i; }
  }
  geometry.computeVertexNormals();
  const n = geometry.attributes.normal;
  if (n.getX(idx) * pos.getX(idx) + n.getZ(idx) * pos.getZ(idx) < 0) {
    const a = geometry.index.array;
    for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; }
    geometry.index.needsUpdate = true;
    geometry.computeVertexNormals();
  }
}

/**
 * Assemble the full closed cross-section (radius vs height) and revolve it.
 * The first point (top, x=0) and the last (bore ceiling, x=0) lie on the axis,
 * so LatheGeometry yields a watertight, manifold solid — no CSG.
 */
export function buildKnobGeometry(model, params, profilePoints, opts = {}) {
  const segments = opts.segments || RADIAL_SEGMENTS;
  const rounded = roundCorners(profilePoints, params.edgeRound || 0);
  const outerRaw = model.smoothProfile ? smoothOuter(rounded) : rounded;
  const outer = dedupe(outerRaw);

  const topY = outer[0].y;
  const stemR = Math.max(outer[outer.length - 1].x, 0.5);

  const boreR = Math.min(Math.max(params.boreDia / 2, 0.4), stemR - 1.2);
  const boreCeil = Math.min(Math.max(params.boreDepth, 2), topY - 3);

  const section = outer.map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
  if (boreR > 0.4) {
    section.push(new THREE.Vector2(boreR, 0));
    section.push(new THREE.Vector2(boreR, boreCeil));
    section.push(new THREE.Vector2(0, boreCeil));
  } else {
    section.push(new THREE.Vector2(0, 0));
  }

  const geometry = new THREE.LatheGeometry(section, segments, 0, Math.PI * 2);

  // I-Handle lean: shear the OUTER head above the stem. The mounting bore (the last
  // section points) and the stem are left vertical so the part still slides onto the
  // controller stem. LatheGeometry vertex index -> section point is (index % sectionLen).
  if (model.tiltKey && params[model.tiltKey] > 0) {
    const baseY = params.stemHeight;
    const k = Math.tan((params[model.tiltKey] * Math.PI) / 180);
    const sectionLen = section.length;
    const outerLen = outer.length;
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (i % sectionLen >= outerLen) continue; // bore vertex -> keep vertical
      const y = pos.getY(i);
      if (y > baseY) pos.setX(i, pos.getX(i) + k * (y - baseY));
    }
    pos.needsUpdate = true;
  }

  ensureOutwardWinding(geometry);
  geometry.computeBoundingBox();
  return geometry;
}

/** Build a ready-to-display mesh for the current model/params/profile. */
export function buildKnobMesh(model, params, profilePoints) {
  return new THREE.Mesh(buildKnobGeometry(model, params, profilePoints), material);
}

/** Bounding-box dimensions in mm: { width, depth, height }. */
export function meshDimensions(geometry) {
  const b = geometry.boundingBox;
  return { width: b.max.x - b.min.x, depth: b.max.z - b.min.z, height: b.max.y - b.min.y };
}
