/**
 * The side view exists to answer one question the top view cannot: which way
 * the roll on the external unwinder turns. Its arc arrow and its media path
 * must tell the same story — WAGO's "Abrollrichtung links, gegen den
 * Uhrzeigersinn" (docs/LABEL_PRINTER_CALIBRATION.md §2, §7.8) — or a person
 * threads the strip the wrong way round and wastes an auto-sense run.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { LabelPathSideView } from "../components/labelPrinter/LabelPathSideView";
import { SENSOR_GEOMETRY } from "../components/labelPrinter/sensorGeometry";
import type { LabelMaterial } from "../types/labelPrinter";
import { M2009, M211 } from "./fixtures/labelPrinterMaterials";

function draw(material: LabelMaterial) {
  const { container } = render(<LabelPathSideView material={material} />);
  return container.querySelector("svg") as SVGSVGElement;
}

/** The first two absolute points of an "M x y L x y …" path. */
function firstSegment(d: string): [[number, number], [number, number]] {
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  return [
    [n[0], n[1]],
    [n[2], n[3]],
  ];
}

describe("external unwinder", () => {
  const roll = SENSOR_GEOMETRY.sideView.rollExternal;

  it.each([
    ["2009-110", M2009],
    ["211-501", M211],
  ] as const)("pays the media out the way the arc arrow turns the roll (%s)", (_, material) => {
    const svg = draw(material);
    const arc = svg.querySelector(".lc-side-arrow")?.getAttribute("d") ?? "";
    // "A rx ry rotation large-arc sweep x y": SVG's y points down, so sweep 0
    // runs counter-clockwise on screen; the arrowhead sits at the arc's end.
    const sweep = arc.match(/A\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+[\s,]+[01][\s,]+([01])/)?.[1];
    expect(sweep).toBe("0");

    const [[px, py], [nx, ny]] = firstSegment(svg.querySelector(".lc-side-path")?.getAttribute("d") ?? "");
    const rx = px - roll.cx;
    const ry = py - roll.cy;
    // It leaves from the roll's rim …
    expect(Math.hypot(rx, ry)).toBeCloseTo(roll.r, 2);
    // … in the direction the rim moves there: turning counter-clockwise on
    // screen, the rim at (rx, ry) from the centre moves along (ry, −rx) …
    expect((nx - px) * ry + (ny - py) * -rx).toBeGreaterThan(0);
    // … as a tangent, not cutting back through the roll, from its lower half.
    expect((nx - px) * rx + (ny - py) * ry).toBeCloseTo(0, 6);
    expect(py).toBeGreaterThan(roll.cy);
  });

  it("names the direction in the drawing and in its description", () => {
    const svg = draw(M2009);
    expect(svg.textContent).toContain("Abrollrichtung links");
    expect(svg.querySelector("desc")?.textContent).toContain("gegen den Uhrzeigersinn");
  });
});
