/**
 * The two ordering settings on a supplier.
 *
 * `order_channel` decides which hand-over the drawer offers; `order_identifier`
 * decides what the cart or export carries per line. Both are saved from the
 * supplier form, and both must survive a round trip through the form state —
 * a form that silently reset "both" to the default would flip Unielektro's
 * cart shape on the next unrelated edit.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import {
  formStateFromSupplier,
  payloadFromForm,
} from "../components/werkstatt/LieferantFormModal";
import { WerkstattLieferantenPage } from "../pages/werkstatt/WerkstattLieferantenPage";
import type { WerkstattSupplier } from "../types/werkstatt";

const SONEPAR: WerkstattSupplier = {
  id: 3,
  name: "Sonepar",
  short_name: null,
  email: null,
  order_email: null,
  phone: null,
  contact_person: null,
  address_street: null,
  address_zip: null,
  address_city: null,
  address_country: null,
  default_lead_time_days: 2,
  notes: null,
  order_identifier: "both",
  order_channel: "ids",
  is_archived: false,
  article_count: 0,
  last_order_at: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

describe("supplier form — Bestellweg and Übertragene Artikelnummer", () => {
  it("round-trips both settings through the form state", () => {
    const form = formStateFromSupplier(SONEPAR);
    expect(form.order_identifier).toBe("both");
    expect(form.order_channel).toBe("ids");
    const payload = payloadFromForm(form);
    expect(payload.order_identifier).toBe("both");
    expect(payload.order_channel).toBe("ids");
  });

  it("defaults a new supplier to the supplier number only, manual channel", () => {
    const form = formStateFromSupplier({
      ...SONEPAR,
      // A row from before the columns existed carries neither.
      order_identifier: undefined as unknown as WerkstattSupplier["order_identifier"],
      order_channel: undefined as unknown as WerkstattSupplier["order_channel"],
    });
    expect(form.order_identifier).toBe("supplier_no");
    expect(form.order_channel).toBe("manual");
  });

  it("saves the two selects with the PATCH", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ method, url, body });
        const payload =
          method === "PATCH" ? { ...SONEPAR, ...(body as object) } : [SONEPAR];
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const context = makeAppContextStub({
      overrides: {
        mainView: "werkstatt",
        werkstattTab: "lieferanten",
        user: {
          id: 1,
          email: "test@example.com",
          role: "admin",
          display_name: "Test",
          effective_permissions: ["werkstatt:manage"],
        },
      },
    });
    render(
      <AppContext.Provider value={context as never}>
        <WerkstattLieferantenPage />
      </AppContext.Provider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Mehr Aktionen" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bearbeiten" }));

    const identifier = screen.getByLabelText(/Übertragene Artikelnummer/) as HTMLSelectElement;
    expect(identifier.value).toBe("both");
    fireEvent.change(identifier, { target: { value: "supplier_no" } });
    fireEvent.change(screen.getByLabelText(/Bestellweg/), { target: { value: "manual" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toMatch(/\/werkstatt\/suppliers\/3$/);
    expect(patch?.body).toMatchObject({
      name: "Sonepar",
      order_identifier: "supplier_no",
      order_channel: "manual",
    });
  });
});
