/**
 * A typed count is saved before the crate moves on, and only ever paints the
 * crate it belongs to.
 *
 * A line's new count goes out after a 350 ms pause (one PATCH per line, the
 * latest value), and a typed number is committed when the field is left —
 * which, with a mouse or on Android, is the very press on the next button.
 * Three things went wrong with that:
 *
 *   - "Übergabe buchen" posted the handover at once, so the stock left the
 *     shelf at the old count and the typed one was refused afterwards; on iOS,
 *     where a tapped button may not take focus, the number was never sent;
 *   - the write's refetch opened its crate again, so "← Alle Kisten" right
 *     after typing brought the crate back, over the rack or over the next
 *     crate opened — where the next scans would then have gone;
 *   - a write that finished cleared the line's pending number even when a
 *     newer one had been entered meanwhile, and the newer one was never sent.
 *
 * Also pinned here: a number typed but not committed is dropped when the
 * line's count changes under it (a scan topping the line up, a failed write
 * putting it back), so a forgotten draft cannot be committed much later.
 *
 * Invented data only: the repo is public.
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

const CLAMPS_EAN = "4099999000020";
const CLAMPS = crateLine({ ean: CLAMPS_EAN });
const CABLE = crateLine({ id: 2, article_id: 12, item_name: "Mantelleitung 3x1,5", article_no: "SP-0012", unit: "m", quantity: 25 });
const CRATE = crateWith([CLAMPS, CABLE]);
const OWNER = { customer_id: 12, customer_name: "Beispiel, Max" };
const PACKED = crateWith([CLAMPS, CABLE], { ...OWNER, status: "gepackt", packed_at: "2026-10-20T09:00:00Z" });
const KISTE_5 = crateWith(
  [crateLine({ id: 51, box_id: 45, article_id: 13, item_name: "Verbindungsklemme 2-fach", article_no: "SP-0013" })],
  { id: 45, box_number: "K5", label: "Kiste 5", slot: 5 },
);

/** What an item search for the clamps' EAN answers: exactly that line's article. */
const CLAMPS_HIT = {
  source: "article",
  article_id: CLAMPS.article_id,
  catalog_external_key: null,
  item_name: CLAMPS.item_name,
  article_no: CLAMPS.article_no,
  ean: CLAMPS_EAN,
  unit: "Stk",
  stock_available: 50,
  match: "exact_ean",
  supplier_name: null,
  supplier_article_no: null,
};

const PATCH_CABLE_40 = { method: "PATCH", path: lineUrl(CABLE.id), body: { quantity: 40 } };

/** Typed into the cable line and left — the press on the next button blurs it first. */
function typeFortyMetresAndLeave() {
  const field = qtyField(CABLE.item_name);
  typeInto(field, "40");
  fireEvent.blur(field);
}

function button(name: string | RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

/** A scan fired while focus is elsewhere: fast keystrokes ending with Enter. */
function scanElsewhere(code: string) {
  for (const char of code) fireEvent.keyDown(document.body, { key: char });
  fireEvent.keyDown(document.body, { key: "Enter" });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Kisten — a typed count goes out before the crate moves on", () => {
  it("saves it before „Übergabe buchen“, so the handover books it", async () => {
    const { calls } = await mountCrate(PACKED);

    typeFortyMetresAndLeave();
    fireEvent.click(button("Übergabe buchen"));

    expect(await screen.findByText("40 m")).toBeInTheDocument();
    expect(writes(calls)).toEqual([
      PATCH_CABLE_40,
      { method: "POST", path: `/api/werkstatt/boxes/${BOX_ID}/status`, body: { status: "zugewiesen" } },
    ]);
  });

  it("saves a number still in the field when the tapped button takes no focus (iOS)", async () => {
    const { calls } = await mountCrate(PACKED);
    const field = qtyField(CABLE.item_name);

    // Really focused, and nothing blurs it before the click.
    field.focus();
    fireEvent.change(field, { target: { value: "40" } });
    fireEvent.click(button("Übergabe buchen"));

    expect(await screen.findByText("40 m")).toBeInTheDocument();
    expect(writes(calls)).toEqual([
      PATCH_CABLE_40,
      { method: "POST", path: `/api/werkstatt/boxes/${BOX_ID}/status`, body: { status: "zugewiesen" } },
    ]);
  });

  it("saves it before „Packen & zuweisen“", async () => {
    const { calls } = await mountCrate(crateWith([CLAMPS, CABLE], OWNER));

    typeFortyMetresAndLeave();
    fireEvent.click(button("Packen & zuweisen"));

    expect(await screen.findByText(/Gepackt für Beispiel, Max/)).toBeInTheDocument();
    expect(writes(calls)).toEqual([
      PATCH_CABLE_40,
      { method: "POST", path: `/api/werkstatt/boxes/${BOX_ID}/pack`, body: { customer_id: 12, project_id: null } },
    ]);
  });
});

