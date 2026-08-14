// Copyright 2026 Jayden Collier and Jayke Collier
// SPDX-License-Identifier: Apache-2.0

import { boreCeiling, boreRadius } from "./models.js";

/**
 * 2D profile editor. Draws the joystick's cross-section (radius vs height) mirrored
 * about the centre axis, with draggable control points. Dragging a point updates the
 * store, which regenerates the revolved 3D model live.
 *
 * Internally everything is in "logical" pixels (W x H); the canvas backing store is
 * scaled by devicePixelRatio for crispness.
 */
const W = 280;
const H = 320;
const PAD = 26;
const HIT_R = 12; // px grab radius

export class ProfileEditor {
  constructor(store) {
    this.store = store;
    this.canvas = document.getElementById("profile-canvas");
    this.ctx = this.canvas.getContext("2d");
    this.dragIndex = -1;
    this._setupCanvas();

    this.canvas.addEventListener("pointerdown", (e) => this._onDown(e));
    window.addEventListener("pointermove", (e) => this._onMove(e));
    window.addEventListener("pointerup", () => (this.dragIndex = -1));

    store.subscribe(() => this.draw());
    this.draw();
  }

  _setupCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- coordinate mapping (model mm <-> logical px) ----
  _fit() {
    const pts = this.store.profilePoints;
    let maxR = 1, maxY = 1;
    for (const p of pts) {
      maxR = Math.max(maxR, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const scaleX = (W / 2 - PAD) / maxR;
    const scaleY = (H - 2 * PAD) / maxY;
    const scale = Math.min(scaleX, scaleY);
    return { scale, cx: W / 2, baseY: H - PAD };
  }

  _toPx(p, f) {
    return { px: f.cx + p.x * f.scale, py: f.baseY - p.y * f.scale };
  }

  _toModel(px, py, f) {
    return { x: (px - f.cx) / f.scale, y: (f.baseY - py) / f.scale };
  }

  _pointerPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * W, py: ((e.clientY - r.top) / r.height) * H };
  }

  _onDown(e) {
    if (this.store.model.custom) return; // custom shapes are slider-driven, not draggable
    const f = this._fit();
    const { px, py } = this._pointerPos(e);
    let best = -1, bestD = HIT_R;
    this.store.profilePoints.forEach((p, i) => {
      const sp = this._toPx(p, f);
      const d = Math.hypot(sp.px - px, sp.py - py);
      if (d < bestD) { bestD = d; best = i; }
    });
    this.dragIndex = best;
    if (best >= 0) e.preventDefault();
  }

  _onMove(e) {
    if (this.dragIndex < 0) return;
    e.preventDefault();
    const f = this._fit();
    const { px, py } = this._pointerPos(e);
    const m = this._toModel(px, py, f);
    this.store.updateProfilePoint(this.dragIndex, m.x, m.y);
  }

