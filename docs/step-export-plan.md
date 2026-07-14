# Plan: Better STEP Export (analytic B-rep instead of faceted mesh)

Status: **Group A DONE** (2026-07-14, commit `ed4122b`) — the five solids-of-revolution now export
true analytic B-rep in-browser, one-click, validated against OpenCASCADE. Group B (freeform NURBS)
still open. Written 2026-07-05.

## DONE — what shipped (Group A)

`js/exporter.js` `buildSTEPAnalytic()` emits PLANE / CYLINDRICAL_SURFACE / CONICAL_SURFACE (incl.
cone-to-apex for the domed smooth tops) + full-circle EDGE_CURVEs, from the shared
`revolutionSection()` (factored out of `buildKnobGeometry`). `exportSTEP(model,params,profile,name)`
picks analytic for revolution models, faceted fallback for Goal Posts / T-Bar / tilted I-Handle.
Files are 13–53 KB (was ~7 MB), valid solids, exact volume (dV 0.00%) for every model at default
and non-default params.

### Key findings (things that turned out to matter)
- **No pcurves / seam_curves needed.** A geometry-only B-rep (surfaces + 3D CIRCLE/line edges +
  loops) imports as a valid solid in OpenCASCADE — the importer reconstructs pcurves. This is what
  makes the hand-written JS tractable. (OCC's *own* export writes pcurves, but doesn't require them.)
- **The PRODUCT / SHAPE_DEFINITION_REPRESENTATION chain is mandatory** — without it OCC transfers 0
  roots (NULL shape). Easy to forget on a minimal file.
- **STEP reals must have a decimal point and no lowercase sci-notation.** `repr()`/default JS number
  formatting can emit `8e-06`, which is invalid STEP and silently drops that entity → open shell.
  `stepReal()` formats with `toFixed` + trailing-zero strip + forced `.`.
- **No apex poles except the smooth tops.** Sharp models are flat-topped (disk caps), so axis points
  are just disk centres (interior). Ball/Mushroom round the top into a dome, so the top segment goes
  *from* the axis — a real cone-to-apex, handled as a single-circle-bounded cone (apex = surface
  singularity, no degenerate edge required).
- **Orientation:** OCC's ShapeFix during transfer orients the closed shell; the flat-face outward
  side is picked from the profile winding. Verified by checking the resulting solid volume is
  positive and matches the analytic revolution volume.
- **Validation oracle:** `pip install --user cadquery` gives an OCC kernel. Round-trip: capture the
  JS export (override `URL.createObjectURL` in a headless page to grab the blob text) → import in
  cadquery/OCP → assert valid Solid + volume. See `tools/validate_step.py`.

### Still open / follow-ups
- **Freeform faceted STEP is huge** (Goal Post Experimental ~37 MB, T-Bar ~7.6 MB) because the
  goalpost base mesh ignores the coarse `STEP_SEGMENTS` and exports full-res triangles. Pre-existing
  (not a regression), but worth a coarse-mesh-for-STEP pass or a warning. OCC even times out loading
  the 37 MB file.
- Group B (analytic/NURBS for the freeform models) — see below; not started.
- Optional: real TOROIDAL arcs for rounded corners (currently the smooth profile is piecewise cones,
  ~78 faces for a ball — still tiny and truly round, but arcs would mean a handful of faces).

---
Original plan (pre-implementation) follows.

## Why

`js/exporter.js` `buildSTEP()` currently takes the *final triangle mesh* and emits one flat
`PLANE` per triangle (a faceted `MANIFOLD_SOLID_BREP`, AP214). It is watertight and imports fine,
but:

- **Huge files** (~7 MB at high segment counts) — one face + loop + 3 edges per triangle.
- **Not editable** in CAD — you get thousands of tiny facets, no real faces/edges to grab.
- **Round things aren't round** — circles are faceted polygons, so fillets/booleans in CAD are ugly.

Goal: emit **analytic surfaces** (cylinder/cone/plane/torus/sphere, and where needed B-spline)
so the parts are small, smooth, and genuinely editable in FreeCAD / Fusion / SolidWorks.

