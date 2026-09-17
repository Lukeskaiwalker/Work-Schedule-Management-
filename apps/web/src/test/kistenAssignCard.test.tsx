/**
 * The crate card offers only what the crate's state actually allows.
 *
 * Two buttons could be pressed into a guaranteed server refusal:
 *
 *  * "Packen & zuweisen" stayed live for a crate in `zurueck`, where the FSM
 *    has no edge to `gepackt` at all — the workshop got a 400 where they
 *    wanted "Erneut öffnen".
 *  * "Kiste leeren" stayed live for a sealed crate, and emptying one is
 *    refused: a `gepackt` crate is advertised as ready to take on this card,
 *    on the wall screen and to the station's handover endpoint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattKistenPage } from "../pages/werkstatt/WerkstattKistenPage";

const ITEM = {
  id: 1,
  box_id: 42,
  source: "manual",
  article_id: null,
  catalog_external_key: null,
  item_name: "Klemmen",
  article_no: null,
  ean: null,
  unit: "Stk",
  quantity: 4,
  notes: null,
};

function box(status: string) {
  return {
    id: 42,
    box_number: "BK-2026-0007",
    label: "Kiste Rückläufer",
    slot: null,
    status,
    customer_id: 5,
    customer_name: "Musterbau GmbH",
    project_id: null,
    project_name: null,
    item_count: 1,
    packed_at: status === "offen" ? null : "2026-09-10T08:00:00Z",
    assigned_at: null,
    returned_at: null,
    notes: null,
    items: [ITEM],
  };
}

/** The list, and the detail the click fetches. Both are the same crate. */
function stubApi(status: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith("/werkstatt/boxes") ? [box(status)] : box(status);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

/** Render the page and open the one ad-hoc crate on it. */
async function openCrate(status: string) {
  stubApi(status);
  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            mainView: "werkstatt",
            werkstattTab: "kisten",
            language: "de",
            token: "test-token",
            customers: [{ id: 5, name: "Musterbau GmbH" }],
          },
        }) as never
      }
    >
      <WerkstattKistenPage />
    </AppContext.Provider>,
  );
  fireEvent.click(await screen.findByText("Kiste Rückläufer"));
  // The detail fetch resolves into state before the assertions run.
  await screen.findByText("Inhalt (1)");
}

describe("Kisten — the assign card", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("will not offer to pack a crate that came back", async () => {
    await openCrate("zurueck");

    expect(screen.getByRole("button", { name: "Packen & zuweisen" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Erneut öffnen" })).toBeEnabled();
    expect(screen.getByText(/Erst „Erneut öffnen“|Erneut öffnen“, dann packen/)).toBeTruthy();
  });

  it("offers packing on an open crate that has a customer and something in it", async () => {
    await openCrate("offen");

    expect(screen.getByRole("button", { name: "Packen & zuweisen" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Erneut öffnen" })).toBeNull();
  });

  it("hides „Kiste leeren“ on a sealed crate, and keeps the two real actions", async () => {
    await openCrate("gepackt");

    expect(screen.queryByRole("button", { name: "Kiste leeren" })).toBeNull();
    expect(screen.getByRole("button", { name: "Übergabe buchen" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Zuweisung aufheben" })).toBeEnabled();
  });

  it("still offers „Kiste leeren“ while the crate is open", async () => {
    await openCrate("offen");

    expect(screen.getByRole("button", { name: "Kiste leeren" })).toBeEnabled();
  });
});