describe("Kisten — a write lands on its own crate only", () => {
  it("stays on the rack after „Alle Kisten“, and the count is saved", async () => {
    const { calls } = await mountCrate(CRATE);

    typeFortyMetresAndLeave();
    fireEvent.click(button(/Alle Kisten/));

    expect(screen.getByText("Standardkisten")).toBeInTheDocument();
    await waitFor(() => expect(writes(calls)).toEqual([PATCH_CABLE_40]));
    await quiet();
    expect(screen.getByText("Standardkisten")).toBeInTheDocument();
    expect(screen.queryByText(/^Inhalt \(/)).toBeNull();
  });

  it("keeps the crate opened next on screen when the last one's count lands", async () => {
    const { calls } = await mountCrate(CRATE, {}, [KISTE_5]);

    typeFortyMetresAndLeave();
    fireEvent.click(button(/Alle Kisten/));
    fireEvent.click(await screen.findByText("Kiste 5"));

    expect(await screen.findByText("Inhalt (1)")).toBeInTheDocument();
    await waitFor(() => expect(writes(calls)).toEqual([PATCH_CABLE_40]));
    await quiet();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Kiste 5");
    expect(screen.getByText("Inhalt (1)")).toBeInTheDocument();
  });

  it("still sends a change made while the previous one is on its way", async () => {
    const server = await mountCrate(CRATE);
    const releaseFirst = server.holdNextWrite();
    const field = qtyField(CLAMPS.item_name);

    typeInto(field, "12");
    press(field, "Enter");
    await waitFor(() => expect(writes(server.calls)).toHaveLength(1));
    // 12 is under way; + makes it 13, and then 12's answer arrives.
    fireEvent.click(plusButtons()[0]);
    releaseFirst();

    await waitFor(() => expect(writes(server.calls)).toHaveLength(2));
    await quiet();
    expect(writes(server.calls).map((call) => call.body)).toEqual([{ quantity: 12 }, { quantity: 13 }]);
    expect(qtyField(CLAMPS.item_name).value).toBe("13");
  });
});

describe("Kisten — a typed number gives way when the line's count moves under it", () => {
  it("is dropped when a scan tops the same line up", async () => {
    const { calls } = await mountCrate(CRATE, { [CLAMPS_EAN]: [CLAMPS_HIT] });

    typeInto(qtyField(CLAMPS.item_name), "40");
    scanElsewhere(CLAMPS_EAN);

    await waitFor(() => expect(qtyField(CLAMPS.item_name).value).toBe("4"));
    fireEvent.blur(qtyField(CLAMPS.item_name));
    await quiet();
    expect(writes(calls).map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /api/werkstatt/boxes/${BOX_ID}/items`,
    ]);
  });

  it("is dropped when a failed write puts the line back", async () => {
    const server = await mountCrate(CRATE);
    server.failNextWrite();

    fireEvent.click(plusButtons()[0]);
    typeInto(qtyField(CLAMPS.item_name), "40");

    await waitFor(() => expect(writes(server.calls)).toHaveLength(1));
    await waitFor(() => expect(qtyField(CLAMPS.item_name).value).toBe("3"));
    fireEvent.blur(qtyField(CLAMPS.item_name));
    await quiet();
    expect(writes(server.calls).map((call) => call.body)).toEqual([{ quantity: 4 }]);
  });
});
