/**
 * The strip geometry is what the electrician cuts by. A segment one
 * millimetre off puts every following BMK on the wrong breaker, so the
 * width rule and the running offsets are pinned here, not eyeballed.
 */
import { describe, expect, it } from "vitest";
import { makeDevice } from "../utils/schaltplanDevices";
import {
  MODULE_WIDTH_MM,
  STRIP_LEAD_MM,
  deviceWidthMm,
  formatMm,
  rowLabelCounts,
  singleLabels,
  stripLengthMm,
  stripSegments,
  stripTotalMm,
  widthSuggestionsMm,
} from "../utils/schaltplanStrip";

describe("deviceWidthMm", () => {
  it("defaults to 17.5 mm per module", () => {
    expect(MODULE_WIDTH_MM).toBe(17.5);
    expect(deviceWidthMm(makeDevice("mcb"))).toBe(17.5);
    expect(deviceWidthMm(makeDevice("rcd"))).toBe(70);
    expect(deviceWidthMm(makeDevice("hauptschalter"))).toBe(52.5);
  });

  it("uses an explicit width_mm when it is a usable number", () => {
    expect(deviceWidthMm(makeDevice("rcd", { width_mm: 72 }))).toBe(72);
    expect(deviceWidthMm(makeDevice("mcb", { width_mm: 18 }))).toBe(18);
  });

  it("falls back to the modular width for null, zero, negative or NaN", () => {
    expect(deviceWidthMm(makeDevice("rcd", { width_mm: null }))).toBe(70);
    expect(deviceWidthMm(makeDevice("rcd", { width_mm: 0 }))).toBe(70);
    expect(deviceWidthMm(makeDevice("rcd", { width_mm: -5 }))).toBe(70);
    expect(deviceWidthMm(makeDevice("rcd", { width_mm: Number.NaN }))).toBe(70);
  });

  it("never lets te below 1 collapse a segment", () => {
    expect(deviceWidthMm({ te: 0, width_mm: null })).toBe(17.5);
  });
});

describe("stripSegments", () => {
  const row = {
    devices: [
      makeDevice("rcd", { id: "f1", designation: " F1 " }),
      makeDevice("mcb", { id: "c1", designation: "F1.1" }),
      makeDevice("blank", { id: "b1", designation: "should not print" }),
      makeDevice("mcb", { id: "c2", designation: "   " }),
      makeDevice("mcb", { id: "c3", designation: "F1.3", width_mm: 18 }),
    ],
  };

  it("keeps blanks and unnamed devices as empty-text segments with their width", () => {
    const segments = stripSegments(row);
    expect(segments.map((segment) => segment.text)).toEqual(["F1", "F1.1", "", "", "F1.3"]);
    expect(segments.map((segment) => segment.widthMm)).toEqual([70, 17.5, 17.5, 17.5, 18]);
    expect(segments.map((segment) => segment.deviceId)).toEqual(["f1", "c1", "b1", "c2", "c3"]);
    expect(segments[2].kind).toBe("blank");
  });

  it("accumulates the start offsets in rail order", () => {
    expect(stripSegments(row).map((segment) => segment.start)).toEqual([0, 70, 87.5, 105, 122.5]);
  });

  it("sums the length and adds the lead on both ends", () => {
    expect(stripLengthMm(row)).toBe(140.5);
    expect(STRIP_LEAD_MM).toBe(3);
    expect(stripTotalMm(row)).toBe(146.5);
  });

  it("does not mutate the row", () => {
    const before = JSON.stringify(row);
    stripSegments(row);
    expect(JSON.stringify(row)).toBe(before);
  });

  it("makes a 12-module rail — FI (4 TE) + 8 LS — exactly 210 mm", () => {
    const full = {
      devices: [
        makeDevice("rcd", { designation: "F1" }),
        ...Array.from({ length: 8 }, (_, index) => makeDevice("mcb", { designation: `F1.${index + 1}` })),
      ],
    };
    expect(stripLengthMm(full)).toBe(210);
    expect(stripSegments(full)).toHaveLength(9);
  });

  it("is empty for an empty rail", () => {
    expect(stripSegments({ devices: [] })).toEqual([]);
    expect(stripLengthMm({ devices: [] })).toBe(0);
  });
});

describe("rowLabelCounts / singleLabels", () => {
  const row = {
    devices: [
      makeDevice("rcd", { id: "f1", designation: "F1" }),
      makeDevice("mcb", { id: "c1", designation: "F1.1" }),
      makeDevice("blank", { id: "b1" }),
      makeDevice("mcb", { id: "c2" }),
    ],
  };

  it("counts printed labels and the devices the printer will skip", () => {
    expect(rowLabelCounts(row)).toEqual({ labelled: 2, withoutBmk: 2 });
  });

  it("lists one single label per BMK, in rail order", () => {
    expect(singleLabels(row).map((label) => label.text)).toEqual(["F1", "F1.1"]);
  });
});

describe("widthSuggestionsMm / formatMm", () => {
  it("offers the DIN width and the 18 mm rounding for the device's TE", () => {
    expect(widthSuggestionsMm(1)).toEqual([17.5, 18]);
    expect(widthSuggestionsMm(2)).toEqual([35, 36]);
    expect(widthSuggestionsMm(3)).toEqual([52.5, 54]);
    expect(widthSuggestionsMm(4)).toEqual([70, 72]);
    expect(widthSuggestionsMm(0)).toEqual([17.5, 18]);
  });

  it("prints millimetres with a German decimal comma", () => {
    expect(formatMm(17.5)).toBe("17,5");
    expect(formatMm(70)).toBe("70");
    expect(formatMm(146.5)).toBe("146,5");
    expect(formatMm(52.4999)).toBe("52,5");
  });
});
