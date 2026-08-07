# Joystick Maker — Wheelchair Joystick Customizer

A browser tool for designing custom **wheelchair / powerchair joystick handles** and exporting them
as **STL** and **OBJ** files for 3D printing. Inspired by
[Vasecreator](https://github.com/gewoonkees132/Vasecreator): you shape the handle with simple sliders
(and an optional draggable profile), see a **live 3D preview**, and download a print-ready model.

The round handle shapes are generated with the **revolution (lathe) technique** — a 2D outline is
spun around the centre axis — exactly as requested. The mounting hole is built directly into that
outline, so every export is a **watertight, manifold solid** with no boolean/CSG step.

## Handle styles

Based on the 8 common powerchair handles, this version ships the five that are revolution-based:

| Style | Notes |
|-------|-------|
| **Ball** | Rounded ball/knob with adjustable diameter and squash. |
| **Mushroom** | Domed cap wider than the stem, with an adjustable undercut. |
| **Chin Cup** | Flared cup with a concave (inward) bowl top for chin control. |
| **Remote+ (Carrot)** | Tapered truncated cone. |
| **I-Handle** | Tapered grip with an optional lean (the stem and bore stay vertical for mounting). |

**Edge rounding:** styles with sharp edges (Chin Cup, Carrot, I-Handle) expose an *Edge rounding*
slider that fillets the outer edges — the bowl lip, the frustum edges, or the I-Handle's top and
stem/head shoulder. It never affects the mounting bore. Smooth styles (Ball, Mushroom) hide the
slider since they have no sharp edges.

> **Coming later:** **T-Bar** and **Goal Posts** are non-symmetric and need swept geometry, plus extra
> bore types (D-shape / hex / set-screw). The model registry (`js/models.js`) and bore generator are
> built so these drop in as new entries without restructuring.

## Mounting hole (controller fit)

Every handle has a configurable round bore at the base:

- **Hole diameter** — default **6.35 mm (1/4")**, the common friction-fit stem on Permobil, Pride,
  Quantum, Quickie and similar gimbals.
- **Hole depth** — how far the controller stem inserts.

**Always print a test fit first** and adjust the diameter ±0.1–0.3 mm to suit your printer and the
desired friction. Units default to millimetres (the 3D-printing standard); a mm/inch toggle changes the
on-screen readouts only.

### Bore fit tester

Rather than guessing at that ±0.1–0.3 mm, hit **Print a fit tester** under the Hole diameter slider.
It swaps the viewport for a flat test plate: one true through-hole per candidate diameter, each with
its size raised beside it in 7-segment digits.

There is **one control — the target size.** The plate is always seven holes, 0.1 mm apart, centred on
that target, which is exactly the adjustment range above. Set the target to 6.70 and you get:

```
6.40 · 6.50 · 6.60 · [6.70] · 6.80 · 6.90 · 7.00      125.6 x 21.0 x 8.6 mm
```

- The target is seeded from whatever Hole diameter your handle currently has, and **Back to handle**
  restores that handle untouched — style, sliders and profile drags included.
- The holes are facetted exactly like a real handle bore, so the fit you measure is the fit you get.
- Exports as `bore-test_6.40-7.00_step0.10.stl`, so a folder of coupons stays readable.

Print it, push each hole onto your controller's stem, and type the number that grips the way you want
into **Hole diameter**.

To sweep wider or finer, change `BT_STEP` / `BT_COUNT` in `js/models.js` — the plate resizes itself,
and wraps a long run into a grid rather than growing off the bed.

## Run locally

No build step and no dependencies to install — it's a static site using Three.js from a CDN.

```bash
cd Wheelchair_Joystick_Maker
python3 -m http.server 8000
# open http://localhost:8000
```

(Any static server works; it must be served over http:// — opening `index.html` via `file://` will be
blocked by the browser's ES-module rules.)

## Deploy to Vercel

This is a zero-config static deployment:

1. Push the folder to a Git repo (or run `vercel` from the CLI).
2. In Vercel, import the project with **Framework Preset = "Other"**, **no build command**, and
   **output directory = the repo root**.
3. Deploy. `vercel.json` is included to set the right `Content-Type` for the JS modules and enable clean
   URLs.

Because Three.js is loaded via a CDN import map, nothing needs bundling. (If you ever want CDN
independence, vendor `three` locally and point the import map in `index.html` at the local files — no
other code changes needed.)

## How it works

```
index.html        layout + Three.js import map (CDN, buildless)
style.css         UI styling
js/
  main.js         wires everything together + render loop
  scene.js        Three.js scene, camera, lights, OrbitControls, grid
  state.js        single source of truth (model, params, profile, units)
  models.js       handle-style registry (shape generators + slider schemas) + bore-tester layout
  geometry.js     assembles the closed cross-section + bore -> LatheGeometry
  profileEditor.js draggable 2D profile canvas
  ui.js           sliders, model picker, unit toggle
  exporter.js     STL (binary) + OBJ export, rotated Z-up for printing
```

### Editing the shape

- **Sliders** are the primary control (diameter, height, taper, stem, bore, etc.).
- The **Profile** panel shows the cross-section; **drag the points** to fine-tune the outline. Drags
  persist until you move a slider for that style (which regenerates the base shape). **Reset shape**
  restores the slider-defined outline.

## Printing tips

- Exports are in **millimetres**, oriented **bore-down** (stem on the bed) so the hole prints cleanly.
- Print the stem/bore area solid (high infill or extra walls) for a durable press-fit.
- A small brim helps adhesion for tall styles like the I-Handle and Carrot.

## License / attribution

Built with [Three.js](https://threejs.org/). Design and interaction inspired by the GPL-3.0
[Vasecreator](https://github.com/gewoonkees132/Vasecreator) project.
