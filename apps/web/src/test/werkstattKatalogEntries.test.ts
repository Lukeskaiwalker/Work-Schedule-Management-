/**
 * The catalogue page's arithmetic, tested without a DOM.
 *
 * Each of these decides something the user is told: how many rows came back,
 * whether the answer was cut off at the server's row cap, how many suppliers
 * really sell a product, and what survives the hand-off to the "Neuer Bedarf"
 * dialog. Getting any of them quietly wrong is how a page starts stating
 * things that are not true.
 */
import { describe, expect, it } from "vitest";
import {
  KATALOG_FETCH_LIMIT,
  KATALOG_SEARCH_LIMIT,
  countCatalogRows,
  describeImageDeletion,
  groupImage,
  groupSupplierCount,
  imageRemovedMessage,
  isTruncated,
  rowLabel,
  supplierLeadTimes,
  supplierTagText,
  toBedarfSeed,
  trimToRowLimit,
  withCatalogImage,
} from "../components/werkstatt/katalogEntries";
import type {
  MaterialCatalogItemLite,
  WerkstattCatalogGroup,
  WerkstattSupplier,
} from "../types/werkstatt";

function lite(over: Partial<MaterialCatalogItemLite> & { id: number }): MaterialCatalogItemLite {
  return {
    external_key: `key-${over.id}`,
    supplier_id: null,
    supplier_name: null,
    article_no: null,
    item_name: "Rohr M20",
    ean: null,
    manufacturer: null,
    unit: null,
    price_text: null,
    image_url: null,
    ...over,
  };
}

function group(rows: MaterialCatalogItemLite[], ean: string | null = null): WerkstattCatalogGroup {
  return { ean, hero: rows[0], suppliers: rows };
}

function supplier(over: Partial<WerkstattSupplier> & { id: number }): WerkstattSupplier {
  return {
    name: `Lieferant ${over.id}`,
    short_name: null,
    email: null,
    order_email: null,
    phone: null,
    contact_person: null,
    address_street: null,
    address_zip: null,
    address_city: null,
    address_country: null,
    default_lead_time_days: null,
    notes: null,
    order_identifier: "supplier_no",
    order_channel: "manual",
    is_archived: false,
    article_count: 0,
    last_order_at: null,
    created_at: "2026-01-01T08:00:00Z",
    updated_at: "2026-01-01T08:00:00Z",
    ...over,
  };
}

describe("countCatalogRows / isTruncated", () => {
  it("counts supplier rows, not cards", () => {
    const groups = [
      group([lite({ id: 1 }), lite({ id: 2 })], "400"),
      group([lite({ id: 3 })]),
    ];
    expect(countCatalogRows(groups)).toBe(3);
    expect(groups.length).toBe(2);
  });

  /* The page fetches one row MORE than it renders, so "cut off" and "that is
   * all there is" are different lengths instead of the same one. A pool that
   * holds exactly the cap used to be reported as having further hits, sending
   * a buyer off to narrow a search that was already complete. */
  it("asks for one row more than it shows", () => {
    expect(KATALOG_FETCH_LIMIT).toBe(KATALOG_SEARCH_LIMIT + 1);
  });

  it("does not claim further hits when the pool holds exactly the limit", () => {
    const exactly = [
      group(Array.from({ length: KATALOG_SEARCH_LIMIT }, (_, i) => lite({ id: i + 1 })), "400"),
    ];
    expect(countCatalogRows(exactly)).toBe(KATALOG_SEARCH_LIMIT);
    expect(isTruncated(exactly)).toBe(false);
  });

  it("calls a result truncated only when a row beyond the page came back", () => {
    const short = [group([lite({ id: 1 })])];
    const over = [
      group(Array.from({ length: KATALOG_FETCH_LIMIT }, (_, i) => lite({ id: i + 1 })), "400"),
    ];
    expect(isTruncated(short)).toBe(false);
    expect(isTruncated(over)).toBe(true);
  });
});

