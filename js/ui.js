import { MODELS, fullSchema } from "./models.js";

const MM_PER_IN = 25.4;

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

// Hint text swapped in and out with the bore-tester mode.
const HANDLE_HINT =
  'Most powerchair joysticks (Permobil, Pride, Quantum, Quickie) use a 6.35&nbsp;mm (1/4") stem. Print a test fit before committing.';
const TESTER_HINT =
  "Nine holes, 0.1&nbsp;mm apart, centred on your target. Print the plate and push each hole onto your controller stem — whichever one grips the way you want, read its number and type that into Hole diameter on your handle.";

export class UI {
  constructor(store) {
    this.store = store;
    this.modelPicker = document.getElementById("model-picker");
    this.shapeControls = document.getElementById("shape-controls");
    this.mountControls = document.getElementById("mount-controls");
    this.sizeReadout = document.getElementById("size-readout");
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
        if (this._lastDims) this.setSizeReadout(this._lastDims);
      }
    });
  }

  _buildModelPicker() {
    this.modelPicker.innerHTML = "";
    for (const m of MODELS) {
      if (m.hidden) continue; // e.g. Goal Posts — kept in code, hidden from the picker
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
    if (schema.maxFn) return Math.max(schema.min, schema.maxFn(this.store.params));
    if (schema.key === "edgeRound" && this.store.model.edgeRoundMax) {
      return Math.max(0.25, this.store.model.edgeRoundMax(this.store.params));
    }
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
   * The bore tester borrows the sidebar rather than adding a whole second one: the style
   * picker, the shape panel and the profile editor have nothing to say about a flat test
   * plate, so they step aside and the tester's sliders take over the Mounting Hole panel.
   * "Reset all" and the mm/in toggle move across to whichever panel heading is on screen.
   */
  _applyMode() {
    const testing = this.store.isTesting;
    const hide = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("is-hidden", v);
    };
    hide("style-panel", testing);
    hide("shape-panel", testing);
    hide("profile-panel", testing);

    const actions = document.getElementById("title-actions");
    const row = document.getElementById(testing ? "mount-title-row" : "shape-title-row");
    if (actions && row && actions.parentElement !== row) row.appendChild(actions);

    const title = document.getElementById("mount-title");
    if (title) title.textContent = testing ? "Bore Fit Tester" : "Mounting Hole";
    const hint = document.getElementById("mount-hint");
    if (hint) hint.innerHTML = testing ? TESTER_HINT : HANDLE_HINT;
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
    // A flat plate has no meaningful diameter — show its bed footprint instead.
    this.sizeReadout.textContent = this.store.isTesting
      ? `${fmt(dims.width)} × ${fmt(dims.depth)} · ${fmt(dims.height)} thick`
      : `Ø ${fmt(Math.max(dims.width, dims.depth))} · H ${fmt(dims.height)}`;
  }
}
