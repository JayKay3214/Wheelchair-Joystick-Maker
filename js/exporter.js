import * as THREE from "three";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { revolutionSection, buildKnobGeometry, STEP_SEGMENTS } from "./geometry.js";

/**
 * Export the current geometry to STL (binary) or OBJ.
 *
 * The model is built Y-up (Three.js convention) with its base at y=0. 3D printers /
 * slicers expect Z-up, so we rotate +90° about X before export, leaving the part
 * sitting bore-down on the bed. Geometry is already in millimetres (scale 1:1).
 */
function prepGeometry(sourceGeometry) {
  const geo = sourceGeometry.clone();
  geo.rotateX(Math.PI / 2); // Y-up -> Z-up, bore facing down
  geo.computeVertexNormals();
  return geo;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportSTL(sourceGeometry, name) {
  const mesh = new THREE.Mesh(prepGeometry(sourceGeometry));
  const data = new STLExporter().parse(mesh, { binary: true }); // DataView
  download(new Blob([data], { type: "application/octet-stream" }), `${name}.stl`);
}

export function exportOBJ(sourceGeometry, name) {
  const mesh = new THREE.Mesh(prepGeometry(sourceGeometry));
  const text = new OBJExporter().parse(mesh);
  download(new Blob([text], { type: "text/plain" }), `${name}.obj`);
}

// ---- STEP (faceted solid B-rep, AP214) ----------------------------------------
// Three.js has no STEP exporter. The model is a watertight triangle mesh, so we emit
// a faceted manifold_solid_brep: welded vertices, shared edges, one planar face per
// triangle. Imports as a solid in FreeCAD / Fusion / SolidWorks etc. (tessellated,
// not analytic surfaces). Falls back to an open shell if welding leaves free edges.

function r(n) {
  let s = (+n.toFixed(6)).toString();
  if (!/[.eE]/.test(s)) s += ".";
  return s;
}

function weld(geometry) {
  const pos = geometry.attributes.position;
  const idx = geometry.index ? geometry.index.array : null;
  const map = new Map();
  const verts = [];
  const remap = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let v = map.get(key);
    if (v === undefined) { v = verts.length; verts.push([x, y, z]); map.set(key, v); }
    remap[i] = v;
  }
  const tris = [];
  const count = idx ? idx.length : pos.count;
  for (let i = 0; i < count; i += 3) {
    const a = remap[idx ? idx[i] : i];
    const b = remap[idx ? idx[i + 1] : i + 1];
    const c = remap[idx ? idx[i + 2] : i + 2];
    if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
  }
  return { verts, tris };
}

