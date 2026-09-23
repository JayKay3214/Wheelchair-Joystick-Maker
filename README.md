# Joystick Maker — Wheelchair Joystick Customizer

Source: **https://github.com/JayKay3214/Wheelchair-Joystick-Maker**

A browser tool for designing custom **wheelchair / powerchair joystick handles** and exporting them
as **STL**, **OBJ** and **STEP** files for 3D printing and CAD. Inspired by
[Vasecreator](https://github.com/gewoonkees132/Vasecreator): you shape the handle with simple sliders
(and an optional draggable profile), see a **live 3D preview**, and download a print-ready model.

The round handle shapes are generated with the **revolution (lathe) technique** — a 2D outline is
spun around the centre axis. The mounting hole is built directly into that outline, so every export
is a **watertight, manifold solid** with no boolean step. The non-symmetric styles (Goal Posts,
T-Bar) are built as single hand-assembled solids instead, held to the same watertight standard.

The one exception is the optional **set screw hole** below: a sideways hole is not a solid of
revolution, so it is cut with a boolean (`three-bvh-csg`, loaded from the same CDN). The result is
still geometrically closed — verified by ray casting, and it slices and prints normally — but the
cut leaves T-junctions, so it does not meet the strict "every edge shared by exactly two triangles"
standard the rest of the app holds to. Leave the screw hole off and nothing changes.

## Handle styles

Eight styles, five of them revolution-based and three swept:

| Style | Notes |
|-------|-------|
| **Ball** | Rounded ball/knob with adjustable diameter and squash. |
| **Mushroom** | Domed cap wider than the stem, with an adjustable undercut. |
| **Chin Cup** | Flared cup with a concave (inward) bowl top for chin control. |
| **Carrot** | Tapered truncated cone. |
| **I-Handle** | Tapered grip with an optional lean (the stem and bore stay vertical for mounting). |
| **Goal Post** | Flat palm base with a straight side wall each side; adjustable base size, wall height/length and inside corner curve. |
| **Goal Post 2** | Oval saddle base — *Palm Rest* droops the front/back, *Side bend* curves the sides down — with a flat shelf (*Side Wall Width*) and a straight vertical wall at each widest point, plus a *Wall inner curve* fillet where the shelf meets the wall. |
| **T-Bar** | Horizontal bar handle on a central stem, with adjustable thickness, length, end droop and end taper. |

**Edge rounding:** styles with sharp edges (Chin Cup, Carrot, I-Handle) expose an *Edge rounding*
slider that fillets the outer edges — the bowl lip, the frustum edges, or the I-Handle's top and
stem/head shoulder. It never affects the mounting bore, and it leaves the foot where the part meets
the bed square. Smooth styles (Ball, Mushroom) hide the slider since they have no sharp edges.

> **Coming later:** extra bore profiles (D-shape / hex). The model registry (`js/models.js`) and
> bore generator are built so these drop in as new entries without restructuring.

## Mounting hole (controller fit)

Every handle has a configurable round bore at the base:

- **Hole diameter** — default **6.7 mm**, sized for the common ~6.35 mm (1/4") friction-fit stem on
  Permobil, Pride, Quantum, Quickie and similar gimbals, with a little printer allowance.
- **Hole depth** — how far the controller stem inserts.

**Always print a test fit first** and adjust the diameter ±0.1–0.3 mm to suit your printer and the
desired friction. Units default to millimetres (the 3D-printing standard); a mm/inch toggle changes the
on-screen readouts, and the unit the fit tester's plate is marked in. Exported geometry is always mm,
whichever unit is on screen.

Setting **Hole depth** to 0 gives a solid handle with no mounting hole. A shape with no room for a
bore — a Goal Post with the stem wound right down, say — reports 0 as well, rather than claiming a
depth it hasn't got.

### Set screw hole

Optional, off by default: a sideways hole through the wall of the stem so a grub screw can clamp the
handle onto the controller stem and stop it pulling off.

- **Screw hole diameter** — size the hole for your screw. For a self-tapping screw into plastic,
  drill it a little under the screw's outside diameter.
- **Screw hole height** — how far up the stem the hole's centre sits, measured from the print bed.

The hole runs from the outside surface in to the centre axis. That is deliberately deep enough to
break into the mounting bore — a screw that stops inside the wall grips nothing — and it can never
punch out the far side. Both sliders know their own limits: the height cannot drop so low the hole
breaks out of the underside, nor rise above the bore, and both bounds move as you change the
diameter. On a shape with no room for one, the hole is simply not cut.

Because the hole is horizontal when printed, its top is a short unsupported overhang. At the usual
3-4 mm it bridges fine; if you go much bigger, expect a little sag at the top of the hole.

### Bore fit tester

Rather than guessing at that ±0.1–0.3 mm, hit **Print a fit tester** at the bottom of the Mounting
Hole section.
It swaps the viewport for a flat test plate: one true through-hole per candidate diameter, each with
its size raised beside it in 7-segment digits.

There is **one control — the target size.** The plate is always nine holes, 0.1 mm apart, centred on
that target, so it covers the adjustment range above with a step to spare at each end. Set the target
to 6.70 and you get:

```
        6.30   6.40   6.50
        6.60  [6.70]  6.80         53.8 x 63.3 mm, 8 mm thick
        6.90   7.00   7.10
```

- The layout is always the **squarest grid** the sizes will make, never a long strip: a row of nine
  would be 160 mm and overrun a small bed, and long thin plates lift at the corners. The plate tops
  out at 67 x 91 mm with the target at its 16 mm maximum, so it fits any common bed.
- The target is seeded from whatever Hole diameter your handle currently has, and **Back to handle**
  restores that handle untouched — style, sliders and profile drags included.
- The holes are facetted exactly like a real handle bore, so the fit you measure is the fit you get.
- The labels follow the mm/inch toggle — in inches the same plate reads `0.248 … 0.280`, at three
  decimals so no two holes share a number.
- Exports as `bore-test_6.30-7.10mm_step0.10.stl`, or `bore-test_0.248-0.280in_step0.004.stl` in
  inches, so a folder of coupons stays readable.

Print it, push each hole onto your controller's stem, and type the number that grips the way you want
into **Hole diameter**.

To sweep wider or finer, change `SIZE_STEP` / `SIZE_COUNT` in `js/boreTester.js` — the plate re-grids itself
around whatever count you give it.

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
  models.js       handle-style registry (shape generators + slider schemas)
  schema.js       slider rules: reach/fit/floor/grow hooks and how a value is normalised
  boreTester.js   the fit tester's sizes, plate layout and 7-segment digits (all 2D)
  units.js        mm <-> inch conversion
  geometry.js     closed cross-section + bore -> LatheGeometry, plus the swept solids
                  (Goal Posts, T-Bar), the shared bored stem, and the CSG set screw cut
  profileEditor.js draggable 2D profile canvas
  ui.js           slider sections + numeric entry, model picker, unit toggle
  exporter.js     STL (binary), OBJ and STEP export, rotated Z-up for printing
```

### Editing the shape

- **Sliders** are the primary control (diameter, height, taper, stem, bore, etc.). Every slider also
  has a **number box** — type an exact value and it is clamped to that slider's range. Double-click a
  slider to reset just that value.
- Sliders are grouped into sections, and each style only shows the ones it has:

  | Style | Sections |
  |-------|----------|
  | Ball, Mushroom, Chin Cup, Carrot, I-Handle | **Shape** → **Stem** → **Mounting Hole** |
  | Goal Post, Goal Post 2 | **Base** → **Side Walls** → **Stem** → **Mounting Hole** |
  | T-Bar | **Handle** → **Stem** → **Mounting Hole** |

  The sections are generated from each model's schema (`group` on a slider), so adding a style — or a
  new group — needs no layout code.
- The **Profile** panel shows the cross-section. On the revolution styles you can **drag the points**
  to fine-tune the outline; drags persist until you move a slider for that style (which regenerates
  the base shape), and **Reset shape** restores the slider-defined outline. The swept styles (Goal
  Posts, T-Bar) show a read-only cross-section — shape them with the sliders.

## Exports

| Format | Use it for |
|--------|------------|
| **STL** (binary) | Printing. The standard slicer format. |
| **OBJ** | Printing / general 3D interchange. |
| **STEP** | CAD. Imports as a solid in FreeCAD, Fusion, SolidWorks etc. if you want to modify the part further. |

All three are millimetres at 1:1 and are rotated Z-up (bore facing down) on the way out.

## Printing tips

- Exports are in **millimetres**, oriented **bore-down** (stem on the bed) so the hole prints cleanly.
- Print the stem/bore area solid (high infill or extra walls) for a durable press-fit.
- A small brim helps adhesion for tall styles like the I-Handle and Carrot.

## Credits

In the app, these are behind the **ⓘ** button beside the title.

- **Jayden Collier** — Lead. Led the concept and direction: what to build, how it should work and
  how it should be put together.
- **Jayke Collier** — Developer. Drove the implementation and the AI-assisted coding workflow.

## License

Copyright 2026 Jayden Collier and Jayke Collier. Licensed under the
**[PolyForm Noncommercial License 1.0.0](LICENSE)**.

You are free to use, modify and distribute this software **for any noncommercial purpose**, on the
condition that you keep the copyright notice and the `LICENSE` text in any copy you distribute. The
license also grants you a patent license covering the software.

Noncommercial covers personal use — study, hobby projects, private use, research and testing — and
it explicitly covers **use by charities, schools and universities, public research bodies, public
safety or health organizations, and government institutions**, whatever their funding. A hospital,
a clinic run by a health service, or a school may use this tool freely.

Selling the software, or using it as part of a commercial product or service, is **not** permitted
without a separate license. If you want to use it commercially, open an issue and ask — we would
rather say yes to a real use than have the tool go unused.

Two things worth being clear about:

- Versions released before this change were published under the MIT License and **stay** MIT. This
  license applies from this release onwards; it cannot and does not revoke anything already granted.
- This license is deliberately **not** an OSI-approved open source license, because it restricts a
  field of endeavour. It is source-available.

**No warranty.** This tool and the parts it produces come with no warranty of any kind. Check that
anything you print fits your equipment, is strong enough for its purpose, and is safe to use, and
test it before you rely on it.

## Attribution

Built with [Three.js](https://threejs.org/) (MIT) and
[three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) (MIT, for the set screw cut). Design and interaction inspired by the GPL-3.0
[Vasecreator](https://github.com/gewoonkees132/Vasecreator) project — this project is an independent
implementation and contains no Vasecreator source.