Reference the user pointed to: **cq-kit** (CadQuery utility lib over OpenCASCADE) —
https://github.com/michaelgale/cq-kit. See the `ref-cq-kit` memory.

## The models split into two very different groups

### Group A — solids of revolution (the easy, high-value win)
Ball, Mushroom, Chin Cup, Carrot, I-Handle.

`buildKnobGeometry()` (js/geometry.js ~line 431) builds these by revolving a 2D **(radius, y)**
profile a full 2π with `THREE.LatheGeometry`. The `section` array is:
- the outer profile points (already run through `roundCorners` / `smoothOuter` / `dedupe`), then
- the bore: `(boreR, 0)`, `(boreR, boreCeil)`, `(0, boreCeil)` (or just `(0,0)` if no bore).
- **First point `(0, topY)` and last point `(0, boreCeil)` sit on the axis (r=0)** — these are the
  poles that make the revolution a closed watertight solid.

Because the shape is truly a revolution, we can emit **real** analytic B-rep:
- Each straight profile segment `(r0,y0)->(r1,y1)` revolved becomes:
  - `r0==r1` (vertical): **CYLINDRICAL_SURFACE**
  - `y0==y1` (horizontal): **PLANE** (a flat annulus/disk)
  - otherwise: **CONICAL_SURFACE**
- Rounded corners (currently sampled into short segments) could become real **TOROIDAL_SURFACE**
  arcs, or stay piecewise-conical (simpler; still perfectly round around the axis).
- The whole revolution direction is a true circle, so **even piecewise-conical output has zero
  facets around the part** — that alone is a massive quality jump over the mesh.
- Topology: for each profile segment, one revolved face bounded by two circle edges (top & bottom)
  plus (if you split the 2π) seam edges. Simplest is a full-360 periodic face per segment with the
  two `CIRCLE` edges as boundaries; the axis-pole segments become a cone/… whose small circle
  collapses to a `VERTEX_POINT` on the axis (a degenerate/"vertex loop" boundary).

### Group B — freeform (the hard part)
T-Bar, Goal Post, **Goal Post Experimental**.

These are warped grids / swept prisms (`buildTBar`, `buildGoalPost`, `buildGoalPostOval`). No simple
analytic surface fits. Options:
1. **Leave them faceted** (current behavior) — pragmatic; STL/OBJ already cover printing.
2. **B-spline / NURBS surfaces** (`B_SPLINE_SURFACE_WITH_KNOTS`) fitted to each smooth patch (the
   oval saddle, the tab shelves, the fillet sweep, the walls). This is real work: you must fit
   control nets, keep patches watertight at their shared edges, and handle the analytic bits (the
   flat walls/tab bottoms are planes; the elliptical fillet sweep is a genuine surface). Big effort.

**Recommendation:** do Group A first (browser JS, analytic revolution). Decide on Group B later —
likely only worth NURBS if the user really needs to CAD-edit the goalposts; otherwise keep faceted.

## Approach / where it lives

Keep it **buildless, in-browser** (no OpenCASCADE client-side — that constraint still holds). We
already hand-write STEP text in `buildSTEP`; extend that:

- Add a `buildSTEPRevolution(model, params, profile)` that runs when the model is a revolution
  (i.e. NOT `geometryKind` goalpost/goalpostoval/tbar) and emits analytic surfaces from the SAME
  `section` array `buildKnobGeometry` uses. Reuse the profile-construction code (factor the
  `section` assembly out of `buildKnobGeometry` so exporter and geometry share it — today the
  exporter only sees the finished mesh, which is the root of the problem).
- Fall back to the existing faceted `buildSTEP` for Group B (and, initially, the I-Handle — see
  gotchas).
- Keep the `+90° about X` (Y-up → Z-up) orientation so it still lands bore-down in slicers/CAD.

