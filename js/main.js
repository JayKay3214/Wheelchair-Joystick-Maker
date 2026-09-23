// Copyright 2026 Jayden Collier and Jayke Collier
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { SceneManager } from "./scene.js";
import { Store } from "./state.js";
import { UI } from "./ui.js";
import { ProfileEditor } from "./profileEditor.js";
import * as THREE from "three";
import { buildKnobMesh, buildKnobGeometry, meshDimensions, material, STEP_SEGMENTS } from "./geometry.js";
import { exportSTL, exportOBJ, exportSTEP } from "./exporter.js";

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
  // A unitMarked model carries the unit in its geometry (the tester's labels are embossed),
  // so switching mm/in genuinely reshapes it. Every other model needs no rebuild.
  else if (reason === "unit" && store.model.unitMarked) regenerate();
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
  // A model that names its own exports says so; everything else is joystick-<id>.
  return store.model.fileName?.(store.params, store.unit) ?? `joystick-${store.modelId}`;
}

// The warning gates the first download of each session, then gets out of the way. A modal on
// every export trains people to click through it unread, which costs both the safety value and
// any weight it carries as notice. The same text stays one click away from the export panel.
const printDialog = document.getElementById("print-dialog");
const printConfirm = document.getElementById("print-confirm");
const printDismiss = document.getElementById("print-dismiss");
let printAcknowledged = false;
let pendingExport = null;

// Gating a download and reading the guidance want the same text but different endings, so the
// one dismiss button changes its word and the confirm only exists when there is something to
// confirm. Dismissing is dismissing either way; two buttons for it was one too many.
function openPrintDialog({ gating }) {
  printConfirm.hidden = !gating;
  printDismiss.textContent = gating ? "Cancel" : "Close";
  printDialog.showModal();
  if (!gating) printDismiss.focus();
}
function withPrintWarning(run) {
  if (printAcknowledged) { run(); return; }
  pendingExport = run;
  openPrintDialog({ gating: true });
}
printConfirm.addEventListener("click", () => {
  printAcknowledged = true;
  // Read the pending export before close(), which clears it via the close handler below.
  const run = pendingExport;
  pendingExport = null;
  printDialog.close();
  run?.();
});
printDismiss.addEventListener("click", () => printDialog.close());
// Esc dismisses a native <dialog> without pressing either button, so drop the pending export
// on any close. Confirm has already taken its copy by then.
printDialog.addEventListener("close", () => { pendingExport = null; });
document.getElementById("print-guidance-open").addEventListener("click", () => {
  openPrintDialog({ gating: false });
});

document.getElementById("export-stl").addEventListener("click", () => {
  withPrintWarning(() => { if (scene.mesh) exportSTL(scene.mesh.geometry, fileName()); });
});
document.getElementById("export-obj").addEventListener("click", () => {
  withPrintWarning(() => { if (scene.mesh) exportOBJ(scene.mesh.geometry, fileName()); });
});
document.getElementById("export-step").addEventListener("click", (e) => {
  // Captured now: currentTarget is null by the time the gate resolves.
  const btn = e.currentTarget;
  withPrintWarning(() => {
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
});

// ---- credits ------------------------------------------------------------------
const creditsDialog = document.getElementById("credits-dialog");
document.getElementById("credits-open").addEventListener("click", () => creditsDialog.showModal());
document.getElementById("credits-close").addEventListener("click", () => creditsDialog.close());
// Clicking the backdrop targets the dialog itself, so this closes it without catching
// clicks on the content inside.
creditsDialog.addEventListener("click", (e) => {
  if (e.target === creditsDialog) creditsDialog.close();
});

// keep renderer sized once layout settles
requestAnimationFrame(() => scene.resize());
