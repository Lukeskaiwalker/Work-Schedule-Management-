/**
 * Typing a quantity into a crate line instead of tapping + forty times.
 *
 * The owner asked for it: a line of 40 Wago clamps or 25 m of cable took one
 * tap per piece. The number between − and + is now a field — Enter or leaving
 * it commits, Escape or an empty/garbled entry puts the line's number back,
 * and 0 removes the line exactly the way − at 1 does.
 *
 * Every change still goes out as ONE debounced PATCH per line (DELETE at 0)
 * through the page's queue, so the stub records each request and its body:
 * the request list is the contract.
 *
 * A hardware scanner types like a keyboard and ends with Enter. If one fires
 * while the quantity field has focus, the page's scanner listener claims the
 * Enter and adds the scanned article — the digits must never become a
 * quantity, and a number typed before the scan must not be lost with them.
 * A code that reaches the field without being recognised as a scan is
 * refused by its size instead.
 *
 * What a pending count does when the crate moves on (handover, back to the
 * rack, another write still on its way) is in kistenQtyWrites.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import {
  BOX_ID,
  crateLine,
  crateWith,
  lineUrl,
  mountCrate,
  plusButtons,
  press,
  qtyField,
  quiet,
  typeInto,
  writes,
} from "./fixtures/kistenCrateServer";

const CLAMPS = crateLine({});
const CABLE = crateLine({ id: 2, article_id: 12, item_name: "Mantelleitung 3x1,5", article_no: "SP-0012", unit: "m", quantity: 25 });
const CRATE = crateWith([CLAMPS, CABLE]);

/** An invented EAN and the stocked article it resolves to. */
const SCANNED_EAN = "4099999000013";
const SCANNED_HIT = {
  source: "article",
  article_id: 77,
  catalog_external_key: null,
  item_name: "Verbindungsklemme 3-fach",
  article_no: "SP-0077",
  ean: SCANNED_EAN,
  unit: "Stk",
  stock_available: 120,
  match: "exact_ean",
  supplier_name: null,
  supplier_article_no: null,
};

const TOO_LARGE_HINT = "Menge zu groß — Scan im Mengenfeld?";
const NOT_A_NUMBER_HINT = "Nur ganze Zahlen";

/**
 * A scanner: the characters land in the field behind `before` (what the
 * field held: nothing when focusing it selected the number), then the
 * keystrokes arrive a few milliseconds apart and end with Enter. The
 * keystrokes are what the page's scanner listener times; dispatching them
 * back to back keeps them well inside its 30 ms window however slow the
 * machine is.
 */