describe("trimToRowLimit", () => {
  it("drops the probe row so the list matches the number in the note", () => {
    const groups = [
      group([lite({ id: 1 }), lite({ id: 2 })], "400"),
      group([lite({ id: 3 }), lite({ id: 4 })], "401"),
    ];
    const trimmed = trimToRowLimit(groups, 3);

    expect(countCatalogRows(trimmed)).toBe(3);
    expect(trimmed[1].suppliers.map((row) => row.id)).toEqual([3]);
    // The hero is the group's first row, so it survives a tail trim.
    expect(trimmed[1].hero.id).toBe(3);
    // The input is the state the page still renders until this result lands.
    expect(countCatalogRows(groups)).toBe(4);
  });

  it("drops whole groups that lie past the budget", () => {
    const groups = [group([lite({ id: 1 })]), group([lite({ id: 2 })])];
    expect(trimToRowLimit(groups, 1)).toHaveLength(1);
  });

  it("leaves a result that fits exactly alone", () => {
    const groups = [group([lite({ id: 1 }), lite({ id: 2 })], "400")];
    expect(trimToRowLimit(groups, 2)).toEqual(groups);
  });
});

describe("supplierTagText", () => {
  const two = group([lite({ id: 1, supplier_id: 7 }), lite({ id: 2, supplier_id: 9 })], "400");

  it("names the count when it really is the whole catalogue's answer", () => {
    expect(supplierTagText(two, { de: true, filtered: false, truncated: false })).toBe(
      "2 Lieferanten",
    );
    expect(
      supplierTagText(group([lite({ id: 1, supplier_id: 7 })]), {
        de: true,
        filtered: false,
        truncated: false,
      }),
    ).toBe("1 Lieferant");
  });

  /* With a chip active the server filtered before it grouped, so every card
   * holds one supplier by construction. Printed as "1 Lieferant" beside the
   * product name that reads as "nobody else carries this" — a claim about the
   * whole catalogue made from a single-supplier query. */
  it("never prints a count while a supplier chip is filtering the query", () => {
    const filtered = group([lite({ id: 1, supplier_id: 9 })], "400");
    expect(supplierTagText(filtered, { de: true, filtered: true, truncated: false })).toBe(
      "Treffer bei diesem Lieferanten",
    );
    expect(supplierTagText(filtered, { de: false, filtered: true, truncated: false })).toBe(
      "hit at this supplier",
    );
  });

  it("qualifies the count when the row cap could have split the product", () => {
    expect(supplierTagText(two, { de: true, filtered: false, truncated: true })).toBe(
      "2 Lieferanten auf dieser Seite",
    );
    expect(supplierTagText(two, { de: false, filtered: false, truncated: true })).toBe(
      "2 suppliers on this page",
    );
  });

  it("still says 'ohne Lieferant' rather than '0 Lieferanten'", () => {
    expect(
      supplierTagText(group([lite({ id: 1 })]), { de: true, filtered: false, truncated: false }),
    ).toBe("ohne Lieferant");
  });
});

describe("describeImageDeletion / imageRemovedMessage", () => {
  const unielektro = lite({
    id: 1,
    external_key: "k1",
    supplier_id: 7,
    supplier_name: "Unielektro",
    image_url: "/a.png",
  });
  const sonepar = lite({
    id: 2,
    external_key: "k2",
    supplier_id: 9,
    supplier_name: "Sonepar",
    image_url: "/b.png",
  });

  /* `groupImage` falls through to the next row that has a picture, so the card
   * can show a DIFFERENT wholesaler's image the instant the first one is
   * deleted. Announced as a bare "Bild entfernt." that is indistinguishable
   * from nothing having happened — and the next click destroys the second
   * wholesaler's image too. */
  it("reports the substitution that would otherwise look like a failed delete", () => {
    const deletion = describeImageDeletion([group([unielektro, sonepar], "400")], "k1");

    expect(deletion.removed?.id).toBe(1);
    expect(deletion.fallback?.id).toBe(2);
    const message = imageRemovedMessage(deletion, true);
    expect(message).toContain("Bild von Unielektro entfernt.");
    expect(message).toContain("Sonepar");
  });

  it("says only what happened when no other row carries a picture", () => {
    const deletion = describeImageDeletion(
      [group([unielektro, lite({ id: 3, external_key: "k3", supplier_name: "Sonepar" })], "400")],
      "k1",
    );

    expect(deletion.fallback).toBeNull();
    expect(imageRemovedMessage(deletion, true)).toBe("Bild von Unielektro entfernt.");
    // Never promises a replacement: an uploaded picture has no original to
    // come back from, and the scraper may find nothing at all.
    expect(imageRemovedMessage(deletion, true)).not.toContain("wieder");
  });

  it("names a row that has no supplier by its article number", () => {
    expect(rowLabel(lite({ id: 4, article_no: "11102138" }), true)).toBe("Art.-Nr. 11102138");
    expect(rowLabel(lite({ id: 5, supplier_name: "Sonepar" }), true)).toBe("Sonepar");
  });
});