export function buildSTEP(sourceGeometry, name) {
  const geo = prepGeometry(sourceGeometry);
  const { verts, tris } = weld(geo);

  // ---- entity emitter ----
  let id = 0;
  const lines = [];
  const put = (s) => { id++; lines.push(`#${id}=${s};`); return `#${id}`; };

  // boilerplate: context, product, units
  const appCtx = put("APPLICATION_CONTEXT('automotive design')");
  put(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = put(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const product = put(`PRODUCT('${name}','${name}','',(${prodCtx}))`);
  const pdf = put(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const pdCtx = put(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const pd = put(`PRODUCT_DEFINITION('design','',${pdf},${pdCtx})`);
  const pds = put(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  put(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(${product}))`);

  const lenUnit = put("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const angUnit = put("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const solUnit = put("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const uncert = put(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),${lenUnit},'accuracy','')`);
  const ctx = put(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncert}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lenUnit},${angUnit},${solUnit}))REPRESENTATION_CONTEXT('',''))`);

  // shared geometry: cartesian_point + vertex_point per welded vertex
  const cp = new Array(verts.length);
  const vp = new Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    const [x, y, z] = verts[i];
    cp[i] = put(`CARTESIAN_POINT('',(${r(x)},${r(y)},${r(z)}))`);
    vp[i] = put(`VERTEX_POINT('',${cp[i]})`);
  }

  const dirCache = new Map();
  const dir = (x, y, z) => {
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let d = dirCache.get(key);
    if (!d) { d = put(`DIRECTION('',(${r(x)},${r(y)},${r(z)}))`); dirCache.set(key, d); }
    return d;
  };

  // shared edges
  const edgeMap = new Map(); // "min_max" -> edge_curve id
  let openEdges = 0;
  const edgeCount = new Map();
  const edgeId = (a, b) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = `${lo}_${hi}`;
    edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    let e = edgeMap.get(key);
    if (!e) {
      const [ax, ay, az] = verts[lo];
      const [bx, by, bz] = verts[hi];
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const mag = Math.hypot(dx, dy, dz) || 1;
      const vec = put(`VECTOR('',${dir(dx, dy, dz)},${r(mag)})`);
      const line = put(`LINE('',${cp[lo]},${vec})`);
      e = put(`EDGE_CURVE('',${vp[lo]},${vp[hi]},${line},.T.)`);
      edgeMap.set(key, e);
    }
    return e;
  };

  const faceIds = [];
  for (const [a, b, c] of tris) {
    const [ax, ay, az] = verts[a];
    const [bx, by, bz] = verts[b];
    const [cx, cy, cz] = verts[c];
    // face normal
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const wx = cx - ax, wy = cy - ay, wz = cz - az;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-9) continue;
    nx /= nl; ny /= nl; nz /= nl;

    const axisPl = put(`AXIS2_PLACEMENT_3D('',${cp[a]},${dir(nx, ny, nz)},${dir(ux, uy, uz)})`);
    const plane = put(`PLANE('',${axisPl})`);

    const e1 = edgeId(a, b), e2 = edgeId(b, c), e3 = edgeId(c, a);
    const oe1 = put(`ORIENTED_EDGE('',*,*,${e1},.${a < b ? "T" : "F"}.)`);
    const oe2 = put(`ORIENTED_EDGE('',*,*,${e2},.${b < c ? "T" : "F"}.)`);
    const oe3 = put(`ORIENTED_EDGE('',*,*,${e3},.${c < a ? "T" : "F"}.)`);
    const loop = put(`EDGE_LOOP('',(${oe1},${oe2},${oe3}))`);
    const bound = put(`FACE_OUTER_BOUND('',${loop},.T.)`);
    faceIds.push(put(`ADVANCED_FACE('',(${bound}),${plane},.T.)`));
  }

  for (const v of edgeCount.values()) if (v !== 2) openEdges++;
  const closed = openEdges === 0;

  let solidId;
  if (closed) {
    const shell = put(`CLOSED_SHELL('',(${faceIds.join(",")}))`);
    solidId = put(`MANIFOLD_SOLID_BREP('${name}',${shell})`);
  } else {
    const shell = put(`OPEN_SHELL('',(${faceIds.join(",")}))`);
    solidId = put(`SHELL_BASED_SURFACE_MODEL('${name}',(${shell}))`);
  }
  const shapeRep = put(`ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(${solidId}),${ctx})`);
  put(`SHAPE_DEFINITION_REPRESENTATION(${pds},${shapeRep})`);

  const now = new Date().toISOString();
  const header =
    `ISO-10303-21;\nHEADER;\n` +
    `FILE_DESCRIPTION(('Wheelchair joystick handle - faceted solid'),'2;1');\n` +
    `FILE_NAME('${name}.step','${now}',(''),(''),'Joystick Maker','',' ');\n` +
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n`;
  const footer = `ENDSEC;\nEND-ISO-10303-21;\n`;
  return header + lines.join("\n") + "\n" + footer;
}

// ---- STEP (analytic B-rep for solids of revolution) ---------------------------
// The round models are a revolved (radius, y) profile, so emit REAL analytic surfaces
// (plane / cylinder / cone) + full-circle edges instead of triangles: tiny files, truly
// round, editable in CAD. Built Z-up (axis = Z, bore facing -Z) to match the mesh export.
// Verified against OpenCASCADE (valid solid, exact volume). No pcurves needed — the importer
// reconstructs them; only the PRODUCT/SHAPE_DEFINITION chain + a closed shell are required.

function stepReal(x) {
  if (Math.abs(x) < 1e-12) x = 0;
  let s = x.toFixed(9).replace(/0+$/, "");     // STEP reals need a '.' and no lowercase sci-notation
  if (s === "" || s === "-" || s === "-.") s = "0.";
  if (!s.includes(".")) s += ".";
  return s;
}

