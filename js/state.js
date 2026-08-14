// Copyright 2026 Jayden Collier and Jayke Collier
// SPDX-License-Identifier: Apache-2.0

import { getModel, defaultParams, fullSchema, BORE_TESTER_ID, DEFAULT_MODEL_ID } from "./models.js";
import { ceilingFor, snapDownToStep, snapUpToStep, clampToSchema } from "./schema.js";

/**
 * Single source of truth for the app.
 *
 *   modelId       active handle style
 *   params        slider values (mm / deg) for the active model
 *   profilePoints current outer silhouette control points {x,y,lockX?,lockY?}
 *   unit          display unit: "mm" | "in"
 *   gridVisible   viewport grid
 *
 * Sliders are the primary control: changing one regenerates profilePoints from the
 * model. Dragging a profile point edits profilePoints directly (params untouched),
 * so manual tweaks persist until a slider for that model changes them again.
 *
 * Subscribers are notified on any change with a reason: "model" | "param" | "profile".
 */
export class Store {
  constructor() {
    this.unit = "mm";
    this.gridVisible = true;
    this._subs = [];
    this._parked = null; // handle state stashed while the bore tester is on screen
    this.setModel(DEFAULT_MODEL_ID, true);
  }

  subscribe(fn) {
    this._subs.push(fn);
  }

  _emit(reason) {
    for (const fn of this._subs) fn(reason, this);
  }

  get model() {
    return getModel(this.modelId);
  }

  setModel(id, silent = false) {
    this._parked = null; // picking a style outright discards any parked tester state
    this.modelId = id;
    this.params = defaultParams(this.model);
    this._clampDynamic(); // defaults may exceed a dynamic ceiling (e.g. wall length vs corners)
    this.rebuildProfile();
    if (!silent) this._emit("model");
  }

  // ---- bore fit tester ---------------------------------------------------------
  // The tester is a mode, not a handle style: entering it parks the handle you were
  // designing (style, sliders and any profile drags) and restores it untouched on the
  // way back. The tester's target hole is seeded from the handle's current bore, so you
  // get a set of sizes bracketing the diameter you were already using.

  get isTesting() {
    return this.modelId === BORE_TESTER_ID;
  }

  enterBoreTester() {
    if (this.isTesting) return;
    this._parked = {
      modelId: this.modelId,
      params: { ...this.params },
      profilePoints: this.profilePoints.map((p) => ({ ...p })),
    };
    const leaving = this.params;
    this.modelId = BORE_TESTER_ID;
    this.params = defaultParams(this.model);
    // seedFor belongs to the model being ENTERED — it declares what it wants carried over
    // from the handle you were designing, so the store needs no param names of its own.
    for (const [key, value] of Object.entries(this.model.seedFor?.(leaving) ?? {})) {
      const s = this._schemaFor(key);
      if (s && value != null) this.params[key] = clampToSchema(s, value);
    }
    this._clampDynamic();
    this.rebuildProfile();
    this._emit("model");
  }

  /**
   * Leave the tester. Total by design: if there is nothing parked (the tester was entered
   * some way that skipped enterBoreTester) this falls back to a real handle rather than
   * returning early, because the style picker is hidden while testing — a silent no-op
   * here would strand the user in a mode with no way out.
   */
  exitBoreTester() {
    if (!this._parked) {
      this.setModel(DEFAULT_MODEL_ID);
      return;
    }
    const { modelId, params, profilePoints } = this._parked;
    this._parked = null;
    this.modelId = modelId;
    this.params = params;
    this.profilePoints = profilePoints;
    this._emit("model");
  }

  /** Regenerate the outer silhouette from the current params (resets manual drags). */
  rebuildProfile() {
    this.profilePoints = this.model.buildOuterProfile(this.params).map((p) => ({ ...p }));
  }

  /**
   * Hold every param inside what its shape can actually build. Each rule is declared on the
   * slider it belongs to (models.js) and applied generically here, so the store names no
   * params of its own:
   *
   *   fitFn      the ceiling right now (edge rounding vs top radius, wall length vs base
   *              length, hole depth vs the solid it sits in)
   *   normalise  a last word on the value — used where a range is meaningful but a
   *              sub-range inside it is not
   *
   * A ceiling never widens a slider past its declared max, and the clamped value always
   * lands on the slider's own step grid: a ceiling derived from a shape is an arbitrary real
   * number, and dropping it in raw leaves the readout showing digits the handle can't sit on.
   */
  _clampDynamic() {
    const m = this.model;
    for (const s of fullSchema(m)) {
      let v = this.params[s.key];
      if (v == null) continue;
      const ceiling = ceilingFor(s, this.params, m);
      if (v > ceiling) v = snapDownToStep(s, ceiling);
      this.params[s.key] = s.normalise ? s.normalise(v) : v;
    }
  }

  /** The active model's schema entry for a slider key. */
  _schemaFor(key) {
    return fullSchema(this.model).find((s) => s.key === key);
  }

  /**
   * Set one slider. `grow` is what makes a deliberate edit able to carry other params up
   * with it — asking for a deeper hole raises the stem to hold it, rather than silently
   * ignoring the extra depth. It is off for a reset, where the panel promises to move only
   * the one control, and it never runs during clamping, which would make a param spring
   * back every time you tried to lower it.
   */
  setParam(key, value, { grow = true } = {}) {
    this.params[key] = value;
    const schema = this._schemaFor(key);
    if (grow && schema && schema.growFn) this._grow(schema.growFn(this.params, this.model));
    this._clampDynamic();
    this.rebuildProfile();
    this._emit("param");
  }

  /** Raise other params to the minimums a growFn asks for, as far as their sliders go. */
  _grow(needs) {
    for (const [key, need] of Object.entries(needs)) {
      const s = this._schemaFor(key);
      if (!s || this.params[key] == null || need <= this.params[key]) continue;
      this.params[key] = clampToSchema(s, snapUpToStep(s, need));
    }
  }

  /** Reset one slider to its default value. */
  resetParam(key) {
    const schema = this._schemaFor(key);
    const def = (this.model.defaults && this.model.defaults[key] != null) ? this.model.defaults[key] : schema && schema.def;
    if (def == null) return;
    this.setParam(key, def, { grow: false });
  }

  /** Reset every slider for the active model back to its defaults. */
  resetParams() {
    this.params = defaultParams(this.model);
    this._clampDynamic();
    this.rebuildProfile();
    this._emit("param");
  }

  resetProfile() {
    this.rebuildProfile();
    this._emit("profile");
  }

  /** Called by the profile editor when a control point is dragged. */
  updateProfilePoint(index, x, y) {
    const p = this.profilePoints[index];
    if (!p) return;
    if (!p.lockX) p.x = Math.max(0, x);
    if (!p.lockY) p.y = y;
    this._emit("profile");
  }

  setUnit(unit) {
    this.unit = unit;
    this._emit("unit");
  }

  setGridVisible(v) {
    this.gridVisible = v;
  }
}
