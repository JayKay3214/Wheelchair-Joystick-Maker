// Copyright 2026 Jayden Collier and Jayke Collier
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * SceneManager owns the Three.js scene, camera, renderer, lights and controls.
 * The joystick mesh is swapped in/out via setMesh(); geometry/material disposal
 * is handled here so callers don't leak GPU memory on every regenerate.
 */
export class SceneManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.mesh = null;

    this.scene = new THREE.Scene();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    this.defaultCamPos = new THREE.Vector3(70, 60, 95);
    this.camera.position.copy(this.defaultCamPos);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 400;
    this.controls.target.set(0, 18, 0);

    this._addLights();
    this._addGround();

    this.grid = new THREE.GridHelper(160, 16, 0x33404e, 0x222a33);
    this.grid.position.y = 0;
    this.scene.add(this.grid);

    window.addEventListener("resize", () => this.resize());
    this.resize();
    this._animate();
  }

  _addLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));

    const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x202830, 0.6);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(60, 90, 50);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 10;
    key.shadow.camera.far = 320;
    const s = 90;
    key.shadow.camera.left = -s;
    key.shadow.camera.right = s;
    key.shadow.camera.top = s;
    key.shadow.camera.bottom = -s;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xaecbff, 0.7);
    fill.position.set(-70, 40, -40);
    this.scene.add(fill);
  }

  _addGround() {
    const geo = new THREE.PlaneGeometry(400, 400);
    const mat = new THREE.ShadowMaterial({ opacity: 0.28 });
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = 0;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  /** Replace the displayed joystick mesh, disposing the previous one. */
  setMesh(mesh) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this._disposeMesh(this.mesh);
    }
    this.mesh = mesh;
    if (mesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      this.scene.add(mesh);
    }
  }

  _disposeMesh(mesh) {
    mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }

  setGridVisible(v) {
    this.grid.visible = v;
  }

  /** Fit the camera to a mesh's bounding box, keeping the default viewing direction. */
  frameMesh(mesh) {
    if (!mesh || !mesh.geometry) return this.resetView();
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const size = new THREE.Vector3(), center = new THREE.Vector3();
    g.boundingBox.getSize(size);
    g.boundingBox.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (maxDim * 0.5) / Math.tan(fov / 2) * 1.5 + maxDim * 0.25;
    const dir = this.defaultCamPos.clone().normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.update();
  }

  resetView() {
    if (this.mesh) return this.frameMesh(this.mesh);
    this.camera.position.copy(this.defaultCamPos);
    this.controls.target.set(0, 18, 0);
    this.controls.update();
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
