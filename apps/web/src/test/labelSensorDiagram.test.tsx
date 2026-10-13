/**
 * The sensor positioning diagram is a physical instruction: a person reads
 * the pointer position off it and slides a carriage to match. These pin that
 * the drawing follows the constants in `sensorGeometry.ts` (so a correction
 * from a new photo is one edit), that the pointer sits on the material's own
 * reading, that the "Ist" pointer appears only when a reading was typed, and
 * that nothing from WAGO's older housing (dot rows, ▽/⬇ marks) is drawn.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { LabelSensorDiagram } from "../components/labelPrinter/LabelSensorDiagram";
import { SENSOR_GEOMETRY, scaleToX } from "../components/labelPrinter/sensorGeometry";
import type { LabelMaterial } from "../types/labelPrinter";
import { M2009, M804, M805 } from "./fixtures/labelPrinterMaterials";

type Mutable = { -readonly [K in keyof typeof SENSOR_GEOMETRY]: unknown };
const GEOMETRY = SENSOR_GEOMETRY as unknown as Mutable;
const ORIGINAL = { scaleUnitMm: SENSOR_GEOMETRY.scaleUnitMm, measured: SENSOR_GEOMETRY.measured };

afterEach(() => {
  GEOMETRY.scaleUnitMm = ORIGINAL.scaleUnitMm;
  GEOMETRY.measured = ORIGINAL.measured;
});

function draw(
  material: LabelMaterial,
  props: { state?: "sensor" | "loaded"; zoom?: boolean; actualScale?: number | null } = {},
) {
  const { container } = render(
    <LabelSensorDiagram material={material} state={props.state ?? "sensor"} zoom={props.zoom} actualScale={props.actualScale} />,
  );
  return container.querySelector("svg") as SVGSVGElement;
}

const num = (el: Element | null, attr: string) => Number(el?.getAttribute(attr));

describe("the printed scale", () => {
  it("draws 49 ticks: 5 long with the numbers 1–5, 4 medium, 40 short", () => {
    const svg = draw(M804);
    const ticks = svg.querySelectorAll("line.lc-tick");
    expect(ticks).toHaveLength(49);
    const kinds = Array.from(ticks).map((tick) => tick.getAttribute("data-kind"));
    expect(kinds.filter((kind) => kind === "long")).toHaveLength(5);
    expect(kinds.filter((kind) => kind === "medium")).toHaveLength(4);
    expect(kinds.filter((kind) => kind === "short")).toHaveLength(40);
    const numbers = Array.from(svg.querySelectorAll("text.lc-scale-number"));
    expect(numbers.map((n) => n.textContent)).toEqual(["1", "2", "3", "4", "5"]);
    numbers.forEach((n, index) => expect(num(n, "x")).toBe(scaleToX(index + 1)));
  });

  it("follows the constants module: a different scale unit moves every number", () => {
    GEOMETRY.scaleUnitMm = 5;
    const svg = draw(M804);
    const four = Array.from(svg.querySelectorAll("text.lc-scale-number")).find((n) => n.textContent === "4");
    expect(num(four ?? null, "x")).toBe(5);
  });

  it("draws no dot rows and no ▽/⬇ marks of the older housing", () => {
    const svg = draw(M804, { state: "loaded" });
    expect(svg.querySelectorAll("[class*='dot']")).toHaveLength(0);
    expect(svg.textContent).not.toMatch(/[▽⬇]/);
  });

  it("adds a ≈ only while the geometry is not measured", () => {
    expect(draw(M804).querySelector(".lc-scale-approx")).toBeNull();
    expect(draw(M804).textContent).not.toContain("≈");
    GEOMETRY.measured = false;
    const svg = draw(M804);
    expect(svg.querySelectorAll(".lc-scale-approx")).toHaveLength(1);
    expect(svg.querySelector(".lc-scale-approx")?.textContent).toBe("≈");
  });

  it("spans the slot from about −41 to +41 mm", () => {
    const slot = draw(M804).querySelector("rect.lc-slot");
    expect(num(slot, "x")).toBeCloseTo(-41, 0);
    expect(num(slot, "x") + num(slot, "width")).toBeCloseTo(41, 0);
  });
});

describe("pointer and callouts", () => {
  it("puts the ▲▼ pointer and the highlighted tick on 3,4 for 210-804", () => {
    const svg = draw(M804);
    expect(num(svg.querySelector(".lc-pointer"), "data-x")).toBe(4);
    expect(num(svg.querySelector(".lc-target-tick"), "x1")).toBe(4);
    expect(svg.querySelector(".lc-callout-text")?.textContent).toBe("Ziel: 3,4");
  });

  it("puts the pointer on the centre line for 2009-110", () => {
    const svg = draw(M2009);
    expect(num(svg.querySelector(".lc-pointer"), "data-x")).toBe(0);
    expect(svg.querySelector(".lc-callout-text")?.textContent).toBe("Ziel: 3");
  });

  it("draws the Ist pointer and the shift arrow only for a typed reading", () => {
    expect(draw(M804).querySelector(".lc-actual")).toBeNull();
    const svg = draw(M804, { actualScale: 2.9 });
    const actual = svg.querySelector(".lc-actual");
    expect(num(actual, "data-x")).toBe(-1);
    expect(svg.textContent).toContain("Ist: 2,9");
    expect(svg.querySelector(".lc-shift-arrow")).not.toBeNull();
    expect(draw(M804, { actualScale: 3.4 }).querySelector(".lc-shift-arrow")).toBeNull();
  });

  it("describes target and current reading in <desc>", () => {
    const desc = draw(M804, { actualScale: 2.9 }).querySelector("desc")?.textContent ?? "";
    expect(desc).toContain("3,4 der Skala, etwa 4 mm rechts der Mitte");
    expect(desc).toContain("Zeiger steht jetzt auf 2,9");
    const svg = draw(M804);
    const ids = (svg.getAttribute("aria-labelledby") ?? "").split(" ");
    expect(ids).toHaveLength(2);
    expect(svg.getAttribute("role")).toBe("img");
  });

  it("centres the zoom on the target", () => {
    expect(draw(M804, { zoom: true }).getAttribute("viewBox")).toBe("-4 14 16 28");
    expect(draw(M2009, { zoom: true }).getAttribute("viewBox")).toBe("-8 14 16 28");
  });
});

describe("media", () => {
  it("draws no media in the sensor state", () => {
    expect(draw(M804).querySelector(".lc-media")).toBeNull();
  });

  it("draws labels as wide as the label across", () => {
    const labels = draw(M804, { state: "loaded" }).querySelectorAll("rect.lc-label");
    expect(labels.length).toBeGreaterThan(0);
    labels.forEach((label) => expect(num(label, "width")).toBe(44));
  });

  it("draws 210-805 as two lanes with the slit on the centre line", () => {
    const svg = draw(M805, { state: "loaded" });
    const lanes = svg.querySelectorAll("g.lc-lane");
    expect(lanes).toHaveLength(2);
    const lefts = Array.from(lanes).map((lane) => num(lane.querySelector("rect.lc-label"), "x"));
    expect(lefts).toEqual([-15.5, 0.5]);
    lanes.forEach((lane) => expect(num(lane.querySelector("rect.lc-label"), "width")).toBe(15));
  });

  it("draws continuous stock as one band of the material width", () => {
    const band = draw(M2009, { state: "loaded" }).querySelector("rect.lc-band");
    expect(num(band, "width")).toBe(11);
    expect(num(band, "x")).toBe(-5.5);
  });

  it("draws the green roller with its groove", () => {
    const svg = draw({ ...M804, roller: "258-5007" });
    expect(svg.querySelector(".lc-roller-5007")).not.toBeNull();
    expect(svg.querySelector(".lc-roller-groove")).not.toBeNull();
    expect(draw(M804).querySelector(".lc-roller-groove")).toBeNull();
  });
});
