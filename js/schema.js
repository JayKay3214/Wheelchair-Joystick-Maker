/**
 * Slider schemas: the shared vocabulary a model uses to describe a control, and the
 * arithmetic for holding a value inside one.
 *
 * A schema entry is plain data — `{ key, label, min, max, step, group, unit, def }` — plus
 * up to four optional hooks. Each answers a different question, and only the hooks a
 * control actually needs are declared:
 *
 *   fitFn(params, model)    What fits RIGHT NOW. The store clamps to this on every change,
 *                           so it is the one that decides the stored value. Never widens
 *                           the declared `max` — a shape can rule a value out, it cannot
 *                           grant one the slider was never meant to offer.
 *
 *   reachFn(params, model)  How far the SLIDER may travel, when moving it is how you ask
 *                           for something bigger. Read only when building the control.
 *                           Defaults to fitFn. Only differs where a growFn will raise
 *                           other params to meet the request — capping travel at what
 *                           fits today would make that unreachable.
 *
 *   growFn(params, model)   `{ otherKey: minimumValue }` — what else must move up for this
 *                           value to be buildable. Applied only on a direct edit to this
 *                           control, never during clamping: otherwise a param would spring
 *                           back every time you tried to lower it.
 *
 *   normalise(value)        Final word on the value, for a range where some sub-range is
 *                           meaningless. Runs after clamping, so it must only move values
 *                           further inside the range, never back out of it.
 */

/** The ceiling in force right now: the declared max, narrowed by fitFn if there is one. */
export function ceilingFor(schema, params, model) {
  const raw = schema.fitFn ? schema.fitFn(params, model) : schema.max;
  return Math.max(schema.min, Math.min(schema.max, raw));
}

/** How far the control may be dragged: reachFn if declared, else the current ceiling. */
export function reachFor(schema, params, model) {
  const raw = schema.reachFn ? schema.reachFn(params, model) : ceilingFor(schema, params, model);
  return Math.max(schema.min, Math.min(schema.max, raw));
}

/**
 * Round onto the control's own step grid. A ceiling derived from a shape is an arbitrary
 * real number; the slider can only sit on multiples of its step, so the store's clamped
 * value and the slider's max have to agree on which number that is.
 */
export function snapDownToStep(schema, value) {
  return clean(Math.max(schema.min, Math.floor(value / schema.step) * schema.step));
}

/** The same, rounding up — used when raising a param to meet a minimum a growFn asks for. */
export function snapUpToStep(schema, value) {
  return clean(Math.max(schema.min, Math.ceil(value / schema.step) * schema.step));
}

/** Hold a value inside the control's declared range. */
export function clampToSchema(schema, value) {
  return clean(Math.min(Math.max(value, schema.min), schema.max));
}

/** Kill the floating-point crud that step arithmetic leaves behind. */
function clean(v) {
  return parseFloat(v.toFixed(6));
}
