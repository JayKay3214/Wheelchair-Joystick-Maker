// Copyright 2026 Jayden Collier and Jayke Collier
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import * as THREE from "three";
import { OBJExporter } from "three/addons/exporters/OBJExporter.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";

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

export function exportSTEP(sourceGeometry, name) {
  const text = buildSTEP(sourceGeometry, name);
  download(new Blob([text], { type: "application/step" }), `${name}.step`);
}
