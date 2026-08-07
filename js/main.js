import { SceneManager } from "./scene.js";
import { Store } from "./state.js";
import { UI } from "./ui.js";
import { ProfileEditor } from "./profileEditor.js";
import * as THREE from "three";
import { buildKnobMesh, buildKnobGeometry, meshDimensions, material, STEP_SEGMENTS } from "./geometry.js";
import { exportSTL, exportOBJ, exportSTEP } from "./exporter.js";
import { boreTesterFileName } from "./models.js";

const store = new Store();
const scene = new SceneManager(document.getElementById("scene-canvas"));
const ui = new UI(store);
new ProfileEditor(store);

document.getElementById("loading").classList.add("hidden");

// ---- regeneration -------------------------------------------------------------
let raf = 0;
function regenerate(frame = false) {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const mesh = buildKnobMesh(store.model, store.params, store.profilePoints, { unit: store.unit });
    scene.setMesh(mesh);
    if (frame) scene.frameMesh(mesh); // refit the camera when the model changes
    ui.setSizeReadout(meshDimensions(mesh.geometry));
  });
}

store.subscribe((reason) => {
  if (reason === "model" || reason === "param" || reason === "profile") regenerate(reason === "model");
  // The tester's labels are embossed geometry, so switching mm/in genuinely reshapes the
  // plate. Every other model is unit-agnostic and needs no rebuild.
  else if (reason === "unit" && store.isTesting) regenerate();
});
regenerate(true); // initial (fit camera to the first model)

// ---- viewport controls --------------------------------------------------------
const gridBtn = document.getElementById("toggle-grid");
gridBtn.classList.toggle("is-active", store.gridVisible);
gridBtn.addEventListener("click", () => {
  const v = !store.gridVisible;
  store.setGridVisible(v);
  scene.setGridVisible(v);
  gridBtn.classList.toggle("is-active", v);
});
document.getElementById("reset-view").addEventListener("click", () => scene.resetView());
document.getElementById("reset-profile").addEventListener("click", () => store.resetProfile());

// Solid / Inside (see-through) view toggle.
const viewBtn = document.getElementById("toggle-view");
let solidView = true;
viewBtn.addEventListener("click", () => {
  solidView = !solidView;
  material.side = solidView ? THREE.FrontSide : THREE.BackSide;
  material.needsUpdate = true;
  viewBtn.textContent = solidView ? "View: Solid" : "View: Inside";
  viewBtn.classList.toggle("is-active", solidView);
});

// ---- export -------------------------------------------------------------------
function fileName() {
  return store.isTesting ? boreTesterFileName(store.params, store.unit) : `joystick-${store.modelId}`;
}
document.getElementById("export-stl").addEventListener("click", () => {
  if (scene.mesh) exportSTL(scene.mesh.geometry, fileName());
});
document.getElementById("export-obj").addEventListener("click", () => {
  if (scene.mesh) exportOBJ(scene.mesh.geometry, fileName());
});
document.getElementById("export-step").addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const label = btn.textContent;
  btn.textContent = "Building…";
  btn.disabled = true;
  // Coarser facets keep the STEP file manageable; defer so the label repaints.
  requestAnimationFrame(() => {
    try {
      const geo = buildKnobGeometry(store.model, store.params, store.profilePoints, { segments: STEP_SEGMENTS, unit: store.unit });
      exportSTEP(geo, fileName());
      geo.dispose();
    } finally {
      btn.textContent = label;
      btn.disabled = false;
    }
  });
});

// keep renderer sized once layout settles
requestAnimationFrame(() => scene.resize());
