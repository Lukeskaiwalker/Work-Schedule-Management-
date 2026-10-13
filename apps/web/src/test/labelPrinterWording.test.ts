/**
 * Nothing about the label printer is claimed as checked
 * (docs/LABEL_PRINTER_CALIBRATION.md §0.1, owner decision 3).
 *
 * Everything in this build was tested against a simulated printer; the real
 * one gets its physical tests later. The calibration screens therefore never
 * call a printer behaviour "verifiziert"/"verified" — not in UI text and not in
 * a comment someone later copies into UI text — and never call the sensor
 * "IR", because no source states its wavelength. A grep is the test.
 */
import { describe, expect, it } from "vitest";

const SOURCES = {
  ...import.meta.glob("../components/labelPrinter/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../utils/labelCalibration*.ts", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

describe("label printer wording", () => {
  it("reads the calibration sources, so the checks cannot pass vacuously", () => {
    const paths = Object.keys(SOURCES);
    expect(paths.some((path) => path.endsWith("utils/labelCalibration.ts"))).toBe(true);
    expect(paths.some((path) => path.endsWith("LabelSensorDiagram.tsx"))).toBe(true);
    expect(paths.some((path) => path.includes("labelPrinter/wizard/"))).toBe(true);
    expect(paths.length).toBeGreaterThan(20);
  });

  it("never says verified, in German or English", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => /verifiz|verified/i.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("never calls the sensor IR", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => /\bIR\b/.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
