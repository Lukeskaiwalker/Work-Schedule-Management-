/**
 * The customer form. What must hold: a customer is a Firma or a
 * Privatperson and the labels follow — Firmenname with an Ansprechpartner
 * for a company, just a Name for a person; a new customer has to choose,
 * and the form says so instead of saving; a row from before the field
 * opens unset, says "(nicht festgelegt)" and may be saved as it is; the
 * payload carries the type, the Mobil number and the visit block, trimmed
 * and with empties as null, and clears the Ansprechpartner of a private
 * person; and the API helper writes those fields into the request while
 * leaving the legacy notes text alone unless a caller passes it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerModal } from "../components/modals/CustomerModal";
import { saveCustomer as apiSaveCustomer } from "../utils/customersApi";
import { apiFetch } from "../api/client";
import type { CustomerListItem } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

function customer(overrides: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: 7,
    name: "Müller GmbH",
    address: null,
    contact_person: "Max Müller",
    email: null,
    phone: "030 123",
    tax_id: null,
    notes: null,
    birthday: null,
    marktakteur_nummer: null,
    customer_type: null,
    mobile: null,
    visit_summary: null,
    visit_date: null,
    visit_by_user_id: null,
    archived_at: null,
    created_by: 1,
    created_at: "2026-09-01T08:00:00",
    updated_at: "2026-09-01T08:00:00",
    project_count: 0,
    active_project_count: 0,
    last_project_activity_at: null,
    ...overrides,
  };
}

function renderModal(initial: CustomerListItem | null = null) {
  const spies = {
    saveCustomer: vi.fn(async (data: Record<string, unknown>, id?: number) => ({ ...customer(), ...data, id: id ?? 99 })),
    closeCustomerModal: vi.fn(),
    setError: vi.fn(),
  };
  const context = makeAppContextStub({
    overrides: { customerModalOpen: true, customerModalDraft: { initial }, ...spies },
  });
  render(
    <AppContext.Provider value={context as never}>
      <CustomerModal />
    </AppContext.Provider>,
  );
  return spies;
}

function radio(name: string): HTMLElement {
  return screen.getByRole("radio", { name });
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("CustomerModal — Firma / Privatperson", () => {
  it("labels a company Firmenname with an Ansprechpartner", () => {
    renderModal();
    expect(screen.getByLabelText("Kundenname *")).toBeInTheDocument();
    expect(radio("Firma")).toHaveAttribute("aria-checked", "false");
    expect(radio("Privatperson")).toHaveAttribute("aria-checked", "false");

    fireEvent.click(radio("Firma"));
    expect(radio("Firma")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Firmenname *")).toBeInTheDocument();
    expect(screen.getByLabelText("Ansprechpartner")).toBeInTheDocument();
    expect(screen.queryByText("(nicht festgelegt)")).not.toBeInTheDocument();
  });

  it("labels a private person Name and hides the Ansprechpartner", () => {
    renderModal();
    fireEvent.click(radio("Privatperson"));
    expect(radio("Privatperson")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Name *")).toBeInTheDocument();
    expect(screen.queryByLabelText("Ansprechpartner")).not.toBeInTheDocument();
    // Telefon and Mobil are both there, whatever the type.
    expect(screen.getByLabelText("Telefon")).toBeInTheDocument();
    expect(screen.getByLabelText("Mobil")).toBeInTheDocument();
  });

  it("refuses a new customer without a type and says so", async () => {
    const { saveCustomer, setError } = renderModal();
    type("Kundenname *", "Erika Muster");
    fireEvent.click(screen.getByRole("button", { name: "Kunde anlegen" }));

    await waitFor(() => expect(setError).toHaveBeenCalledWith("Bitte Firma oder Privatperson wählen"));
    expect(saveCustomer).not.toHaveBeenCalled();
  });

  it("sends the type, Mobil and the visit block, trimmed, with the Ansprechpartner cleared for a person", async () => {
    const { saveCustomer, closeCustomerModal, setError } = renderModal();
    fireEvent.click(radio("Firma"));
    type("Ansprechpartner", "Max");
    fireEvent.click(radio("Privatperson"));
    type("Name *", "  Erika Muster  ");
    type("Telefon", "030 123");
    type("Mobil", "  0171 555  ");
    type("Besuch am", "2026-09-12");
    type("Zusammenfassung des Besuchs", "  Dach prüfen, Zähler im Keller.  ");
    fireEvent.click(screen.getByRole("button", { name: "Kunde anlegen" }));

    await waitFor(() => expect(closeCustomerModal).toHaveBeenCalled());
    expect(setError).not.toHaveBeenCalled();
    const [payload, id] = saveCustomer.mock.calls[0];
    expect(id).toBeUndefined();
    expect(payload).toMatchObject({
      name: "Erika Muster",
      customer_type: "private",
      contact_person: null,
      phone: "030 123",
      mobile: "0171 555",
      visit_date: "2026-09-12",
      visit_summary: "Dach prüfen, Zähler im Keller.",
      email: null,
      birthday: null,
    });
    // The feed owns the notes now: the form never sends the legacy text.
    expect(payload).not.toHaveProperty("notes");
  });

  it("keeps a company's Ansprechpartner in the payload", async () => {
    const { saveCustomer } = renderModal();
    fireEvent.click(radio("Firma"));
    type("Firmenname *", "Müller GmbH");
    type("Ansprechpartner", " Max Müller ");
    fireEvent.click(screen.getByRole("button", { name: "Kunde anlegen" }));

    await waitFor(() => expect(saveCustomer).toHaveBeenCalled());
    expect(saveCustomer.mock.calls[0][0]).toMatchObject({ customer_type: "company", contact_person: "Max Müller" });
  });

  it("opens an old row unset, says so, and saves it without forcing a choice", async () => {
    const { saveCustomer, setError } = renderModal(customer({ customer_type: null, mobile: "0171 1" }));
    expect(screen.getByText("(nicht festgelegt)")).toBeInTheDocument();
    expect(radio("Firma")).toHaveAttribute("aria-checked", "false");
    expect(radio("Privatperson")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByLabelText("Kundenname *")).toHaveValue("Müller GmbH");
    expect(screen.getByLabelText("Ansprechpartner")).toHaveValue("Max Müller");
    expect(screen.getByLabelText("Mobil")).toHaveValue("0171 1");

    fireEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() => expect(saveCustomer).toHaveBeenCalled());
    expect(setError).not.toHaveBeenCalled();
    const [payload, id] = saveCustomer.mock.calls[0];
    expect(id).toBe(7);
    expect(payload).toMatchObject({ customer_type: null, contact_person: "Max Müller", mobile: "0171 1" });
  });

  it("opens an existing company checked, with its visit block filled", () => {
    renderModal(customer({ customer_type: "company", visit_date: "2026-09-12", visit_summary: "Dach prüfen" }));
    expect(radio("Firma")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("(nicht festgelegt)")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Besuch am")).toHaveValue("2026-09-12");
    expect(screen.getByLabelText("Zusammenfassung des Besuchs")).toHaveValue("Dach prüfen");
    expect(screen.getByText("Wird am Anfang des Projektberichts gedruckt")).toBeInTheDocument();
  });
});

describe("customersApi.saveCustomer payload", () => {
  it("writes the new fields and leaves the legacy notes out unless given", async () => {
    apiFetchMock.mockResolvedValue({} as never);
    await apiSaveCustomer(
      "t",
      { name: "Müller GmbH", customer_type: "company", mobile: "0171", visit_summary: "Dach", visit_date: "2026-09-12" },
      7,
    );
    const [path, , init] = apiFetchMock.mock.calls[0] as [string, string, { method: string; body: string }];
    expect(path).toBe("/customers/7");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      name: "Müller GmbH",
      customer_type: "company",
      mobile: "0171",
      visit_summary: "Dach",
      visit_date: "2026-09-12",
      contact_person: null,
    });
    expect(body).not.toHaveProperty("notes");

    await apiSaveCustomer("t", { name: "Neu", notes: "alter Text" });
    const [createPath, , createInit] = apiFetchMock.mock.calls[1] as [string, string, { method: string; body: string }];
    expect(createPath).toBe("/customers");
    expect(createInit.method).toBe("POST");
    expect(JSON.parse(createInit.body)).toMatchObject({ notes: "alter Text", customer_type: null, mobile: null });
  });
});
