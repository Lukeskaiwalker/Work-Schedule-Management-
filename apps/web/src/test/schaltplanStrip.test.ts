/**
 * The strip geometry is what the electrician cuts by. A segment one
 * millimetre off puts every following BMK on the wrong breaker, so the
 * width rule, the running offsets and the board-wide font size are pinned
 * here, not eyeballed. The numbers are the same ones the backend twin
 * (`apps/api/app/services/schaltplan_layout.py`) is tested against.
 */
import { describe, expect, it } from "vitest";
import { makeDevice } from "../utils/schaltplanDevices";
import {
  DOTS_PER_MM,
  GLYPH_ADVANCE_EM,
  MAX_FONT_DOTS_FLOOR,
  MIN_FONT_DOTS,
  MODULE_WIDTH_MM,
  SEG_PAD_DOTS,
  STRIP_HEIGHT_MM,
  STRIP_LEAD_MM,
  boardFontSize,
  deviceWidthMm,
  formatFontMm,
  formatMm,
  isLabelled,
  maxFontDots,
  rowLabelCounts,
  segmentText,
  singleLabels,
  stripLengthMm,
  stripSegments,
  stripTotalMm,
  textWidthEm,
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

describe("isLabelled", () => {
  it("is true only for a non-blank device with a non-empty BMK", () => {
    expect(isLabelled(makeDevice("mcb", { designation: "F1.1" }))).toBe(true);
    expect(isLabelled(makeDevice("mcb", { designation: " F1.1 " }))).toBe(true);
    expect(isLabelled(makeDevice("mcb", { designation: "   " }))).toBe(false);
    expect(isLabelled(makeDevice("mcb"))).toBe(false);
    expect(isLabelled(makeDevice("blank", { designation: "should not print" }))).toBe(false);
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

  it("emits a segment only for labelled devices — blanks and unnamed devices take no width", () => {
    const segments = stripSegments(row);
    expect(segments.map((segment) => segment.text)).toEqual(["F1", "F1.1", "F1.3"]);
    expect(segments.map((segment) => segment.widthMm)).toEqual([70, 17.5, 18]);
    expect(segments.map((segment) => segment.deviceId)).toEqual(["f1", "c1", "c3"]);
    expect(segments.every((segment) => segment.kind !== "blank")).toBe(true);
  });

  it("accumulates the start offsets over the emitted segments only", () => {
    expect(stripSegments(row).map((segment) => segment.start)).toEqual([0, 70, 87.5]);
  });

  it("sums the emitted widths and adds the lead on both ends", () => {
    expect(stripLengthMm(row)).toBe(105.5);
    expect(STRIP_LEAD_MM).toBe(3);
    expect(stripTotalMm(row)).toBe(111.5);
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

  it("is empty for a rail of only blanks and unnamed devices", () => {
    const unlabelled = { devices: [makeDevice("blank"), makeDevice("mcb"), makeDevice("mcb", { designation: " " })] };
    expect(stripSegments(unlabelled)).toEqual([]);
    expect(stripLengthMm(unlabelled)).toBe(0);
    expect(stripTotalMm(unlabelled)).toBe(2 * STRIP_LEAD_MM);
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

  it("counts printed labels, and unnamed devices from the row — a blank never counts", () => {
    expect(rowLabelCounts(row)).toEqual({ labelled: 2, withoutBmk: 1 });
    expect(rowLabelCounts({ devices: [makeDevice("blank"), makeDevice("blank")] })).toEqual({
      labelled: 0,
      withoutBmk: 0,
    });
    expect(rowLabelCounts({ devices: [makeDevice("mcb"), makeDevice("mcb", { designation: "  " })] })).toEqual({
      labelled: 0,
      withoutBmk: 2,
    });
  });

  it("lists one single label per BMK, in rail order", () => {
    expect(singleLabels(row).map((label) => label.text)).toEqual(["F1", "F1.1"]);
  });
});

describe("textWidthEm", () => {
  it("embeds the Arial advance table", () => {
    expect(Object.keys(GLYPH_ADVANCE_EM)).toHaveLength(104);
    expect(GLYPH_ADVANCE_EM.F).toBe(0.611);
    expect(GLYPH_ADVANCE_EM["1"]).toBe(0.556);
    expect(GLYPH_ADVANCE_EM["."]).toBe(0.278);
    expect(GLYPH_ADVANCE_EM["µ"]).toBe(0.576);
  });

  it("sums the per-glyph advances: F1.1 is 2.001 em", () => {
    expect(textWidthEm("F1.1")).toBeCloseTo(2.001, 3);
    expect(textWidthEm("")).toBe(0);
  });

  it("falls back to 0.58 em for a glyph outside the table", () => {
    expect(textWidthEm("€")).toBeCloseTo(0.58, 6);
    expect(textWidthEm("F€")).toBeCloseTo(0.611 + 0.58, 6);
  });
});

describe("boardFontSize", () => {
  const rows = (...devices: ReturnType<typeof makeDevice>[]) => ({ rows: [{ devices }] });

  it("pins the printer constants the size is derived from", () => {
    expect(DOTS_PER_MM).toBe(12);
    expect(SEG_PAD_DOTS).toBe(12);
    expect(MIN_FONT_DOTS).toBe(24);
    expect(MAX_FONT_DOTS_FLOOR).toBe(16);
    expect(STRIP_HEIGHT_MM).toBe(11);
  });

  it("caps the size at max(16, min(h − 12, 0.72 h)) for the strip width", () => {
    // 11 mm × 12 = 132 dots: min(120, int(95.04)) = 95.
    expect(maxFontDots(11)).toBe(95);
    // 6 mm × 12 = 72 dots: min(60, int(51.84)) = 51.
    expect(maxFontDots(6)).toBe(51);
    // Absurdly narrow stock still leaves a legible floor.
    expect(maxFontDots(1)).toBe(16);
  });

  it("uses the maximum when nothing on the board is labelled", () => {
    expect(boardFontSize({ rows: [] }, 11)).toEqual({ sizeDots: 95, overflowing: [] });
    expect(boardFontSize(rows(makeDevice("blank"), makeDevice("mcb")), 11)).toEqual({
      sizeDots: 95,
      overflowing: [],
    });
  });

  it("fits F1.1 into a 17.5 mm module at floor((210 − 24) / 2.001) = 92 dots", () => {
    expect(boardFontSize(rows(makeDevice("mcb", { designation: "F1.1" })), 11)).toEqual({
      sizeDots: 92,
      overflowing: [],
    });
  });

  it("clamps a roomy board to the maximum", () => {
    expect(boardFontSize(rows(makeDevice("rcd", { designation: "F1" })), 11).sizeDots).toBe(95);
  });

  it("is one size for the whole document: the tightest segment of any row wins", () => {
    const document = {
      rows: [
        { devices: [makeDevice("rcd", { designation: "F1" })] },
        { devices: [makeDevice("mcb", { designation: "F1.1" }), makeDevice("blank", { designation: "F1.10.11.12" })] },
      ],
    };
    expect(boardFontSize(document, 11).sizeDots).toBe(92);
  });

  it("clamps to 24 dots and reports the BMKs that will run past their segment", () => {
    const tooLong = "F1.10 Wallbox Garage";
    const result = boardFontSize(
      rows(makeDevice("mcb", { designation: tooLong }), makeDevice("mcb", { designation: "F1.2" })),
      11,
    );
    expect(result.sizeDots).toBe(24);
    expect(result.overflowing).toEqual([tooLong]);
  });

  it("does not mutate the document", () => {
    const document = rows(makeDevice("mcb", { designation: "F1.1" }));
    const before = JSON.stringify(document);
    boardFontSize(document, 11);
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe("widthSuggestionsMm / formatMm / formatFontMm", () => {
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

  it("prints the font size in millimetres with one decimal", () => {
    expect(formatFontMm(95)).toBe("7,9");
    expect(formatFontMm(92)).toBe("7,7");
    expect(formatFontMm(24)).toBe("2,0");
  });
});

describe("parity with the API's edge rules", () => {
  it("treats a BOM-only or control-only designation as no BMK, like the API", () => {
    expect(segmentText(makeDevice("mcb", { designation: "\ufeff" }))).toBe("");
    expect(segmentText(makeDevice("mcb", { designation: "\u001f" }))).toBe("");
    expect(segmentText(makeDevice("mcb", { designation: "  F1.2 \t" }))).toBe("F1.2");
  });

  it("counts whole modules only, like the API's int(te)", () => {
    expect(deviceWidthMm({ te: 2.5, width_mm: null })).toBe(35);
    expect(deviceWidthMm({ te: 0.4, width_mm: null })).toBe(17.5);
  });

  it("sizes against a whole-millimetre strip height, like the API", () => {
    expect(maxFontDots(11)).toBe(95);
    expect(maxFontDots(10.5)).toBe(maxFontDots(11));
  });
});