describe("groupSupplierCount", () => {
  it("counts distinct suppliers, so one wholesaler with two rows is still one", () => {
    const g = group([
      lite({ id: 1, supplier_id: 7 }),
      lite({ id: 2, supplier_id: 7 }),
      lite({ id: 3, supplier_id: 9 }),
    ], "400");
    expect(groupSupplierCount(g)).toBe(2);
  });

  it("counts nobody when the rows carry no supplier link", () => {
    expect(groupSupplierCount(group([lite({ id: 1 }), lite({ id: 2 })], "400"))).toBe(0);
  });
});

describe("groupImage", () => {
  it("prefers the hero's own picture", () => {
    const g = group([lite({ id: 1, image_url: "/a.png" }), lite({ id: 2, image_url: "/b.png" })], "400");
    expect(groupImage(g)?.image_url).toBe("/a.png");
  });

  it("falls back to whichever supplier row has one", () => {
    const g = group([lite({ id: 1 }), lite({ id: 2, image_url: "/b.png" })], "400");
    expect(groupImage(g)?.id).toBe(2);
  });

  it("answers null when the product has no picture anywhere", () => {
    expect(groupImage(group([lite({ id: 1 })]))).toBeNull();
  });
});

describe("withCatalogImage", () => {
  it("patches every row with that external key and leaves the input untouched", () => {
    const before = [
      group([lite({ id: 1, external_key: "k1" }), lite({ id: 2, external_key: "k2" })], "400"),
      group([lite({ id: 3, external_key: "k1" })]),
    ];
    const after = withCatalogImage(before, "k1", "/new.png");

    expect(after[0].hero.image_url).toBe("/new.png");
    expect(after[0].suppliers[1].image_url).toBeNull();
    expect(after[1].hero.image_url).toBe("/new.png");
    // The previous state is never mutated: the list is re-rendered from it.
    expect(before[0].hero.image_url).toBeNull();
    expect(after).not.toBe(before);
  });

  it("clears a picture when handed null", () => {
    const before = [group([lite({ id: 1, external_key: "k1", image_url: "/old.png" })])];
    expect(withCatalogImage(before, "k1", null)[0].hero.image_url).toBeNull();
  });
});

describe("supplierLeadTimes", () => {
  it("keeps only the suppliers that actually recorded one", () => {
    const map = supplierLeadTimes([
      supplier({ id: 7, default_lead_time_days: 3 }),
      supplier({ id: 9 }),
    ]);
    expect(map.get(7)).toBe(3);
    expect(map.has(9)).toBe(false);
  });
});

describe("toBedarfSeed", () => {
  it("carries across everything the dialog reads", () => {
    const seed = toBedarfSeed(
      lite({
        id: 501,
        article_no: "11102138",
        item_name: "NYM-J 5x6 grau",
        manufacturer: "Lapp",
        unit: "m",
        ean: "4011234567890",
      }),
    );
    expect(seed).toMatchObject({
      id: 501,
      article_no: "11102138",
      item_name: "NYM-J 5x6 grau",
      manufacturer: "Lapp",
      unit: "m",
      ean: "4011234567890",
    });
  });

  it("leaves the provenance the Werkstatt endpoint does not return empty", () => {
    const seed = toBedarfSeed(lite({ id: 501 }));
    expect(seed.source_file).toBe("");
    expect(seed.source_line).toBe(0);
  });
});
