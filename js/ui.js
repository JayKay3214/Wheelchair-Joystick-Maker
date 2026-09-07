// Copyright 2026 Jayden Collier and Jayke Collier
// SPDX-License-Identifier: Apache-2.0

import { MODELS, fullSchema } from "./models.js";
import { floorFor, reachFor, snapDownToStep, snapUpToStep } from "./schema.js";
import { MM_PER_IN } from "./units.js";
import { SIZE_COUNT, SIZE_STEP, sizeLabel } from "./boreTester.js";

// Slider sections, in the order they appear above the Mounting Hole panel. A model only shows
// the groups its schema actually uses, so no model has to declare every one of these.
const SLIDER_GROUPS = ["shape", "base", "handle", "walls", "stem"];
const GROUP_TITLES = {
  shape: "Shape",
  base: "Base",
  handle: "Handle",
  walls: "Side Walls",
  stem: "Stem",
  screw: "Set screw hole",
};

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
function snapClamp(schema, value, max, min = schema.min) {
  const stepped = Math.round((value - schema.min) / schema.step) * schema.step + schema.min;
  const clamped = Math.min(Math.max(stepped, min), max);
  // Kill floating-point crud from the step arithmetic.
  return parseFloat(clamped.toFixed(6));
}

// The two hints the Mounting Hole panel swaps between. Both live here rather than one
// here and one in the markup: read out of the DOM, the handle hint would silently become
// empty if the element were renamed, and one panel's copy having two homes invites drift.
// Count and spacing are read from the tester's own constants, so tuning the sweep can't
// leave the copy lying. In inches the spacing is quoted both ways: the labels step by the
// converted figure, but the plate is built on a millimetre grid and that is the honest one.
const testerSpacing = (unit) =>
  unit === "in"
    ? `${sizeLabel(SIZE_STEP, "in")}&Prime; (${SIZE_STEP}&nbsp;mm)`
    : `${SIZE_STEP}&nbsp;mm`;
const HANDLE_HINT =
  'Most powerchair joysticks (Permobil, Pride, Quantum, Quickie) use a 6.35&nbsp;mm (1/4&quot;) ' +
  'stem. Print a test fit before committing.';
const testerHint = (unit) =>
  `${SIZE_COUNT} holes, ${testerSpacing(unit)} apart, centred on your target. ` +
  "Print the plate and push each hole onto your controller stem — " +
  "whichever one grips the way you want, read its number and type that into Hole diameter on your handle.";

export class UI {
  constructor(store) {
    this.store = store;
    this.modelPicker = document.getElementById("model-picker");
    this.shapeSections = document.getElementById("shape-sections");
    this.screwSection = document.getElementById("screw-section");
    this.mountControls = document.getElementById("mount-controls");
    this.sizeReadout = document.getElementById("size-readout");
    this.mountHint = document.getElementById("mount-hint");
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
    this.shapeSections.innerHTML = "";
    this.mountControls.innerHTML = "";
    if (this.screwSection) this.screwSection.innerHTML = "";

    // Bucket the schema by group, preserving each group's declared slider order.
    const byGroup = new Map();
    for (const s of fullSchema(this.store.model)) {
      if (s.showIf && !s.showIf(this.store.params, this.store.model)) continue;
      const g = s.group || "shape";
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(s);
    }

    // The mounting hole keeps its own hand-written panel (it owns the fit-tester button).
    for (const s of byGroup.get("mount") || []) this.mountControls.appendChild(this._makeControl(s));
    byGroup.delete("mount");

    // The set screw sits below the mounting hole rather than above it, so it gets its own
    // container in the markup instead of riding along with the shape sections.
    if (this.screwSection && byGroup.has("screw")) {
      this.screwSection.appendChild(this._makeSection("screw", byGroup.get("screw")));
      byGroup.delete("screw");
    }

    // Shape-ish groups in a fixed order, then anything unrecognised so a new group can never
    // silently vanish from the UI.
    const order = [...SLIDER_GROUPS.filter((g) => byGroup.has(g)), ...[...byGroup.keys()].filter((g) => !SLIDER_GROUPS.includes(g))];
    let lastSection = null;
    for (const g of order) {
      const section = this._makeSection(g, byGroup.get(g));
      this.shapeSections.appendChild(section);
      lastSection = section;
    }
    if (lastSection) {
      const tip = document.createElement("p");
      tip.className = "hint";
      tip.textContent = "Tip: double-click a slider to reset just that value.";
      lastSection.appendChild(tip);
    }
  }

  /**
   * One panel for a slider group. A `type: "toggle"` entry in the group is promoted into the
   * section header — the switch reads as part of the heading ("SET SCREW HOLE [ ]") rather
   * than as one more control in the list, and the sliders it governs sit under it.
   */
  _makeSection(group, entries) {
    const section = document.createElement("section");
    section.className = "panel";
    const toggle = entries.find((e) => e.type === "toggle");
    const title = document.createElement("h2");
    title.className = "panel-title";
    title.textContent = GROUP_TITLES[group] || group;
    if (toggle) {
      const row = document.createElement("div");
      row.className = "panel-title-row";
      row.append(title, this._makeToggleSwitch(toggle));
      section.appendChild(row);
    } else {
      section.appendChild(title);
    }
    for (const e of entries) {
      if (e === toggle) continue;
      section.appendChild(this._makeControl(e));
    }
    return section;
  }

