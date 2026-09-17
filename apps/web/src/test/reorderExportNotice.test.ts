/**
 * The sentence under a downloaded order CSV.
 *
 * The export deliberately drops every position the identifier policy cannot
 * express, so the file can be shorter than the order the page just said it
 * created. Reporting only `sent_positions` leaves the buyer e-mailing a
 * three-line CSV for a five-line order — the two articles are never ordered,
 * nobody learns which, and the shortage turns up on the Baustelle.
 */
import { describe, expect, it } from "vitest";

import { orderCsvNotice } from "../utils/reorderExportNotice";
import type { OrderExportResult } from "../types/werkstattProcurement";

function result(overrides: Partial<OrderExportResult> = {}): OrderExportResult {
  return {
    order_id: 4242,
    order_number: "BST-2026-0042",
    filename: "BST-2026-0042.csv",
    identifier: "supplier_no",
    csv: "a;b",
    text: "a",
    warnings: [],
    sent_positions: 5,
    dropped_positions: 0,
    submitted_at: "2026-09-17T08:00:00Z",
    ...overrides,
  };
}

describe("orderCsvNotice", () => {
  it("says what the file is missing, and names it", () => {
    const notice = orderCsvNotice(
      result({
        sent_positions: 3,
        dropped_positions: 2,
        warnings: [
          "Unielektro hat keine Artikelnummer für „Kabelbinder 200 mm“",
          "Unielektro hat keine Artikelnummer für „Aderendhülse 2,5“",
        ],
      }),
      true,
    );

    // The count the order carries (5) has to appear beside the count the file
    // carries (3), or the discrepancy is visible but unexplained.
    expect(notice).toContain("3 von 5 Positionen");
    expect(notice).toContain("2 ohne Lieferanten-Artikelnummer sind NICHT in der Datei");
    expect(notice).toContain("Kabelbinder 200 mm");
    expect(notice).toContain("Aderendhülse 2,5");
    // Same shape as the Bestellungen drawer: warnings first, then the file.
    expect(notice.indexOf("Kabelbinder")).toBeLessThan(notice.indexOf("BST-2026-0042.csv"));
  });

  it("counts one missing position in the singular", () => {
    const notice = orderCsvNotice(
      result({ sent_positions: 4, dropped_positions: 1, warnings: [] }),
      true,
    );
    expect(notice).toContain("4 von 5 Positionen");
    expect(notice).toContain("1 ohne Lieferanten-Artikelnummer ist NICHT in der Datei");
  });

  it("stays short when the file holds the whole order", () => {
    expect(orderCsvNotice(result(), true)).toBe(
      "BST-2026-0042.csv heruntergeladen (5 Positionen).",
    );
    expect(orderCsvNotice(result({ sent_positions: 1 }), true)).toBe(
      "BST-2026-0042.csv heruntergeladen (1 Position).",
    );
  });

  it("still carries a warning that came without a dropped position", () => {
    const notice = orderCsvNotice(
      result({ warnings: ["Artikelnummer aus dem Katalog ergänzt"] }),
      true,
    );
    expect(notice).toBe(
      "Artikelnummer aus dem Katalog ergänzt — BST-2026-0042.csv heruntergeladen (5 Positionen).",
    );
  });

  it("says the same thing in English", () => {
    const notice = orderCsvNotice(
      result({ sent_positions: 3, dropped_positions: 2, warnings: ["no number for tie wraps"] }),
      false,
    );
    expect(notice).toContain("3 of 5 lines");
    expect(notice).toContain("2 without a supplier article number are NOT in the file");
    expect(notice).toContain("no number for tie wraps");
  });
});
