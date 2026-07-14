import * as THREE from "three";
import { goalPostShape, gpTopHeight, gpHalfWidthAt, gpOvalShape, gpOvalHalfWidth, gpOvalMid, tbarShape, tbarCenterY, tbarScale } from "./models.js";

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

/** Concatenate geometries into one non-indexed BufferGeometry, preserving each part's
 * own normals (so a smooth-shaded part stays smooth and a faceted part stays faceted). */
function mergeGeoms(list) {
  const geos = list.map((g) => {
    if (!g.attributes.normal) g.computeVertexNormals();
    return g.index ? g.toNonIndexed() : g;
  });
  let tp = 0;
  for (const g of geos) tp += g.attributes.position.array.length;
  const pos = new Float32Array(tp), nor = new Float32Array(tp);
  let off = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, off);
    nor.set(g.attributes.normal.array, off);
    off += g.attributes.position.array.length;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return out;
}

/**
 * The whole goal-post head (base slab + raised side walls) as ONE watertight heightfield
 * solid: a top grid (height from gpTopHeight, which already includes the raised walls), a
 * flat bottom grid, and a rim joining them. The walls are just the taller parts of the top
 * surface, so there are no separate/overlapping solids and nothing to z-fight.
 *
 * Winding is correct by construction: the top grid is wound +Y (up) and the bottom -Y
 * (down); the four rim strips are oriented per-quad to face away from the vertical axis.
 */
