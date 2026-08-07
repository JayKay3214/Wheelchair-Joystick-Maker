import { MODELS, fullSchema, snapDownToStep } from "./models.js";
import { MM_PER_IN } from "./units.js";
import { SIZE_COUNT, SIZE_STEP, sizeLabel } from "./boreTester.js";

/** Is this a length param (stored in mm, convertible to inches)? */
function isLength(schema) {
  return schema.unit !== "deg" && schema.unit !== "x";
}

/** Decimal places to show for a length param in mm, based on its slider step. */
function mmDecimals(schema) {
  return schema.step < 0.1 ? 2 : schema.step < 1 ? 1 : 0;
}

/** The unit symbol shown next to the editable number for this param. */
function unitSuffix(schema, unit) {
  if (schema.unit === "deg") return "°";
  if (schema.unit === "x") return "×";
  return unit === "in" ? "″" : "mm";
}

/** A stored value (always mm/deg/x internally) as a bare number string in the chosen unit. */
function displayNumber(schema, value, unit) {
  if (schema.unit === "deg") return String(Math.round(value));
  if (schema.unit === "x") return value.toFixed(2);
  if (unit === "in") return (value / MM_PER_IN).toFixed(3);
  return value.toFixed(mmDecimals(schema));
}

/** Parse a number typed in the display unit back to the internal (mm/deg/x) value, or null. */
function parseToStored(schema, raw, unit) {
  const v = parseFloat(raw);
  if (!isFinite(v)) return null;
  return isLength(schema) && unit === "in" ? v * MM_PER_IN : v;
}

/** Snap to the slider step and clamp to [min, max] (all in internal units). */
function snapClamp(schema, value, max) {
  const stepped = Math.round((value - schema.min) / schema.step) * schema.step + schema.min;
  const clamped = Math.min(Math.max(stepped, schema.min), max);
  // Kill floating-point crud from the step arithmetic.
  return parseFloat(clamped.toFixed(6));
}

// Swapped in under the Mounting Hole panel while the tester is on screen. The handle-mode
// hint it replaces lives in index.html and is read back out of the DOM on startup, so the
// markup stays the single home for that copy.
// Count and spacing are read from the tester's own constants, so tuning the sweep can't
// leave the copy lying. In inches the spacing is quoted both ways: the labels step by the
// converted figure, but the plate is built on a millimetre grid and that is the honest one.
const testerSpacing = (unit) =>
  unit === "in"
    ? `${sizeLabel(SIZE_STEP, "in")}&Prime; (${SIZE_STEP}&nbsp;mm)`
    : `${SIZE_STEP}&nbsp;mm`;
const testerHint = (unit) =>
  `${SIZE_COUNT} holes, ${testerSpacing(unit)} apart, centred on your target. ` +
  "Print the plate and push each hole onto your controller stem — " +
  "whichever one grips the way you want, read its number and type that into Hole diameter on your handle.";

export class UI {
  constructor(store) {
    this.store = store;
    this.modelPicker = document.getElementById("model-picker");
    this.shapeControls = document.getElementById("shape-controls");
    this.mountControls = document.getElementById("mount-controls");
    this.sizeReadout = document.getElementById("size-readout");
    this.mountHint = document.getElementById("mount-hint");
    this.handleHint = this.mountHint ? this.mountHint.innerHTML : "";
    this.sliderEls = new Map(); // key -> { input, value, schema }

    this._buildModelPicker();
    this._buildControls();
    this._wireUnitToggle();
    this._wireBoreTester();
    this._applyMode();

    const resetBtn = document.getElementById("reset-values");
    if (resetBtn) resetBtn.addEventListener("click", () => store.resetParams());

    store.subscribe((reason) => {
      if (reason === "model") {
        this._syncModelPicker();
        this._buildControls();
        this._applyMode();
      } else if (reason === "param") {
        this._syncSliderValues();
      } else if (reason === "unit") {
        this._syncSliderValues();
        this._applyMode(); // the tester's hint quotes the step in the active unit
        if (this._lastDims) this.setSizeReadout(this._lastDims);
      }
    });
  }