function buildSTEPAnalytic(section, name) {
  const pts = section.map((p) => [p.x, p.y]); // (radius, height=z); axis is Z
  let id = 0;
  const lines = [];
  const put = (s) => { id++; lines.push(`#${id}=${s};`); return `#${id}`; };
  const P = (x, y, z) => put(`CARTESIAN_POINT('',(${stepReal(x)},${stepReal(y)},${stepReal(z)}))`);
  const D = (x, y, z) => put(`DIRECTION('',(${stepReal(x)},${stepReal(y)},${stepReal(z)}))`);
  const appCtx = put("APPLICATION_CONTEXT('automotive design')");
  put(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appCtx})`);
  const prodCtx = put(`PRODUCT_CONTEXT('',${appCtx},'mechanical')`);
  const product = put(`PRODUCT('${name}','${name}','',(${prodCtx}))`);
  const pdf = put(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const pdCtx = put(`PRODUCT_DEFINITION_CONTEXT('part definition',${appCtx},'design')`);
  const pd = put(`PRODUCT_DEFINITION('design','',${pdf},${pdCtx})`);
  const pds = put(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
  put(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(${product}))`);
  const lu = put("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const au = put("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const su = put("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const un = put(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),${lu},'','')`);
  const ctx = put(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${un}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${lu},${au},${su}))REPRESENTATION_CONTEXT('',''))`);
  const Zp = D(0, 0, 1), Zn = D(0, 0, -1), Xd = D(1, 0, 0);
  const a2p = (z, axis) => put(`AXIS2_PLACEMENT_3D('',${P(0, 0, z)},${axis},${Xd})`);
  const n = pts.length;
  const circ = new Map(); // one full-circle edge per profile vertex (r>0), shared by both adjacent faces
  const circleAt = (i) => {
    if (circ.has(i)) return circ.get(i);
    const rr = pts[i][0], zz = pts[i][1];
    const c = put(`CIRCLE('',${a2p(zz, Zp)},${stepReal(rr)})`);
    const v = put(`VERTEX_POINT('',${P(rr, 0, zz)})`);
    const e = put(`EDGE_CURVE('',${v},${v},${c},.T.)`);
    circ.set(i, e); return e;
  };
  const bound = (edge, outer) => {
    const lp = put(`EDGE_LOOP('',(${put(`ORIENTED_EDGE('',*,*,${edge},.T.)`)}))`);
    return put(`${outer ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',${lp},.T.)`);
  };
  let area = 0; // winding of the (r,z) profile picks the outward side of the flat faces
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const cw = area < 0;
  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const r0 = pts[i][0], z0 = pts[i][1], r1 = pts[j][0], z1 = pts[j][1];
    if (Math.abs(r0) < 1e-9 && Math.abs(r1) < 1e-9) continue;          // segment on the axis -> no face
    if (Math.abs(z1 - z0) < 1e-9) {                                    // horizontal -> PLANE (disk or annulus)
      const axis = ((r1 > r0) !== cw) ? Zp : Zn;
      const pl = put(`PLANE('',${a2p(z0, axis)})`);
      const bnds = [bound(circleAt(r0 >= r1 ? i : j), true)];
      if (Math.min(r0, r1) > 1e-9) bnds.push(bound(circleAt(r0 >= r1 ? j : i), false));
      faces.push(put(`ADVANCED_FACE('',(${bnds.join(",")}),${pl},.T.)`));
    } else if (Math.abs(r1 - r0) < 1e-9) {                            // vertical -> CYLINDER
      const cyl = put(`CYLINDRICAL_SURFACE('',${a2p(Math.min(z0, z1), Zp)},${stepReal(r0)})`);
      faces.push(put(`ADVANCED_FACE('',(${bound(circleAt(i), true)},${bound(circleAt(j), false)}),${cyl},.T.)`));
    } else if (Math.abs(r0) < 1e-9 || Math.abs(r1) < 1e-9) {          // slanted from the axis -> CONE to an apex
      let za, rb, zb, ib;
      if (Math.abs(r0) < 1e-9) { za = z0; rb = r1; zb = z1; ib = j; } else { za = z1; rb = r0; zb = z0; ib = i; }
      const cone = put(`CONICAL_SURFACE('',${a2p(za, zb > za ? Zp : Zn)},0.,${stepReal(Math.atan(rb / Math.abs(zb - za)))})`);
      faces.push(put(`ADVANCED_FACE('',(${bound(circleAt(ib), true)}),${cone},.T.)`));
    } else {                                                          // slanted frustum -> CONE (both radii > 0)
      const za = z0 - r0 * (z1 - z0) / (r1 - r0);
      const cone = put(`CONICAL_SURFACE('',${a2p(za, z0 > za ? Zp : Zn)},0.,${stepReal(Math.atan(Math.abs(r0) / Math.abs(z0 - za)))})`);
      faces.push(put(`ADVANCED_FACE('',(${bound(circleAt(i), true)},${bound(circleAt(j), false)}),${cone},.T.)`));
    }
  }
  const shell = put(`CLOSED_SHELL('',(${faces.join(",")}))`);
  const solid = put(`MANIFOLD_SOLID_BREP('${name}',${shell})`);
  const sr = put(`ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(${solid}),${ctx})`);
  put(`SHAPE_DEFINITION_REPRESENTATION(${pds},${sr})`);
  const now = new Date().toISOString();
  const header =
    `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Wheelchair joystick handle - analytic solid'),'2;1');\n` +
    `FILE_NAME('${name}.step','${now}',(''),(''),'Joystick Maker','',' ');\n` +
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n`;
  return header + lines.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;\n";
}

/**
 * Analytic B-rep for the solids of revolution; faceted mesh B-rep for the freeform models
 * (Goal Posts, T-Bar) and the tilted (sheared) I-Handle. Either way the button just works.
 */
export function exportSTEP(model, params, profilePoints, name) {
  const sec = revolutionSection(model, params, profilePoints);
  const tilted = model.tiltKey && params[model.tiltKey] > 0;
  let text;
  if (sec && !tilted) {
    text = buildSTEPAnalytic(sec.section, name);
  } else {
    const geo = buildKnobGeometry(model, params, profilePoints, { segments: STEP_SEGMENTS });
    text = buildSTEP(geo, name);
    geo.dispose();
  }
  download(new Blob([text], { type: "application/step" }), `${name}.step`);
}