  /** A schema entry becomes either a slider or, for `type: "toggle"`, a switch. */
  _makeControl(schema) {
    return schema.type === "toggle" ? this._makeToggle(schema) : this._makeSlider(schema);
  }

  /** Just the switch, for use in a section header where the heading is already the label. */
  _makeToggleSwitch(schema) {
    const label = document.createElement("label");
    label.className = "toggle-switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "toggle-input";
    input.checked = !!this.store.params[schema.key];
    input.setAttribute("aria-label", schema.label);
    const track = document.createElement("span");
    track.className = "toggle-track";
    track.setAttribute("aria-hidden", "true");
    input.addEventListener("change", () => {
      this.store.setParam(schema.key, input.checked ? 1 : 0);
      this._buildControls(); // reveals/hides the sliders this switch governs
    });
    label.append(input, track);
    return label;
  }

  _makeToggle(schema) {
    const wrap = document.createElement("div");
    wrap.className = "control control-toggle";

    const label = document.createElement("label");
    label.className = "toggle-row";
    const text = document.createElement("span");
    text.className = "control-label";
    text.textContent = schema.label;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "toggle-input";
    input.checked = !!this.store.params[schema.key];
    const track = document.createElement("span");
    track.className = "toggle-track";
    track.setAttribute("aria-hidden", "true");

    // Flipping it reveals or hides the controls that only matter while it is on, so the
    // section has to be rebuilt rather than just re-synced.
    input.addEventListener("change", () => {
      this.store.setParam(schema.key, input.checked ? 1 : 0);
      this._buildControls();
    });

    label.append(text, input, track);
    wrap.appendChild(label);
    return wrap;
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
    input.min = this._dynamicMin(schema);
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
        this._syncOne(schema.key, true); // revert junk input to the current value
        return;
      }
      this.store.setParam(schema.key, snapClamp(schema, stored, this._dynamicMax(schema), this._dynamicMin(schema)));
      // Read back what the store SETTLED on rather than echoing what we sent. It may have
      // moved: a hole depth below the shallowest cuttable one normalises to 0, and a shape
      // may not have room for what was asked. Echoing the request left the number field
      // claiming a value the model had already rejected, while the slider beside it —
      // refreshed from the store — showed the truth. The two disagreed on screen.
      this._syncOne(schema.key, true);
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

  /**
   * Refresh one control's slider, typed number and unit label from the store.
   * `force` overrides the don't-clobber-what-they're-typing guard — used right after a
   * commit, where the store may have settled on a different value than was typed.
   */
  _syncOne(key, force = false) {
    const entry = this.sliderEls.get(key);
    if (!entry) return;
    const { input, num, unit, schema } = entry;
    const max = this._dynamicMax(schema);
    if (parseFloat(input.max) !== max) input.max = max;
    const min = this._dynamicMin(schema);
    if (parseFloat(input.min) !== min) input.min = min;
    const v = this.store.params[key];
    if (parseFloat(input.value) !== v) input.value = v;
    // Give the number field the same bounds/step so its native spinner obeys them.
    const inUnit = isLength(schema) && this.store.unit === "in";
    num.min = inUnit ? (min / MM_PER_IN).toFixed(3) : min;
    num.max = inUnit ? (max / MM_PER_IN).toFixed(3) : max;
    num.step = inUnit ? 0.001 : schema.step;
    if (force || document.activeElement !== num) num.value = displayNumber(schema, v, this.store.unit);
    unit.textContent = unitSuffix(schema, this.store.unit);
  }

  // ...and a few have a dynamic FLOOR too (the set screw cannot sit lower than its own
  // radius without breaking through the underside), snapped up onto the step grid so the
  // handle can actually land on it.
  _dynamicMin(schema) {
    return snapUpToStep(schema, floorFor(schema, this.store.params, this.store.model));
  }

  // Some sliders have a dynamic ceiling that depends on other params (e.g. edge rounding
  // scaled to the top radius, or wall length capped to the base length).
  _dynamicMax(schema) {
    // How far this control may travel (see js/schema.js), snapped onto its own step grid:
    // a computed ceiling is an arbitrary real number, and an off-grid max leaves the
    // readout showing digits the handle can never land on.
    return snapDownToStep(schema, reachFor(schema, this.store.params, this.store.model));
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
    hide("shape-sections", !!model.bare);
    hide("profile-panel", !!model.noProfile);

    const title = document.getElementById("mount-title");
    if (title) title.textContent = testing ? "Bore Fit Tester" : "Mounting Hole";
    if (this.mountHint) this.mountHint.innerHTML = testing ? testerHint(this.store.unit) : HANDLE_HINT;
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
    // A model that declares a flat thickness is a plate, not a handle: it has no meaningful
    // diameter, and the number that matters is the plate itself — NOT the bounding box,
    // which includes the raised labels — because that is how much bore engages the stem.
    const flat = this.store.model.flatThickness;
    this.sizeReadout.textContent = flat != null
      ? `${fmt(dims.width)} × ${fmt(dims.depth)} · ${fmt(flat)} thick`
      : `Ø ${fmt(Math.max(dims.width, dims.depth))} · H ${fmt(dims.height)}`;
  }
}
