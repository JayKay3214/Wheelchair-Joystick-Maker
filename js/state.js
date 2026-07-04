import { getModel, defaultParams, fullSchema } from "./models.js";

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
    this.setModel("ball", true);
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
    this.modelId = id;
    this.model_ = getModel(id);
    this.params = defaultParams(this.model_);
    this.rebuildProfile();
    if (!silent) this._emit("model");
  }

  /** Regenerate the outer silhouette from the current params (resets manual drags). */
  rebuildProfile() {
    this.profilePoints = this.model.buildOuterProfile(this.params).map((p) => ({ ...p }));
  }

  // Keep params within any dynamic ceilings (edge rounding vs top radius, wall length
  // vs base length, ...).
  _clampDynamic() {
    const m = this.model;
    if (m.edgeRoundMax && this.params.edgeRound != null) {
      const mx = Math.max(0.25, m.edgeRoundMax(this.params));
      if (this.params.edgeRound > mx) this.params.edgeRound = mx;
    }
    for (const s of fullSchema(m)) {
      if (s.maxFn && this.params[s.key] != null) {
        const mx = s.maxFn(this.params);
        if (this.params[s.key] > mx) this.params[s.key] = mx;
      }
    }
  }

  setParam(key, value) {
    this.params[key] = value;
    this._clampDynamic();
    this.rebuildProfile();
    this._emit("param");
  }

  /** Reset one slider to its default value. */
  resetParam(key) {
    const schema = fullSchema(this.model).find((s) => s.key === key);
    const def = (this.model.defaults && this.model.defaults[key] != null) ? this.model.defaults[key] : schema && schema.def;
    if (def == null) return;
    this.setParam(key, def);
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
