import * as THREE from "three";

const RADIAL_SEGMENTS = 96;
const SMOOTH_SAMPLES = 80;

const MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x3a4654,
  roughness: 0.55,
  metalness: 0.05,
});

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
 * Resample the outer silhouette with a Catmull-Rom spline for smooth shapes.
 * Endpoints are preserved; the first sample is pinned to the axis (x = 0).
 */
function smoothOuter(points) {
  const v3 = points.map((p) => new THREE.Vector3(p.x, p.y, 0));
  const curve = new THREE.CatmullRomCurve3(v3, false, "catmullrom", 0.5);
  const sampled = curve.getPoints(SMOOTH_SAMPLES).map((v) => ({
    x: Math.max(0, v.x),
    y: v.y,
  }));
  sampled[0].x = 0; // keep top cap exactly on the axis
  return sampled;
}

/**
 * Assemble the full closed cross-section (radius vs height) and revolve it.
 *
 * outer:  head + stem silhouette, top-on-axis -> (stemR, 0)
 * + bore: (boreR,0) -> (boreR, ceil) -> (0, ceil)   [blind mounting hole]
 *
 * Because the first point (top, x=0) and the last point (bore ceiling, x=0) both
 * lie on the axis, LatheGeometry produces a watertight, manifold solid — no CSG.
 */
export function buildKnobGeometry(model, params, profilePoints) {
  const outerRaw = model.smoothProfile ? smoothOuter(profilePoints) : profilePoints;
  const outer = dedupe(outerRaw);

  const topY = outer[0].y;
  const stemR = Math.max(outer[outer.length - 1].x, 0.5);

  // Bore: clamp so a wall remains around and above the hole.
  const boreR = Math.min(Math.max(params.boreDia / 2, 0.4), stemR - 1.2);
  const boreCeil = Math.min(Math.max(params.boreDepth, 2), topY - 3);

  const section = outer.map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
  if (boreR > 0.4) {
    section.push(new THREE.Vector2(boreR, 0));
    section.push(new THREE.Vector2(boreR, boreCeil));
    section.push(new THREE.Vector2(0, boreCeil));
  } else {
    // No usable bore — close the bottom on the axis instead.
    section.push(new THREE.Vector2(0, 0));
  }

  const geometry = new THREE.LatheGeometry(section, RADIAL_SEGMENTS, 0, Math.PI * 2);

  // I-Handle lean: shear everything above the stem so the grip tilts while the
  // stem + lower bore stay vertical for mounting.
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

  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

/** Build a ready-to-display mesh for the current model/params/profile. */
export function buildKnobMesh(model, params, profilePoints) {
  const geometry = buildKnobGeometry(model, params, profilePoints);
  const mesh = new THREE.Mesh(geometry, MATERIAL);
  return mesh;
}

/** Bounding-box dimensions in mm: { width, depth, height }. */
export function meshDimensions(geometry) {
  const b = geometry.boundingBox;
  return {
    width: b.max.x - b.min.x,
    depth: b.max.z - b.min.z,
    height: b.max.y - b.min.y,
  };
}
