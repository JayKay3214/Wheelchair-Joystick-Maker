import { SceneManager } from "./scene.js";
import { Store } from "./state.js";
import { UI } from "./ui.js";
import { ProfileEditor } from "./profileEditor.js";
import { buildKnobMesh, meshDimensions } from "./geometry.js";
import { exportSTL, exportOBJ } from "./exporter.js";

const store = new Store();
const scene = new SceneManager(document.getElementById("scene-canvas"));
const ui = new UI(store);
new ProfileEditor(store);

document.getElementById("loading").classList.add("hidden");

// ---- regeneration -------------------------------------------------------------
let raf = 0;
function regenerate() {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    const mesh = buildKnobMesh(store.model, store.params, store.profilePoints);
    scene.setMesh(mesh);
    ui.setSizeReadout(meshDimensions(mesh.geometry));
  });
}

store.subscribe((reason) => {
  if (reason === "model" || reason === "param" || reason === "profile") regenerate();
});
regenerate(); // initial

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

// ---- export -------------------------------------------------------------------
function fileName() {
  return `joystick-${store.modelId}`;
}
document.getElementById("export-stl").addEventListener("click", () => {
  if (scene.mesh) exportSTL(scene.mesh.geometry, fileName());
});
document.getElementById("export-obj").addEventListener("click", () => {
  if (scene.mesh) exportOBJ(scene.mesh.geometry, fileName());
});

// keep renderer sized once layout settles
requestAnimationFrame(() => scene.resize());