  _buildModelPicker() {
    this.modelPicker.innerHTML = "";
    for (const m of MODELS) {
      if (m.hidden) continue; // the Bore Tester is a mode, not a style — it has its own way in
      const card = document.createElement("button");
      card.type = "button";
      card.className = "model-card" + (m.id === this.store.modelId ? " is-active" : "");
      card.dataset.id = m.id;
      card.setAttribute("role", "radio");
      card.setAttribute("aria-checked", String(m.id === this.store.modelId));
      card.innerHTML = `${m.icon}<span class="label">${m.label}</span>`;
      card.addEventListener("click", () => this.store.setModel(m.id));
      this.modelPicker.appendChild(card);
    }
  }

  _syncModelPicker() {
    for (const card of this.modelPicker.children) {
      const active = card.dataset.id === this.store.modelId;
      card.classList.toggle("is-active", active);
      card.setAttribute("aria-checked", String(active));
    }
  }

  _buildControls() {
    this.sliderEls.clear();
    this.shapeControls.innerHTML = "";
    this.mountControls.innerHTML = "";
    const schema = fullSchema(this.store.model);
    for (const s of schema) {
      const target = s.group === "mount" ? this.mountControls : this.shapeControls;
      target.appendChild(this._makeSlider(s));
    }
  }

