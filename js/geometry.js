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

/**
 * Round the sharp corners of the outer silhouette with tangent fillets.
 * Endpoints (top-on-axis and the point on the bed) are preserved. The bore is
 * added later, so it is never affected.
 */
function roundCorners(points, r) {
  if (r <= 0.01 || points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const p0 = points[i - 1], p1 = points[i], p2 = points[i + 1];
    const v1x = p0.x - p1.x, v1y = p0.y - p1.y;
    const v2x = p2.x - p1.x, v2y = p2.y - p1.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-3 || l2 < 1e-3) { out.push(p1); continue; }
    const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (ang > Math.PI * 0.96) { out.push(p1); continue; } // already ~straight
    const d = Math.min(r, l1 * 0.5, l2 * 0.5);
    const t1 = { x: p1.x + (v1x / l1) * d, y: p1.y + (v1y / l1) * d };
    const t2 = { x: p1.x + (v2x / l2) * d, y: p1.y + (v2y / l2) * d };
    out.push(t1);
    for (let k = 1; k < 4; k++) {
      const t = k / 4, mt = 1 - t;
      out.push({
        x: mt * mt * t1.x + 2 * mt * t * p1.x + t * t * t2.x,
        y: mt * mt * t1.y + 2 * mt * t * p1.y + t * t * t2.y,
      });
    }
    out.push(t2);
  }
  out.push(points[points.length - 1]);
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

  // I-Handle lean: shear above the stem; stem + lower bore stay vertical for mounting.
  if (model.tiltKey && params[model.tiltKey] > 0) {
    const baseY = params.stemHeight;
    const k = Math.tan((params[model.tiltKey] * Math.PI) / 180);
    const pos = geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
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
