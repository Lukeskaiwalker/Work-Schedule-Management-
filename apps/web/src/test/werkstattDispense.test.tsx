/**
 * "Entnehmen" of a consumable is not a loan.
 *
 * The owner's rule (2026-10-10): anything the Maschinen tab does not list is a
 * consumable, and taking one off the shelf books it out of the inventory for
 * good — it is built in at a site. The dialog used to ask every article for an
 * "Erwartete Rückgabe" and cap the amount at the shelf count, which is the
 * loan model. These tests pin the two shapes the dialog now has:
 *
 *   consumable (`is_serialized` false or absent) — "Material entnehmen", the
 *     project first, no return date, no cap (a short shelf is booked up by the
 *     server, because the person is holding the part), "Entnehmen (Verbrauch)";
 *   machine type (`is_serialized` true) — the loan dialog exactly as before.
 *
 * And the sentence the page says afterwards, which has to follow what the
 * SERVER booked (`booked_as`), not what the dialog assumed.
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { EntnehmenModal } from "../components/werkstatt/EntnehmenModal";
import {
  dispenseNotice,
  dispenseProjectOptions,
  isConsumableArticle,
  type DispenseResult,
} from "../components/werkstatt/dispense";
import type { WerkstattCheckoutResult } from "../utils/werkstattArticlesApi";

const CABLE_TIES = {
  item_name: "Kabelbinder 200 mm",
  article_number: "SP-0311",
  location_name: "Regal C1",
  stock_available: 3,
  stock_total: 3,
};

const PROJECTS = [
  { id: "12", number: "381", title: "Neubau Schulze" },
  { id: "15", number: "402", title: "Umbau Kita" },
];

function renderModal(
  article: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const onConfirm = vi.fn();
  const view = render(
    <EntnehmenModal
      open
      language="de"
      article={{ ...CABLE_TIES, ...article }}
      projects={PROJECTS}
      onClose={() => undefined}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { ...view, onConfirm };
}

const quantityField = () => screen.getByRole("textbox", { name: "Menge" }) as HTMLInputElement;
const projectField = () =>
  screen.getByRole("combobox", { name: /Für Projekt/ }) as HTMLSelectElement;

describe("isConsumableArticle", () => {
  it("follows the owner's rule: not a machine type means consumable", () => {
    expect(isConsumableArticle({ is_serialized: false })).toBe(true);
    expect(isConsumableArticle({ is_serialized: true })).toBe(false);
  });

  it("treats a caller that does not say as a consumable", () => {
    // The Bestand page lists `kind=consumable` only and does not pass the flag.
    expect(isConsumableArticle({})).toBe(true);
    expect(isConsumableArticle({ is_serialized: null })).toBe(true);
  });
});

describe("EntnehmenModal — a consumable is used up, not lent", () => {
  it("is titled as taking material and asks for no return date", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Material entnehmen" })).toBeInTheDocument();
    expect(screen.queryByText("Erwartete Rückgabe")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("button", { name: /Entnehmen \(Verbrauch\)/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Entnahme bestätigen/ })).toBeNull();
  });

  it("puts the project first, ahead of the amount", () => {
    renderModal();
    const project = projectField();
    const quantity = quantityField();
    // DOCUMENT_POSITION_FOLLOWING: the quantity comes after the project.
    expect(project.compareDocumentPosition(quantity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(project).getByRole("option", { name: "Ohne Projekt" })).toBeInTheDocument();
    expect(within(project).getByRole("option", { name: "381 — Neubau Schulze" })).toBeInTheDocument();
    // Nothing is pre-selected: booking onto whichever project sorted first is
    // worse than booking onto none.
    expect(project.value).toBe("");
  });

  it("sends the chosen project and no return date", () => {
    const { onConfirm } = renderModal();
    fireEvent.change(projectField(), { target: { value: "12" } });
    fireEvent.change(quantityField(), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /Entnehmen \(Verbrauch\)/ }));
    expect(onConfirm).toHaveBeenCalledWith({
      quantity: 2,
      project_id: "12",
      expected_return: null,
      notes: "",
    });
  });

  it("lets more than the shelf count be taken and says the difference is booked in", () => {
    // The person is holding the part, so the COUNT was wrong; the server books
    // the shortfall as a stock-take first instead of refusing.
    const { onConfirm } = renderModal();
    fireEvent.change(quantityField(), { target: { value: "9" } });
    fireEvent.blur(quantityField());
    expect(quantityField().value).toBe("9");
    expect(
      screen.getByText("Laut Bestand nur 3 da — die Differenz von 6 wird beim Buchen nachgebucht."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Entnehmen \(Verbrauch\)/ }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ quantity: 9 }));
  });

  it("can still be taken when the count says the shelf is empty", () => {
    renderModal({ stock_available: 0, stock_total: 0 });
    expect(quantityField().value).toBe("1");
    expect(screen.getByRole("button", { name: /Entnehmen \(Verbrauch\)/ })).toBeEnabled();
    expect(screen.queryByText(/Nichts verfügbar/)).toBeNull();
  });

  it("refuses an empty amount", () => {
    renderModal();
    fireEvent.change(quantityField(), { target: { value: "" } });
    expect(screen.getByRole("button", { name: /Entnehmen \(Verbrauch\)/ })).toBeDisabled();
  });

  it("shows the in-flight state on the button", () => {
    const { onConfirm } = renderModal({}, { submitting: true });
    const busy = screen.getByRole("button", { name: "Wird gebucht…" });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("speaks English when the UI does", () => {
    renderModal({}, { language: "en" });
    expect(screen.getByRole("dialog", { name: "Take material" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Take \(consumption\)/ })).toBeEnabled();
    expect(screen.getByRole("option", { name: "No project" })).toBeInTheDocument();
  });
});

describe("EntnehmenModal — a machine type keeps the loan dialog", () => {
  it("asks for a return date and caps at the shelf", () => {
    const { onConfirm } = renderModal({ is_serialized: true });
    expect(screen.getByRole("dialog", { name: "Artikel entnehmen" })).toBeInTheDocument();
    expect(screen.getByText("Erwartete Rückgabe")).toBeInTheDocument();
    fireEvent.change(quantityField(), { target: { value: "9" } });
    expect(screen.getByRole("button", { name: /Entnahme bestätigen/ })).toBeDisabled();
    expect(screen.getByText("Nur 3 verfügbar.")).toBeInTheDocument();

    fireEvent.change(quantityField(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /Entnahme bestätigen/ }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 1, expected_return: "friday" }),
    );
  });
});

describe("dispenseNotice", () => {
  it("reads the checkout answer as the API client types it — one shape, not two", () => {
    // The desk and the phone both hand `checkoutArticle`'s answer straight in.
    // A second, hand-kept copy of that shape drifts (it once allowed a `null`
    // `booked_as` the client type does not); tsc fails this line if it does.
    expectTypeOf<DispenseResult>().toEqualTypeOf<WerkstattCheckoutResult>();
  });

  const consumed: DispenseResult = {
    id: 31,
    stock_total: 12,
    stock_available: 12,
    stock_status: "available",
    booked_as: "consumption",
    stock_warning: null,
  };

  it("says what was used up and for which project", () => {
    expect(
      dispenseNotice(
        { result: consumed, quantity: 3, itemName: "Kabelbinder", project: PROJECTS[0] },
        true,
      ),
    ).toBe("3× Kabelbinder verbraucht für 381 Neubau Schulze — 12 von 12 noch verfügbar");
  });

  it("says so when no project was chosen", () => {
    expect(
      dispenseNotice({ result: consumed, quantity: 3, itemName: "Kabelbinder", project: null }, true),
    ).toBe("3× Kabelbinder verbraucht (ohne Projekt) — 12 von 12 noch verfügbar");
  });

  it("passes the server's stock warning on", () => {
    const warning =
      "Laut Bestand waren nur 2 da – 1 nachgebucht, bitte den Bestand bei Gelegenheit zählen.";
    const text = dispenseNotice(
      {
        result: { ...consumed, stock_total: 0, stock_available: 0, stock_warning: warning },
        quantity: 3,
        itemName: "Kabelbinder",
        project: PROJECTS[0],
      },
      true,
    );
    expect(text).toBe(
      `3× Kabelbinder verbraucht für 381 Neubau Schulze — 0 von 0 noch verfügbar. ${warning}`,
    );
  });

  it("keeps the loan sentence when the server booked a loan", () => {
    expect(
      dispenseNotice(
        {
          result: { ...consumed, booked_as: "checkout", stock_available: 7 },
          quantity: 2,
          itemName: "Bohrhammer",
          project: PROJECTS[0],
        },
        true,
      ),
    ).toBe("2× Bohrhammer entnommen — 7 von 12 noch verfügbar");
  });

  it("reads an answer without `booked_as` as a loan — that is what an older API booked", () => {
    const { booked_as: _ignored, ...legacy } = consumed;
    expect(
      dispenseNotice({ result: legacy, quantity: 1, itemName: "Zange", project: null }, false),
    ).toBe("Checked out 1× Zange — 12 of 12 still available");
  });

  it("answers in English for a consumption", () => {
    expect(
      dispenseNotice(
        { result: consumed, quantity: 3, itemName: "Cable ties", project: PROJECTS[0] },
        false,
      ),
    ).toBe("3× Cable ties used for 381 Neubau Schulze — 12 of 12 still available");
  });
});

describe("dispenseProjectOptions", () => {
  it("drops archived projects, which the server refuses, and lists running jobs first", () => {
    const options = dispenseProjectOptions([
      { id: 1, project_number: "300", name: "Altbau", status: "Archiviert" },
      { id: 2, project_number: "381", name: "Neubau Schulze", status: "Angebot" },
      { id: 3, project_number: "402", name: "Umbau Kita", status: "In Durchführung" },
    ]);
    expect(options).toEqual([
      { id: "3", number: "402", title: "Umbau Kita" },
      { id: "2", number: "381", title: "Neubau Schulze" },
    ]);
  });
});