  _makeSlider(schema) {
    const wrap = document.createElement("div");
    wrap.className = "control";

    const head = document.createElement("div");
    head.className = "control-head";
    const label = document.createElement("span");
    label.className = "control-label";
    label.textContent = schema.label;

    // Editable value: a number input plus a unit label, styled to read like text.
    const valWrap = document.createElement("span");
    valWrap.className = "control-value";
    const numEl = document.createElement("input");
    numEl.type = "number";
    numEl.className = "control-num";
    numEl.step = schema.step;
    numEl.setAttribute("aria-label", `${schema.label} value`);
    const unitEl = document.createElement("span");
    unitEl.className = "control-unit";
    valWrap.append(numEl, unitEl);
    head.append(label, valWrap);

    const input = document.createElement("input");
    input.type = "range";
    input.min = schema.min;
    input.max = this._dynamicMax(schema);
    input.step = schema.step;
    input.value = this.store.params[schema.key];
    input.setAttribute("aria-label", schema.label);

    // Dragging the slider -> update the store + typed value.
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      numEl.value = displayNumber(schema, v, this.store.unit);
      this.store.setParam(schema.key, v);
    });
    // Double-click the slider resets just this control to its default.
    input.addEventListener("dblclick", () => {
      this.store.resetParam(schema.key);
      this._syncOne(schema.key);
    });

    // Typing a value -> parse (in display unit), snap to step, clamp to range, apply.
    const commitTyped = () => {
      const stored = parseToStored(schema, numEl.value, this.store.unit);
      if (stored === null) {
        this._syncOne(schema.key); // revert junk input to the current value
        return;
      }
      const v = snapClamp(schema, stored, this._dynamicMax(schema));
      input.value = v;
      this.store.setParam(schema.key, v);
      numEl.value = displayNumber(schema, v, this.store.unit);
    };
    numEl.addEventListener("change", commitTyped);
    numEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") numEl.blur();
    });

    wrap.append(head, input);
    this.sliderEls.set(schema.key, { input, num: numEl, unit: unitEl, schema });
    this._syncOne(schema.key);
    return wrap;
  }

  // Refresh one control's slider, typed number, and unit label from the store.
  _syncOne(key) {
    const entry = this.sliderEls.get(key);
    if (!entry) return;
    const { input, num, unit, schema } = entry;
    const max = this._dynamicMax(schema);
    if (parseFloat(input.max) !== max) input.max = max;
    const v = this.store.params[key];
    if (parseFloat(input.value) !== v) input.value = v;
    // Give the number field the same bounds/step so its native spinner obeys them.
    const inUnit = isLength(schema) && this.store.unit === "in";
    num.min = inUnit ? (schema.min / MM_PER_IN).toFixed(3) : schema.min;
    num.max = inUnit ? (max / MM_PER_IN).toFixed(3) : max;
    num.step = inUnit ? 0.001 : schema.step;
    if (document.activeElement !== num) num.value = displayNumber(schema, v, this.store.unit);
    unit.textContent = unitSuffix(schema, this.store.unit);
  }

  // Some sliders have a dynamic ceiling that depends on other params (e.g. edge rounding
  // scaled to the top radius, or wall length capped to the base length).
  _dynamicMax(schema) {
    // Snapped onto the slider's own step grid: a computed ceiling is an arbitrary real
    // number (the bore's comes out of the shape), and an off-grid max leaves the readout
    // showing digits the handle can never land on.
    const snap = (v) => snapDownToStep(schema, v);
    // A maxFn NARROWS the declared range, never widens it — the shape can rule a value out,
    // but it cannot grant one the slider was never meant to offer.
    // reachFn is how far the slider may TRAVEL (the store will raise other params to meet
    // it); fitFn is what fits right now. Either way it narrows the declared range, never
    // widens it.
    const rangeFn = schema.reachFn || schema.fitFn || schema.maxFn;
    if (rangeFn) return Math.min(schema.max, snap(rangeFn(this.store.params, this.store.model)));
    return schema.max;
  }

  // Refresh slider positions + readouts from the store (after model/param/unit change).
  _syncSliderValues() {
    for (const key of this.sliderEls.keys()) this._syncOne(key);
  }

  _wireBoreTester() {
    this.testerBtn = document.getElementById("bore-tester-toggle");
    if (!this.testerBtn) return;
    this.testerBtn.addEventListener("click", () => {
      if (this.store.isTesting) this.store.exitBoreTester();
      else this.store.enterBoreTester();
    });
  }

  /**
   * Show only the panels the active model has something to say about. The two conditions
   * are the model's OWN declared flags rather than "are we in the tester", so the flags in
   * models.js are what actually drives the layout:
   *
   *   bare      -> defines its whole schema itself, so there is no separate Shape section
   *   noProfile -> has no revolved cross-section, so the profile editor means nothing
   *
   * The style picker is the one genuinely mode-specific case: the tester is not a handle
   * style, so offering the picker while it is on screen would be a trap.
   */
  _applyMode() {
    const model = this.store.model;
    const testing = this.store.isTesting;
    const hide = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("is-hidden", v);
    };
    hide("style-panel", testing);
    hide("shape-panel", !!model.bare);
    hide("profile-panel", !!model.noProfile);

    const title = document.getElementById("mount-title");
    if (title) title.textContent = testing ? "Bore Fit Tester" : "Mounting Hole";
    if (this.mountHint) this.mountHint.innerHTML = testing ? testerHint(this.store.unit) : this.handleHint;
    if (this.testerBtn) {
      this.testerBtn.textContent = testing ? "← Back to handle" : "Print a fit tester";
      this.testerBtn.classList.toggle("is-active", testing);
    }
  }

  _wireUnitToggle() {
    const btns = document.querySelectorAll(".unit-btn");
    for (const btn of btns) {
      btn.addEventListener("click", () => {
        btns.forEach((b) => b.classList.toggle("is-active", b === btn));
        this.store.setUnit(btn.dataset.unit);
      });
    }
  }

  setSizeReadout(dims) {
    this._lastDims = dims;
    const u = this.store.unit;
    const fmt = (v) => (u === "in" ? `${(v / MM_PER_IN).toFixed(2)}″` : `${v.toFixed(1)} mm`);
    // A flat plate has no meaningful diameter — show its bed footprint instead. Thickness
    // is the plate itself, NOT the bounding box: the box includes the raised labels, and
    // the number that matters is how much bore actually engages the stem.
    // A model that declares a flat thickness is a plate, not a handle: it has no meaningful
    // diameter, and its thickness is the plate itself rather than the bounding box (which
    // includes the raised labels).
    const flat = this.store.model.flatThickness;
    this.sizeReadout.textContent = flat != null
      ? `${fmt(dims.width)} × ${fmt(dims.depth)} · ${fmt(flat)} thick`
      : `Ø ${fmt(Math.max(dims.width, dims.depth))} · H ${fmt(dims.height)}`;
  }
}