function scanInto(field: HTMLInputElement, code: string, before = "") {
  typeInto(field, before + code);
  for (const char of code) press(field, char);
  press(field, "Enter");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Kisten — typing a line's quantity", () => {
  it("sends exactly one PATCH for a typed 12 and Enter", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CLAMPS.item_name);

    typeInto(field, "12");
    press(field, "Enter");

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    await quiet();
    expect(writes(calls)).toEqual([{ method: "PATCH", path: lineUrl(CLAMPS.id), body: { quantity: 12 } }]);
    await waitFor(() => expect(qtyField(CLAMPS.item_name).value).toBe("12"));
  });

  it("commits what was typed when the field is left", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CABLE.item_name);

    typeInto(field, "40");
    fireEvent.blur(field);

    await waitFor(() =>
      expect(writes(calls)).toEqual([{ method: "PATCH", path: lineUrl(CABLE.id), body: { quantity: 40 } }]),
    );
  });

  it("puts the number back on Escape and sends nothing", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CLAMPS.item_name);

    typeInto(field, "12");
    press(field, "Escape");
    expect(field.value).toBe("3");
    fireEvent.blur(field);

    await quiet();
    expect(writes(calls)).toEqual([]);
    expect(qtyField(CLAMPS.item_name).value).toBe("3");
  });

  it("puts the number back when the field is emptied, never deleting the line", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CLAMPS.item_name);

    typeInto(field, "");
    press(field, "Enter");
    typeInto(field, "  ");
    fireEvent.blur(field);

    await quiet();
    expect(writes(calls)).toEqual([]);
    expect(qtyField(CLAMPS.item_name).value).toBe("3");
    expect(screen.queryByText(NOT_A_NUMBER_HINT)).toBeNull();
  });

  it("refuses what is not a whole number, says so, and sends nothing", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CABLE.item_name);

    // 1,5 m of cable is a real thing to mean, and 15 would be the wrong line.
    typeInto(field, "1,5");
    press(field, "Enter");

    expect(await screen.findByText(NOT_A_NUMBER_HINT)).toBeInTheDocument();
    await quiet();
    expect(writes(calls)).toEqual([]);
    expect(qtyField(CABLE.item_name).value).toBe("25");
  });

  it("removes the line on 0 — the same DELETE that − sends at 1", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CLAMPS.item_name);

    typeInto(field, "0");
    press(field, "Enter");

    await waitFor(() => expect(writes(calls)).toEqual([{ method: "DELETE", path: lineUrl(CLAMPS.id), body: null }]));
    await screen.findByText("Inhalt (1)");
    expect(screen.queryByLabelText(`Menge ${CLAMPS.item_name}`)).toBeNull();
  });

  it("sends nothing when the typed number is the one already there", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CABLE.item_name);

    typeInto(field, "25");
    press(field, "Enter");
    typeInto(field, "025");
    fireEvent.blur(field);

    await quiet();
    expect(writes(calls)).toEqual([]);
  });

  it("counts + on from the typed number", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CLAMPS.item_name);

    // Without Enter: the tap has to take the typed number, not the old one.
    typeInto(field, "12");
    fireEvent.click(plusButtons()[0]);

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    await quiet();
    expect(writes(calls)).toEqual([{ method: "PATCH", path: lineUrl(CLAMPS.id), body: { quantity: 13 } }]);
  });

  it("counts + on from a number committed with Enter", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CLAMPS.item_name);

    typeInto(field, "12");
    press(field, "Enter");
    fireEvent.click(plusButtons()[0]);

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    await quiet();
    expect(writes(calls).map((call) => call.body)).toEqual([{ quantity: 13 }]);
  });

  it("selects the whole number on focus, so typing replaces it", async () => {
    await mountCrate(CRATE);
    const field = qtyField(CABLE.item_name);

    fireEvent.focus(field);

    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe("25".length);
  });

  it("raises the number pad, not the full keyboard", async () => {
    await mountCrate(CRATE);

    expect(qtyField(CLAMPS.item_name)).toHaveAttribute("inputmode", "numeric");
  });

  it("refuses a code that reached the field as a number, with a hint, and sends nothing", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CLAMPS.item_name);

    // Pasted, or from a scanner too slow to be told apart from typing.
    typeInto(field, SCANNED_EAN);
    press(field, "Enter");

    expect(await screen.findByText(TOO_LARGE_HINT)).toBeInTheDocument();
    await quiet();
    expect(writes(calls)).toEqual([]);
    expect(qtyField(CLAMPS.item_name).value).toBe("3");
  });

  it("refuses one past the API's limit but takes the limit itself", async () => {
    const { calls } = await mountCrate(CRATE);
    const field = qtyField(CABLE.item_name);

    typeInto(field, "10001");
    press(field, "Enter");
    expect(await screen.findByText(TOO_LARGE_HINT)).toBeInTheDocument();

    typeInto(field, "10000");
    press(field, "Enter");

    await waitFor(() => expect(writes(calls).map((call) => call.body)).toEqual([{ quantity: 10000 }]));
    expect(screen.queryByText(TOO_LARGE_HINT)).toBeNull();
  });

  it("adds the scanned article when a scanner fires into the quantity field", async () => {
    const { calls } = await mountCrate(CRATE, { [SCANNED_EAN]: [SCANNED_HIT] });
    const field = qtyField(CLAMPS.item_name);

    scanInto(field, SCANNED_EAN);

    expect(await screen.findByText(SCANNED_HIT.item_name)).toBeInTheDocument();
    await quiet();
    const sent = writes(calls);
    expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([`POST /api/werkstatt/boxes/${BOX_ID}/items`]);
    expect(sent[0].body).toMatchObject({ article_id: SCANNED_HIT.article_id, ean: SCANNED_EAN, quantity: 1 });
    expect(qtyField(CLAMPS.item_name).value).toBe("3");
    expect(screen.queryByText(TOO_LARGE_HINT)).toBeNull();
  });

  it("keeps a number typed before a scan that landed in the same field", async () => {
    const { calls } = await mountCrate(CRATE, { [SCANNED_EAN]: [SCANNED_HIT] });
    const field = qtyField(CABLE.item_name);

    // 40 typed, no Enter, then the next article scanned at a desk: the
    // scanner's digits land behind the 40 and its Enter is the scan's.
    typeInto(field, "40");
    scanInto(field, SCANNED_EAN, "40");

    expect(await screen.findByText(SCANNED_HIT.item_name)).toBeInTheDocument();
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    await quiet();
    expect(writes(calls)).toEqual([
      expect.objectContaining({ method: "POST", path: `/api/werkstatt/boxes/${BOX_ID}/items` }),
      { method: "PATCH", path: lineUrl(CABLE.id), body: { quantity: 40 } },
    ]);
    expect(qtyField(CABLE.item_name).value).toBe("40");
    expect(screen.queryByText(TOO_LARGE_HINT)).toBeNull();
  });

  it("shows a handed-over crate's numbers without a field", async () => {
    await mountCrate(
      crateWith([CLAMPS, CABLE], {
        status: "zugewiesen",
        customer_id: 12,
        customer_name: "Beispiel, Max",
        assigned_at: "2026-10-20T10:00:00Z",
      }),
    );

    expect(screen.queryByRole("textbox", { name: /^Menge / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Menge erhöhen" })).toBeNull();
    expect(screen.getByText("25 m")).toBeInTheDocument();
  });
});

describe("Kisten — − and + still step a line", () => {
  it("+ sends the next number", async () => {
    const { calls } = await mountCrate(CRATE);

    fireEvent.click(plusButtons()[1]);

    await waitFor(() =>
      expect(writes(calls)).toEqual([{ method: "PATCH", path: lineUrl(CABLE.id), body: { quantity: 26 } }]),
    );
  });

  it("rapid taps compound into one PATCH", async () => {
    const { calls } = await mountCrate(CRATE);
    const plus = plusButtons()[0];

    fireEvent.click(plus);
    fireEvent.click(plus);
    fireEvent.click(plus);

    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    await quiet();
    expect(writes(calls).map((call) => call.body)).toEqual([{ quantity: 6 }]);
  });

  it("− at 1 removes the line", async () => {
    const { calls } = await mountCrate(crateWith([crateLine({ quantity: 1 })]));

    fireEvent.click(screen.getByRole("button", { name: "Menge verringern" }));

    await waitFor(() => expect(writes(calls)).toEqual([{ method: "DELETE", path: lineUrl(CLAMPS.id), body: null }]));
    await screen.findByText("Inhalt (0)");
  });
});
