import { getModel, defaultParams, fullSchema, MODELS, stemHeightForBore, boreDepthCeiling, snapDownToStep } from "./models.js";

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
    return this.modelId === "boretester";
  }

  enterBoreTester() {
    if (this.isTesting) return;
    this._parked = {
      modelId: this.modelId,
      params: { ...this.params },
      profilePoints: this.profilePoints.map((p) => ({ ...p })),
    };
    const seed = this.params.boreDia;
    this.modelId = "boretester";
    this.params = defaultParams(this.model);
    if (seed != null) {
      const s = this._schemaFor("boreDia");
      this.params.boreDia = Math.min(Math.max(seed, s.min), s.max);
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
      this.setModel(MODELS[0].id);
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
        // Never below the slider's own floor, and land on its step grid — a ceiling can be
        // any real number (the bore's is derived from the shape), and dropping it in raw
        // would leave the readout showing digits the handle can't sit on.
        // A maxFn narrows the declared range, never widens it (see UI._dynamicMax).
        const mx = Math.max(s.min, Math.min(s.max, s.maxFn(this.params, m)));
        if (this.params[s.key] > mx) {
          this.params[s.key] = snapDownToStep(s, mx);
        }
      }
    }
    this._trimBoreToFit();
  }

  /** The active model's schema entry for a slider key. */
  _schemaFor(key) {
    return fullSchema(this.model).find((s) => s.key === key);
  }

  /**
   * Pull the hole depth back to what the shape can actually hold. The partner to
   * _growStemForBore: shortening the stem — or shrinking the head the bore runs up into —
   * has to take the depth down with it, or the slider would keep claiming depth that never
   * gets built. Runs after the maxFn pass, so it sees settled values.
   */
  _trimBoreToFit() {
    const schema = this._schemaFor("boreDepth");
    if (!schema || this.params.boreDepth == null) return;
    const ceiling = boreDepthCeiling(this.model, this.params);
    if (this.params.boreDepth > ceiling) {
      this.params.boreDepth = snapDownToStep(schema, ceiling);
    }
  }

  setParam(key, value) {
    this.params[key] = value;
    // Asking for a deeper hole grows the stem to hold it rather than silently ignoring the
    // extra depth. Only on a bore-depth edit: doing it in _clampDynamic would make the stem
    // spring straight back every time you tried to shorten it.
    if (key === "boreDepth") this._growStemForBore();
    this._clampDynamic();
    this.rebuildProfile();
    this._emit("param");
  }

  /** Raise the stem (as far as its slider goes) so the requested hole depth fits. */
  _growStemForBore() {
    const schema = this._schemaFor("stemHeight");
    if (!schema || this.params.stemHeight == null || this.params.boreDepth == null) return;
    const need = stemHeightForBore(this.model, this.params);
    if (need <= this.params.stemHeight) return;
    const snapped = Math.ceil(need / schema.step) * schema.step;
    this.params.stemHeight = Math.min(Math.max(snapped, schema.min), schema.max);
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
