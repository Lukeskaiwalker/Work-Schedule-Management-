/**
 * The status ladder and the quantity that reaches a wholesaler's basket.
 *
 * Two things are worth pinning here. First, "Bestellt" is a rung of its own
 * since v2.15 — it used to be an alias of "Bestellen", which is why the office
 * could not tell "we should buy this" from "a buyer already did" and ordered
 * the same material twice.
 *
 * Second, `previewOrderQuantity` is the browser twin of
 * `order_quantity_for_need` in apps/api/app/services/material_need_rows.py.
 * The two must agree: the modal shows one number and the server writes
 * another onto the order line otherwise, and nobody would notice until the
 * delivery arrived. The cases below are deliberately the same ones the pytest
 * suite uses.
 */
import { describe, expect, it } from "vitest";
import {
  MATERIAL_NEED_STATUSES,
  materialNeedStatusClass,
  materialNeedStatusLabel,
  needSkipReasonLabel,
  needSkipSummary,
  nextMaterialNeedStatus,
  normalizeMaterialNeedStatus,
  previewOrderQuantity,
} from "../utils/materials";

describe("material need status", () => {
  it("reads 'ordered' and 'bestellt' as the new rung, not as 'order'", () => {
    expect(normalizeMaterialNeedStatus("ordered")).toBe("ordered");
    expect(normalizeMaterialNeedStatus("bestellt")).toBe("ordered");
    expect(normalizeMaterialNeedStatus("Bestellt")).toBe("ordered");
    expect(normalizeMaterialNeedStatus("bestellen")).toBe("order");
  });

  it("falls back to 'order' for anything unknown or empty", () => {
    expect(normalizeMaterialNeedStatus(null)).toBe("order");
    expect(normalizeMaterialNeedStatus("")).toBe("order");
    expect(normalizeMaterialNeedStatus("was auch immer")).toBe("order");
  });

  it("keeps the German and English labels apart for every rung", () => {
    const labels = MATERIAL_NEED_STATUSES.map((status) =>
      materialNeedStatusLabel(status, "de"),
    );
    expect(labels).toEqual(["Bestellen", "Bestellt", "Unterwegs", "Verfügbar", "Erledigt"]);
    expect(materialNeedStatusLabel("ordered", "en")).toBe("Ordered");
  });

  it("gives 'ordered' its own css variant", () => {
    expect(materialNeedStatusClass("ordered")).toBe("ordered");
    expect(materialNeedStatusClass("on_the_way")).toBe("on-the-way");
  });

  it("walks the ladder in order and wraps at the end", () => {
    expect(nextMaterialNeedStatus("order")).toBe("ordered");
    expect(nextMaterialNeedStatus("ordered")).toBe("on_the_way");
    expect(nextMaterialNeedStatus("on_the_way")).toBe("available");
    expect(nextMaterialNeedStatus("available")).toBe("order");
  });
});

describe("previewOrderQuantity", () => {
  it("passes a whole number through without a warning", () => {
    expect(previewOrderQuantity("30", "de")).toEqual({ quantity: 30, warning: null });
  });

  it("rounds a German decimal UP and says so", () => {
    const preview = previewOrderQuantity("2,5", "de");
    expect(preview.quantity).toBe(3);
    expect(preview.warning).toContain("2,5");
    expect(preview.warning).toContain("aufgerundet");
  });

  it("reads both thousands conventions", () => {
    expect(previewOrderQuantity("1.234,5", "de").quantity).toBe(1235);
    expect(previewOrderQuantity("1,234.5", "de").quantity).toBe(1235);
  });

  it("assumes 1 for prose, and warns", () => {
    const preview = previewOrderQuantity("ca. 3 Ringe", "de");
    expect(preview.quantity).toBe(1);
    expect(preview.warning).toBeTruthy();
  });

  it("assumes 1 for an empty quantity, and warns", () => {
    const preview = previewOrderQuantity("", "de");
    expect(preview.quantity).toBe(1);
    expect(preview.warning).toContain("Keine Menge");
  });

  it("refuses to order zero or less", () => {
    expect(previewOrderQuantity("0", "de").quantity).toBe(1);
    expect(previewOrderQuantity("-4", "de").quantity).toBe(1);
    expect(previewOrderQuantity("-4", "de").warning).toBeTruthy();
  });

  it("rejects the spellings Decimal() would have accepted", () => {
    // '1e3' is the dangerous one: the server used to read it as a thousand
    // units while this preview said 1, and only the server's number was
    // ordered. 'NaN' and 'Infinity' crashed the endpoint outright.
    for (const raw of ["1e3", "NaN", "Infinity", "-NaN", "2.", ".5"]) {
      const preview = previewOrderQuantity(raw, "de");
      expect(preview.quantity, raw).toBe(1);
      expect(preview.warning, raw).toContain("nicht lesbar");
    }
  });
});

describe("needSkipSummary", () => {
  it("names every reason with its own count, worst first", () => {
    expect(
      needSkipSummary(
        ["already_ordered", "already_ordered", "already_ordered", "no_catalog_item"],
        "de",
      ),
    ).toBe("3 bereits in einer Bestellung, 1 ohne Katalog-Artikel");
  });

  it("does not blame the catalogue for a row that is simply already ordered", () => {
    const summary = needSkipSummary(["already_ordered", "already_ordered"], "de");
    expect(summary).toBe("2 bereits in einer Bestellung");
    expect(summary).not.toContain("Katalog");
  });

  it("is empty when nothing would be skipped", () => {
    expect(needSkipSummary([], "de")).toBe("");
  });
});

describe("needSkipReasonLabel", () => {
  it("names the order a row already sits on", () => {
    expect(needSkipReasonLabel("already_ordered", "de", "BST-2026-0042")).toBe(
      "Bereits in BST-2026-0042",
    );
    expect(needSkipReasonLabel("already_ordered", "de", null)).toBe("Bereits in Bestellung");
  });

  it("explains the other three reasons in German", () => {
    expect(needSkipReasonLabel("no_catalog_item", "de")).toBe("Kein Katalog-Artikel");
    expect(needSkipReasonLabel("other_supplier", "de")).toBe("Anderer Lieferant");
    // One reason covers "Erledigt" AND "Verfügbar", so the wording has to fit
    // both: the material is no longer missing either way.
    expect(needSkipReasonLabel("completed", "de")).toBe("Nicht mehr offen");
  });
});