An **offline Python + CadQuery + cq-kit** generator is the alternative if in-browser B-rep proves
too fiddly (esp. for Group B NURBS). It would take the same slider params, build the profile, and
`revolve`. Downside: no longer one-click from the web app; needs a script/server.

## Gotchas / things to be aware of

- **I-Handle is NOT a pure revolution.** `buildKnobGeometry` (~line 460) *shears* the head above the
  stem by `tan(tilt)` to make it lean, while leaving the bore/stem vertical. A sheared revolution is
  an oblique surface, not a `SURFACE_OF_REVOLUTION`. Either (a) export I-Handle faceted for now, or
  (b) special-case it (oblique cones / general swept surfaces), or (c) if tilt==0 treat as normal
  revolution. Don't assume all five round models are clean revolutions.
- **Axis poles (r=0).** Top point and bore-ceiling point are on the axis. The adjacent revolved
  face degenerates to a point there — needs a vertex loop / degenerate boundary, not two circles.
  This is exactly the hard case v1 avoided by going faceted. Get this right or CAD import fails.
- **Profile is piecewise-linear after processing.** `roundCorners`, `smoothProfile`/`smoothOuter`
  (CatmullRom, `curve` at geometry.js ~115) and `dedupe` all run first. So by export time the
  outer profile is already a polyline. For true arcs you'd re-detect/parametrize the rounds; for a
  first pass, piecewise cone/cylinder/plane is fine.
- **Bore is a blind hole** (flat bottom disk at `boreCeil`, cylindrical wall, bottom annulus at
  y=0 between `boreR` and `stemR`). Model it as: bottom annulus (PLANE) + bore wall (CYLINDER) +
  bore ceiling (PLANE, small disk). Watch the winding — bore faces point *inward*.
- **Winding / face orientation.** `ensureOutwardWinding` fixes the mesh; for hand-written B-rep you
  must set each `ADVANCED_FACE` / surface normal outward yourself (bore inward). The current faceted
  path computes per-triangle normals; the analytic path needs per-surface axis placement care.
- **Closed shell requirement.** Must be one `CLOSED_SHELL` with every edge shared by exactly 2
  faces, or CAD treats it as a surface model (not a solid). Keep the mesh-era open-edge check as a
  guard (count edges, expect all == 2).
- **Units & schema.** Currently mm, AP214 (`AUTOMOTIVE_DESIGN`). Fine to keep; AP242 is an option.
  Keep `UNCERTAINTY_MEASURE 1e-6`.
- **Number formatting.** `r(n)` rounds; STEP wants `.` floats (e.g. `1.` not `1`). Reuse it.
- **Validation.** Test-import each exported STEP in **FreeCAD** (free) and confirm: solid (not just
  shell), round surfaces are analytic (select a face → it says Cylinder/Cone, not a mesh), bore is a
  real hole, sits bore-down, sized in mm. Also re-open in a slicer to confirm still printable.
- **Don't regress the mesh path.** Group B + fallback still use faceted `buildSTEP`. Keep it.
- **Segment param.** Revolution B-rep no longer needs `RADIAL_SEGMENTS` (the circle is exact) — only
  the profile sampling matters. Files get ~100× smaller.

## Suggested phasing

1. Factor the `section`/profile assembly out of `buildKnobGeometry` so the exporter can rebuild the
   analytic profile (not just the mesh).
2. `buildSTEPRevolution`: emit cylinder/cone/plane faces + circle edges + axis-pole vertex loops +
   analytic bore. Handle tilt==0 I-Handle; leave tilted I-Handle + Group B on the faceted path.
3. Validate in FreeCAD; iterate on poles/winding until it's a clean solid with analytic faces.
4. (Optional, later) real toroidal arcs for rounded corners.
5. (Optional, much later) Group B via B-spline surfaces, or an offline CadQuery/cq-kit generator.

## Related
- Memory: `followup-step-brep`, `ref-cq-kit`, `project-progress`.
- Code: `js/exporter.js` (buildSTEP/exportSTEP), `js/geometry.js` (buildKnobGeometry ~431,
  buildStem ~367, profile smoothing ~115).
