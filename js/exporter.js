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
