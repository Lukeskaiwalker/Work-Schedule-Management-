/**
 * What a typed crate quantity means before anything is sent.
 *
 * The API takes a whole number up to MAX_BOX_QUANTITY (10 000,
 * schemas/werkstatt_boxes.py). Anything else the field can hold is either
 * nothing (empty: put the number back), not a count ("1,5", "-3"), or longer
 * than any real count — which, in a field a barcode scanner can type into, is
 * the signature of a scan.
 */
import { describe, expect, it } from "vitest";

import { BOX_MAX_QUANTITY, parseBoxQuantity, textBeforeScan } from "../components/werkstatt/KistenQtyControl";

describe("parseBoxQuantity", () => {
  it("reads whole numbers, spaces and leading zeros aside", () => {
    expect(parseBoxQuantity("12")).toEqual({ kind: "quantity", value: 12 });
    expect(parseBoxQuantity(" 7 ")).toEqual({ kind: "quantity", value: 7 });
    expect(parseBoxQuantity("007")).toEqual({ kind: "quantity", value: 7 });
    expect(parseBoxQuantity("0")).toEqual({ kind: "quantity", value: 0 });
  });

  it("takes the API's limit and nothing past it", () => {
    expect(BOX_MAX_QUANTITY).toBe(10_000);
    expect(parseBoxQuantity("10000")).toEqual({ kind: "quantity", value: 10_000 });
    expect(parseBoxQuantity("10001")).toEqual({ kind: "too_large" });
    expect(parseBoxQuantity("4099999000013")).toEqual({ kind: "too_large" });
  });

  it("treats more digits than the limit has as a scan, even zero-padded", () => {
    // A small number cut out of a zero-padded code must not pass as a count.
    expect(parseBoxQuantity("000012")).toEqual({ kind: "too_large" });
  });

  it("calls an empty field empty, not zero", () => {
    expect(parseBoxQuantity("")).toEqual({ kind: "empty" });
    expect(parseBoxQuantity("   ")).toEqual({ kind: "empty" });
  });

  it("refuses what is not a whole number", () => {
    for (const raw of ["1,5", "1.5", "-3", "+2", "12a", "1e3", "zwölf"]) {
      expect(parseBoxQuantity(raw)).toEqual({ kind: "invalid" });
    }
  });
});

describe("textBeforeScan", () => {
  // What the person typed before a scanner fired into the field: kept, while
  // the scan's own digits go.
  it("takes the scan's characters off the end of the field's text", () => {
    expect(textBeforeScan("404099999000013", "4099999000013")).toBe("40");
    expect(textBeforeScan("4099999000013", "4099999000013")).toBe("");
  });

  it("guesses nothing when the text does not end with the scan", () => {
    // The cursor sat before the 40: the scan is inside the text, not after it.
    expect(textBeforeScan("409999900001340", "4099999000013")).toBeNull();
    expect(textBeforeScan(null, "4099999000013")).toBeNull();
    expect(textBeforeScan("40", "")).toBeNull();
  });
});