function buildHead(P) {
  const halfD = P.halfD;
  const nx = Math.max(50, Math.min(120, Math.round(P.halfW * 2 * 1.3)));
  const nz = Math.max(60, Math.min(140, Math.round(halfD * 2 * 1.6))); // extra z-res for the corner arcs
  // Each z-row spans the footprint half-width at that depth (rounded-rectangle corners), so
  // the grid is warped to the rounded outline while every row keeps nx+1 evenly-spaced columns.
  const zAt = (j) => -halfD + (2 * halfD * j) / nz;
  const pos = [];
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      const z = zAt(j), hw = gpHalfWidthAt(P, z), x = -hw + (2 * hw * i) / nx;
      pos.push(x, gpTopHeight(P, x, z), z);
    }
  }
  const topV = (nx + 1) * (nz + 1);
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      const z = zAt(j), hw = gpHalfWidthAt(P, z), x = -hw + (2 * hw * i) / nx;
      pos.push(x, P.B0, z);
    }
  }
  const id = (i, j) => i * (nz + 1) + j, bid = (i, j) => topV + i * (nz + 1) + j;
  const idx = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    idx.push(id(i, j), id(i + 1, j + 1), id(i + 1, j), id(i, j), id(i, j + 1), id(i + 1, j + 1));       // top (+Y)
    idx.push(bid(i, j), bid(i + 1, j), bid(i + 1, j + 1), bid(i, j), bid(i + 1, j + 1), bid(i, j + 1)); // bottom (-Y)
  }
  // Rim strips: orient each quad's two triangles to face away from the Y axis.
  const at = (a) => [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]];
  const addRim = (t0, t1, b0, b1) => {
    const A = at(t0), C = at(b0), D = at(b1);
    const ux = C[0] - A[0], uy = C[1] - A[1], uz = C[2] - A[2];
    const wx = D[0] - A[0], wy = D[1] - A[1], wz = D[2] - A[2];
    const nx2 = uy * wz - uz * wy, nz2 = ux * wy - uy * wx; // horizontal normal of tri (t0,b0,b1)
    const cx = (A[0] + at(t1)[0] + C[0] + D[0]) / 4, cz = (A[2] + at(t1)[2] + C[2] + D[2]) / 4;
    if (nx2 * cx + nz2 * cz >= 0) idx.push(t0, b0, b1, t0, b1, t1);
    else idx.push(t0, b1, b0, t0, t1, b1);
  };
  for (let i = 0; i < nx; i++) { addRim(id(i, 0), id(i + 1, 0), bid(i, 0), bid(i + 1, 0)); addRim(id(i, nz), id(i + 1, nz), bid(i, nz), bid(i + 1, nz)); }
  for (let j = 0; j < nz; j++) { addRim(id(0, j), id(0, j + 1), bid(0, j), bid(0, j + 1)); addRim(id(nx, j), id(nx, j + 1), bid(nx, j), bid(nx, j + 1)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Goal-post: the head (base + raised side walls, one watertight solid) fused with a bored
 * central stem. Only the stem is a separate part; it overlaps the base bottom internally.
 */
function buildGoalPost(params, opts = {}) {
  const segments = Math.min(opts.segments || RADIAL_SEGMENTS, 72);
  const P = goalPostShape(params);
  const head = buildHead(P);
  const stem = buildStem(P, segments);
  const geometry = mergeGeoms([head, stem]);
  geometry.computeBoundingBox();
  head.dispose();
  stem.dispose();
  return geometry;
}

/** Goal Post Experimental: an oval "Pringles" saddle slab (curved top AND bottom over an
 * elliptical footprint) fused with a bored central stem. Winding is correct by construction:
 * top grid wound +Y, bottom -Y, rim strips oriented per-quad away from the vertical axis. */
// The whole head as ONE watertight solid: a smooth elliptical saddle slab, PLUS an explicitly
// built tab+wall prism on each widest side. The prism shares the oval's edge line (so no seam)
// but has clean straight ends + a straight vertical wall (an L cross-section), which the warped
// grid alone can't produce at the tab-to-ellipse transition.
function buildOvalBase(P) {
  const halfD = P.halfD;
  const hasWall = P.wallHeight > 0.1 && P.wallLen > 1;
  const half = P.wallLen / 2;
  const T = []; // non-indexed triangle soup (watertightness verified by quantised coords)
  const cross = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  // push one triangle, winding it so its normal points toward `out`
  const tri = (a, b, c, out) => {
    const n = cross(a, b, c);
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] >= 0) T.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    else T.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
  };
  const quad = (a, b, c, d, out) => { tri(a, b, c, out); tri(a, c, d, out); };
  const UP = [0, 1, 0], DN = [0, -1, 0];
  const eT = (x, z) => [x, gpOvalMid(P, x, z) + P.halfThick, z]; // oval top surface point
  const eB = (x, z) => [x, gpOvalMid(P, x, z) - P.halfThick, z]; // oval bottom surface point

  // ---- z-sample rows (land exactly on +/-half so the tab attaches on clean rows) ----
  let zs = [];
  const nz = Math.max(60, Math.min(180, Math.round(halfD * 2 * 2.0)));
  for (let j = 0; j <= nz; j++) zs.push(-halfD + (2 * halfD * j) / nz);
  if (hasWall) zs.push(-half, half);
  zs = [...new Set(zs)].filter((z) => z >= -halfD - 1e-9 && z <= halfD + 1e-9).sort((a, b) => a - b);
  const nx = Math.max(40, Math.min(120, Math.round(P.halfW * 2 * 1.4)));
  const inTabRow = (z0, z1) => hasWall && z0 >= -half - 1e-9 && z1 <= half + 1e-9;

  // ---- elliptical saddle slab: top + bottom surfaces ----
  for (let j = 0; j < zs.length - 1; j++) {
    const z0 = zs[j], z1 = zs[j + 1], hw0 = gpOvalHalfWidth(P, z0), hw1 = gpOvalHalfWidth(P, z1);
    for (let i = 0; i < nx; i++) {
      const x0a = -hw0 + (2 * hw0 * i) / nx, x0b = -hw0 + (2 * hw0 * (i + 1)) / nx;
      const x1a = -hw1 + (2 * hw1 * i) / nx, x1b = -hw1 + (2 * hw1 * (i + 1)) / nx;
      quad(eT(x0a, z0), eT(x0b, z0), eT(x1b, z1), eT(x1a, z1), UP);
      quad(eB(x0a, z0), eB(x0b, z0), eB(x1b, z1), eB(x1a, z1), DN);
    }
  }
  // ---- slab rim: front/back ends (all z-caps), plus the +/-x sides EXCEPT where a tab attaches ----
  for (const end of [[zs[0], -1], [zs[zs.length - 1], 1]]) {
    const z = end[0], hw = gpOvalHalfWidth(P, z), out = [0, 0, end[1]];
    for (let i = 0; i < nx; i++) {
      const xa = -hw + (2 * hw * i) / nx, xb = -hw + (2 * hw * (i + 1)) / nx;
      quad(eT(xa, z), eT(xb, z), eB(xb, z), eB(xa, z), out);
    }
  }
  for (let j = 0; j < zs.length - 1; j++) {
    const z0 = zs[j], z1 = zs[j + 1];
    if (inTabRow(z0, z1)) continue; // the tab prism closes this side here
    for (const sgn of [-1, 1]) {
      const xa = sgn * gpOvalHalfWidth(P, z0), xb = sgn * gpOvalHalfWidth(P, z1);
      quad(eT(xa, z0), eT(xb, z1), eB(xb, z1), eB(xa, z0), [sgn, 0, 0]);
    }
  }

  // ---- tab + wall prism on each side, sharing the oval edge line ----
  // Cross-section is an ordered point list from the inner-bottom around the outside to the
  // inner-top; the closing edge (inner-top -> inner-bottom) is the shared oval edge (no face).
  // A quarter-circle fillet optionally rounds the inner corner where the shelf meets the wall.
  if (hasWall) {
    const tabRows = zs.filter((z) => z >= -half - 1e-9 && z <= half + 1e-9);
    // quarter-ellipse fillet: rx across the shelf, ry up the wall. Segments scale with the larger
    // radius (~0.8mm each) so a big sweep stays smooth, not faceted.
    const rx = P.wallCurveX, ry = P.wallCurve, NARC = ry > 0.05 ? Math.max(6, Math.min(64, Math.round(ry * 1.9))) : 0;
    for (const sgn of [1, -1]) {
      const prof = (z) => {
        const hw = gpOvalHalfWidth(P, z), em = gpOvalMid(P, sgn * hw, z);
        const topE = em + P.halfThick, botE = em - P.halfThick; // oval edge (shared, may rise at ends)
        // Shelf TOP droops with the base edge at this depth (stays attached -> no cutoff). Wall TOP
        // is flat (P.wallTopY). Tab BOTTOM is flat (P.shelfBotY) but clamped to keep >=5mm of tab so
        // it never inverts under heavy droop -- this removes the drooping fang on the underside.
        const topF = gpOvalMid(P, P.halfW, z) + P.halfThick;
        const botF = Math.min(P.shelfBotY, topF - 5);
        const pts = [];
        pts.push([sgn * hw, botE]);                    // inner bottom (shared)
        pts.push([sgn * P.tabOuter, botF]);            // outer bottom (flat)
        pts.push([sgn * P.tabOuter, topF]);            // outer tip at shelf level
        pts.push([sgn * P.tabOuter, P.wallTopY]);      // outer top (flat)
        pts.push([sgn * P.wallBandInner, P.wallTopY]); // wall inner top (flat)
        if (ry > 0.05) {                               // rounded inner corner: down the wall, arc onto the shelf
          pts.push([sgn * P.wallBandInner, topF + ry]); // fillet top, on the wall face (arc angle 0)
          const ccx = P.wallBandInner - rx, ccy = topF + ry; // arc centre (unsigned x)
          for (let a = 1; a < NARC; a++) { const th = -(Math.PI / 2) * (a / NARC); pts.push([sgn * (ccx + rx * Math.cos(th)), ccy + ry * Math.sin(th)]); }
          pts.push([sgn * (P.wallBandInner - rx), topF]); // fillet bottom, on the shelf (arc angle -90)
        } else {
          pts.push([sgn * P.wallBandInner, topF]);     // sharp inner corner
        }
        pts.push([sgn * hw, topE]);                    // inner top (shared)
        return pts.map((q) => [q[0], q[1], z]);
      };
      for (let k = 0; k < tabRows.length - 1; k++) {
        const A = prof(tabRows[k]), B = prof(tabRows[k + 1]), m = A.length;
        for (let e = 0; e < m - 1; e++) {              // every edge except the closing inner edge (m-1 -> 0)
          const p0 = A[e], p1 = A[e + 1];
          // outward normal from the consistent profile winding (CCW for sgn +1, mirrored CW for -1)
          quad(p0, p1, B[e + 1], B[e], [sgn * (p1[1] - p0[1]), sgn * (p0[0] - p1[0]), 0]);
        }
      }
      for (const cap of [[prof(tabRows[0]), -1], [prof(tabRows[tabRows.length - 1]), 1]]) {
        let poly = cap[0]; const out = [0, 0, cap[1]];
        let a2 = 0; for (let i = 0; i < poly.length; i++) { const u = poly[i], v = poly[(i + 1) % poly.length]; a2 += u[0] * v[1] - v[0] * u[1]; }
        if (a2 < 0) poly = poly.slice().reverse();     // triangulateShape wants CCW
        const faces = THREE.ShapeUtils.triangulateShape(poly.map((q) => new THREE.Vector2(q[0], q[1])), []);
        for (const f of faces) tri(poly[f[0]], poly[f[1]], poly[f[2]], out);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(T, 3));
  g.computeVertexNormals();
  return g;
}

function buildGoalPostOval(params, opts = {}) {
  const segments = Math.min(opts.segments || RADIAL_SEGMENTS, 72);
  const P = gpOvalShape(params);
  const parts = [buildOvalBase(P), buildStem(P, segments)]; // base already includes the tabs+walls
  const geometry = mergeGeoms(parts);
  geometry.computeBoundingBox();
  for (const g of parts) g.dispose();
  return geometry;
}

/** Small bored stem as a solid of revolution, reused by the non-revolution heads. */
function buildStem(P, segments) {
  const sec = [
    new THREE.Vector2(0, P.stemTopY),
    new THREE.Vector2(P.stemR, P.stemTopY),
    new THREE.Vector2(P.stemR, 0),
  ];
  if (P.boreR > 0.4) {
    sec.push(new THREE.Vector2(P.boreR, 0));
    sec.push(new THREE.Vector2(P.boreR, P.boreCeil));
    sec.push(new THREE.Vector2(0, P.boreCeil));
  } else {
    sec.push(new THREE.Vector2(0, 0));
  }
  const stem = new THREE.LatheGeometry(sec, segments);
  ensureOutwardWinding(stem);
  return stem;
}

/**
 * T-Bar: a flattened-oval tube swept along the X axis (the handle) whose ends droop and
 * taper to closed tips, fused with a central bored stem. The tube is a uniform (t,theta)
 * grid; the end rings collapse to the tips (harmless degenerate quads), so winding stays
 * consistent and ensureOutwardWinding orients the whole shell.
 */
function buildTBar(params, opts = {}) {
  const segments = Math.min(opts.segments || RADIAL_SEGMENTS, 64);
  const P = tbarShape(params);
  const nt = 90, nth = segments;
  const pos = [];
  for (let i = 0; i <= nt; i++) {
    const t = -1 + (2 * i) / nt;
    const cx = t * P.halfL, cy = tbarCenterY(P, t), s = tbarScale(P, t);
    for (let j = 0; j < nth; j++) {
      const th = (2 * Math.PI * j) / nth;
      pos.push(cx, cy + s * P.ry * Math.sin(th), s * P.rz * Math.cos(th));
    }
  }
  const idx = [];
  for (let i = 0; i < nt; i++) {
    for (let j = 0; j < nth; j++) {
      const j1 = (j + 1) % nth;
      const a = i * nth + j, b = i * nth + j1, c = (i + 1) * nth + j1, d = (i + 1) * nth + j;
      idx.push(a, b, c, a, c, d);
    }
  }
  const bar = new THREE.BufferGeometry();
  bar.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  bar.setIndex(idx);
  ensureOutwardWinding(bar);

  const stem = buildStem(P, segments);
  const geometry = mergeGeoms([bar, stem]);
  geometry.computeBoundingBox();
  bar.dispose();
  stem.dispose();
  return geometry;
}

/**
 * Assemble the full closed cross-section (radius vs height) and revolve it.
 * The first point (top, x=0) and the last (bore ceiling, x=0) lie on the axis,
 * so LatheGeometry yields a watertight, manifold solid — no CSG.
 * Non-revolution models (e.g. Goal Posts, T-Bar) branch to their own builder.
 */
/**
 * The closed 2D (radius, y) cross-section that a round model revolves — the rounded/smoothed
 * outer silhouette plus the blind bore. First point (0, topY) and last (0, boreCeil or 0) lie on
 * the axis, so revolving it is watertight. Shared by the mesh builder AND the analytic STEP
 * exporter so both revolve the exact same profile. Returns null for non-revolution models.
 */
export function revolutionSection(model, params, profilePoints) {
  if (model.geometryKind === "goalpost" || model.geometryKind === "goalpostoval" || model.geometryKind === "tbar") return null;
  const rounded = roundCorners(profilePoints, params.edgeRound || 0);
  const outerRaw = model.smoothProfile ? smoothOuter(rounded) : rounded;
  const outer = dedupe(outerRaw);
  const topY = outer[0].y;
  const stemR = Math.max(outer[outer.length - 1].x, 0.5);
  const boreR = Math.min(Math.max(params.boreDia / 2, 0.4), stemR - 1.2);
  const boreCeil = Math.min(Math.max(params.boreDepth, 2), topY - 3);
  const hasBore = boreR > 0.4;
  const section = outer.map((p) => ({ x: Math.max(0, p.x), y: p.y }));
  if (hasBore) section.push({ x: boreR, y: 0 }, { x: boreR, y: boreCeil }, { x: 0, y: boreCeil });
  else section.push({ x: 0, y: 0 });
  return { section, topY, stemR, boreR, boreCeil, hasBore, outerLen: outer.length };
}

export function buildKnobGeometry(model, params, profilePoints, opts = {}) {
  if (model.geometryKind === "goalpost") return buildGoalPost(params, opts);
  if (model.geometryKind === "goalpostoval") return buildGoalPostOval(params, opts);
  if (model.geometryKind === "tbar") return buildTBar(params, opts);
  const segments = opts.segments || RADIAL_SEGMENTS;
  const sec = revolutionSection(model, params, profilePoints);
  const section = sec.section.map((p) => new THREE.Vector2(p.x, p.y));
  const outer = { length: sec.outerLen };

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
