import { MODELS, fullSchema } from "./models.js";

const MM_PER_IN = 25.4;

/** Format a stored value (always mm/deg/x internally) for display in the chosen unit. */
function formatValue(schema, value, unit) {
  if (schema.unit === "deg") return `${Math.round(value)}°`;
  if (schema.unit === "x") return `${value.toFixed(2)}×`;
  // length
  if (unit === "in") return `${(value / MM_PER_IN).toFixed(3)}″`;
  const dec = schema.step < 0.1 ? 2 : schema.step < 1 ? 1 : 0;
  return `${value.toFixed(dec)} mm`;
}

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

    const resetBtn = document.getElementById("reset-values");
    if (resetBtn) resetBtn.addEventListener("click", () => store.resetParams());

    store.subscribe((reason) => {
      if (reason === "model") {
        this._syncModelPicker();
        this._buildControls();
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
    const valEl = document.createElement("span");
    valEl.className = "control-value";
    head.append(label, valEl);

    const input = document.createElement("input");
    input.type = "range";
    input.min = schema.min;
    input.max = this._dynamicMax(schema);
    input.step = schema.step;
    input.value = this.store.params[schema.key];
    input.setAttribute("aria-label", schema.label);

    const onInput = () => {
      const v = parseFloat(input.value);
      valEl.textContent = formatValue(schema, v, this.store.unit);
      this.store.setParam(schema.key, v);
    };
    input.addEventListener("input", onInput);
    // Double-click resets just this slider to its default.
    input.addEventListener("dblclick", () => {
      this.store.resetParam(schema.key);
      input.value = this.store.params[schema.key];
      valEl.textContent = formatValue(schema, parseFloat(input.value), this.store.unit);
    });

    valEl.textContent = formatValue(schema, parseFloat(input.value), this.store.unit);
    wrap.append(head, input);
    this.sliderEls.set(schema.key, { input, value: valEl, schema });
    return wrap;
  }

  // Edge rounding gets a dynamic ceiling scaled to the shape (e.g. its top radius).
  _dynamicMax(schema) {
    if (schema.key === "edgeRound" && this.store.model.edgeRoundMax) {
      return Math.max(0.25, this.store.model.edgeRoundMax(this.store.params));
    }
    return schema.max;
  }

  // Refresh slider positions + readouts from the store (after model/param/unit change).
  _syncSliderValues() {
    for (const [key, { input, value, schema }] of this.sliderEls) {
      const max = this._dynamicMax(schema);
      if (parseFloat(input.max) !== max) input.max = max;
      const v = this.store.params[key];
      if (parseFloat(input.value) !== v) input.value = v;
      value.textContent = formatValue(schema, v, this.store.unit);
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
    this.sizeReadout.textContent = `Ø ${fmt(Math.max(dims.width, dims.depth))} · H ${fmt(dims.height)}`;
  }
}
