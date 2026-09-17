/**
 * The phone screens used to render fixture strings: "seit 3 Tagen" was a
 * literal, true on one day of the year. These are the functions that replaced
 * them, and the point of each test is that the answer follows the timestamp
 * rather than a constant.
 */
import { describe, expect, it } from "vitest";

import {
  greeting,
  isOverdue,
  movementFamily,
  movementSubtitle,
  movementTitle,
  projectLabel,
  returnNotice,
  sinceLabel,
} from "../components/werkstatt/mobile/mobileLabels";

const NOW = new Date(2026, 8, 17, 9, 30); // 17 Sep 2026, local

describe("sinceLabel", () => {
  it("counts calendar days, not 24-hour blocks", () => {
    // Taken out last night, looked at this morning: that is "yesterday", even
    // though barely twelve hours have passed.
    expect(sinceLabel(new Date(2026, 8, 16, 21, 0).toISOString(), NOW, true)).toBe(
      "seit gestern",
    );
    expect(sinceLabel(new Date(2026, 8, 17, 7, 0).toISOString(), NOW, true)).toBe("seit heute");
    expect(sinceLabel(new Date(2026, 8, 13, 7, 0).toISOString(), NOW, true)).toBe(
      "seit 4 Tagen",
    );
  });

  it("answers in English when the UI is English", () => {
    expect(sinceLabel(new Date(2026, 8, 13, 7, 0).toISOString(), NOW, false)).toBe("4 days out");
  });

  it("drops the segment rather than printing NaN", () => {
    expect(sinceLabel("not-a-date", NOW, true)).toBeNull();
  });
});

describe("isOverdue", () => {
  it("is false when no return date was ever agreed", () => {
    // The checkout dialog's "Datum…" chip sends null on purpose. A row must
    // not be coloured red for a promise nobody made.
    expect(isOverdue(null, NOW)).toBe(false);
  });

  it("compares against the agreed date", () => {
    expect(isOverdue(new Date(2026, 8, 16, 18, 0).toISOString(), NOW)).toBe(true);
    expect(isOverdue(new Date(2026, 8, 18, 18, 0).toISOString(), NOW)).toBe(false);
  });

  it("treats an unparseable date as no deadline", () => {
    expect(isOverdue("soon", NOW)).toBe(false);
  });
});

describe("projectLabel", () => {
  it("prefers the number, falls back to the name, then says so", () => {
    expect(projectLabel({ project_number: "P-2026-014", project_name: "Nord" }, true)).toBe(
      "P-2026-014",
    );
    expect(projectLabel({ project_number: null, project_name: "Nord" }, true)).toBe("Nord");
    expect(projectLabel({ project_number: null, project_name: null }, true)).toBe("ohne Projekt");
    expect(projectLabel({ project_number: null, project_name: null }, false)).toBe("no project");
  });
});

describe("movement rows", () => {
  it("maps all eight ledger types onto the three visual families", () => {
    expect(movementFamily("checkout")).toBe("checkout");
    expect(movementFamily("return")).toBe("return");
    expect(movementFamily("repair_back")).toBe("return");
    expect(movementFamily("intake")).toBe("inspection");
    expect(movementFamily("inventory_minus")).toBe("inspection");
  });

  it("names the stock-take movements the manual adjust endpoint writes", () => {
    // These two were missing from the API's own Literal once and surfaced as
    // 500s; a list that renders them must not fall back to a blank row.
    expect(movementTitle("inventory_plus", true)).toBe("Inventur +");
    expect(movementTitle("inventory_minus", false)).toBe("Stock-take −");
  });

  it("joins only the parts that exist", () => {
    const subtitle = movementSubtitle(
      {
        quantity: 3,
        created_at: new Date(2026, 8, 12, 14, 30).toISOString(),
        user_display_name: "Anna M.",
        project_number: null,
      },
      true,
    );
    expect(subtitle.startsWith("3× · ")).toBe(true);
    expect(subtitle.endsWith("Anna M.")).toBe(true);
  });
});

describe("greeting", () => {
  it("follows the clock instead of always saying Guten Morgen", () => {
    expect(greeting(new Date(2026, 8, 17, 7, 0), "Luca", true)).toBe("Guten Morgen, Luca");
    expect(greeting(new Date(2026, 8, 17, 13, 0), "Luca", true)).toBe("Guten Tag, Luca");
    expect(greeting(new Date(2026, 8, 17, 22, 0), "Luca", true)).toBe("Guten Abend, Luca");
  });

  it("drops the comma when there is no name to use", () => {
    expect(greeting(new Date(2026, 8, 17, 22, 0), "", false)).toBe("Good evening");
  });
});

describe("returnNotice", () => {
  it("names what each condition did, with the server's totals", () => {
    expect(
      returnNotice(
        { condition: "ok", quantity: 2, itemName: "Bohrhammer", availableAfter: 9, totalAfter: 12 },
        true,
      ),
    ).toBe("2× Bohrhammer zurückgegeben — 9 von 12 verfügbar");
    expect(
      returnNotice(
        { condition: "lost", quantity: 1, itemName: "Zange", availableAfter: 4, totalAfter: 4 },
        true,
      ),
    ).toContain("als verloren ausgebucht");
    expect(
      returnNotice(
        { condition: "repair", quantity: 1, itemName: "Saw", availableAfter: 1, totalAfter: 3 },
        false,
      ),
    ).toBe("1× Saw sent for repair — 1 of 3 available");
  });
});
