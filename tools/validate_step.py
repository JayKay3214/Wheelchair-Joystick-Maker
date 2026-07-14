#!/usr/bin/env python3
"""
Dev-only STEP validator / regression oracle for the Joystick Maker's analytic export.

Imports a .step file with the OpenCASCADE kernel and reports whether it is a valid closed
SOLID, its face count, and its volume. Used while building the in-browser analytic exporter
(js/exporter.js buildSTEPAnalytic) to confirm each export is a real solid, not a broken shell.

Requires OpenCASCADE via cadquery (NOT a runtime dependency of the web app):
    pip install --user cadquery      # pulls cadquery-ocp (OCP / OpenCASCADE)

Usage:
    python3 tools/validate_step.py file1.step [file2.step ...]

To validate the browser's actual output, capture it from a headless page by overriding
URL.createObjectURL to grab the Blob, then `await blob.text()` — see docs/step-export-plan.md.
"""
import sys, os
from OCP.STEPControl import STEPControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopAbs import TopAbs_SOLID, TopAbs_SHELL, TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp


def count(shape, kind):
    exp = TopExp_Explorer(shape, kind); n = 0
    while exp.More():
        n += 1; exp.Next()
    return n


def validate(path):
    rd = STEPControl_Reader()
    if rd.ReadFile(path) != IFSelect_RetDone:
        return "%-28s READ FAILED" % os.path.basename(path)
    rd.TransferRoots()
    sh = rd.OneShape()
    if sh is None or sh.IsNull():
        return "%-28s NULL shape (0 roots transferred)" % os.path.basename(path)
    g = GProp_GProps(); BRepGProp.VolumeProperties_s(sh, g)
    return "%-28s solids=%d shells=%d faces=%d valid=%s vol=%.1f  %dKB" % (
        os.path.basename(path), count(sh, TopAbs_SOLID), count(sh, TopAbs_SHELL),
        count(sh, TopAbs_FACE), BRepCheck_Analyzer(sh).IsValid(), g.Mass(), os.path.getsize(path) // 1024)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    for p in sys.argv[1:]:
        print(validate(p))