  // ---- drawing ----
  _catmullPath(ctx, pts) {
    if (pts.length < 3) {
      ctx.moveTo(pts[0].px, pts[0].py);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].px, pts[i].py);
      return;
    }
    ctx.moveTo(pts[0].px, pts[0].py);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 > pts.length - 1 ? pts.length - 1 : i + 2];
      const c1x = p1.px + (p2.px - p0.px) / 6;
      const c1y = p1.py + (p2.py - p0.py) / 6;
      const c2x = p2.px - (p3.px - p1.px) / 6;
      const c2y = p2.py - (p3.py - p1.py) / 6;
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.px, p2.py);
    }
  }

  // Static front-view preview for custom (non-revolution) shapes like the Goal Posts.
  _drawCustom() {
    const ctx = this.ctx;
    const S = this.store.model.shape2D(this.store.params);
    const parts = S.front.parts;
    let minX = Infinity, maxX = -Infinity, maxY = 1;
    for (const arr of parts) for (const q of arr) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
    minX = Math.min(minX, -S.stemR); maxX = Math.max(maxX, S.stemR);
    const scale = Math.min((W - 2 * PAD) / Math.max(maxX - minX, 1), (H - 2 * PAD) / maxY);
    const cx = W / 2, baseY = H - PAD;
    const toPx = (q) => ({ px: cx + q.x * scale, py: baseY - q.y * scale });

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "#2a323c"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(8, baseY); ctx.lineTo(W - 8, baseY); ctx.stroke();

    ctx.fillStyle = "rgba(79,156,255,0.10)";
    ctx.strokeStyle = "#4f9cff";
    ctx.lineWidth = 2;
    // stem first (base overlaps it)
    const sr = S.stemR * scale, st = baseY - S.stemTopY * scale;
    ctx.beginPath(); ctx.rect(cx - sr, st, 2 * sr, baseY - st); ctx.fill(); ctx.stroke();
    // base pad + the two arms
    for (const arr of parts) {
      ctx.beginPath();
      const p0 = toPx(arr[0]); ctx.moveTo(p0.px, p0.py);
      for (let i = 1; i < arr.length; i++) { const q = toPx(arr[i]); ctx.lineTo(q.px, q.py); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // bore (absent when the stem is too short to hold one)
    if (S.boreR != null && S.boreCeil != null) {
      const bx = S.boreR * scale, by = baseY - S.boreCeil * scale;
      ctx.strokeStyle = "#f59e0b"; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(cx - bx, baseY); ctx.lineTo(cx - bx, by); ctx.lineTo(cx + bx, by); ctx.lineTo(cx + bx, baseY);
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = "#6b7785";
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Front view · adjust with sliders", W / 2, H - 7);
  }

  draw() {
    // Models with no revolved cross-section (the flat Bore Tester plate) hide this panel.
    if (this.store.model.noProfile) { this.ctx.clearRect(0, 0, W, H); return; }
    if (this.store.model.custom && this.store.model.shape2D) { this._drawCustom(); return; }
    const ctx = this.ctx;
    const f = this._fit();
    const pts = this.store.profilePoints;
    const smooth = this.store.model.smoothProfile;
    const right = pts.map((p) => this._toPx(p, f));

    ctx.clearRect(0, 0, W, H);

    // bed line
    ctx.strokeStyle = "#2a323c";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, f.baseY);
    ctx.lineTo(W - 8, f.baseY);
    ctx.stroke();

    // centre axis
    ctx.strokeStyle = "#374151";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(f.cx, PAD - 8);
    ctx.lineTo(f.cx, f.baseY);
    ctx.stroke();
    ctx.setLineDash([]);

    // filled silhouette: right curve, then mirrored left side back to the top
    const leftRev = right.map((p) => ({ px: 2 * f.cx - p.px, py: p.py })).reverse();
    ctx.beginPath();
    if (smooth) this._catmullPath(ctx, right);
    else { ctx.moveTo(right[0].px, right[0].py); right.forEach((p) => ctx.lineTo(p.px, p.py)); }
    leftRev.forEach((p) => ctx.lineTo(p.px, p.py));
    ctx.closePath();
    ctx.fillStyle = "rgba(79,156,255,0.10)";
    ctx.fill();

    // outline (right side, the editable one)
    ctx.beginPath();
    if (smooth) this._catmullPath(ctx, right);
    else { ctx.moveTo(right[0].px, right[0].py); right.forEach((p) => ctx.lineTo(p.px, p.py)); }
    ctx.strokeStyle = "#4f9cff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // bore indicator (mounting hole)
    const boreR = boreRadius(this.store.params.boreDia, pts[pts.length - 1].x);
    const boreDepth = boreCeiling(this.store.params.boreDepth, pts[0].y);
    if (boreR != null && boreDepth != null) {
      const bx = boreR * f.scale;
      const by = f.baseY - boreDepth * f.scale;
      ctx.strokeStyle = "#f59e0b";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(f.cx - bx, f.baseY); ctx.lineTo(f.cx - bx, by); ctx.lineTo(f.cx + bx, by); ctx.lineTo(f.cx + bx, f.baseY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // control points (right side)
    right.forEach((sp, i) => {
      const p = pts[i];
      const locked = p.lockX || p.lockY;
      ctx.beginPath();
      ctx.arc(sp.px, sp.py, i === this.dragIndex ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = locked ? "#6b7785" : "#e6edf3";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#4f9cff";
      ctx.stroke();
    });
  }
}
