/**
 * The "Kundenbesuch" card of the customer page. What must hold: without a
 * visit the card says what belongs here and offers to record one; with one
 * it shows the summary as typed under "Besuch am <date> · <who went>", the
 * name left out when the lookup has none; Bearbeiten opens the form seeded
 * with the saved values and Abbrechen closes it without a request; Speichern
 * PATCHes only the visit block, hands the answer back to the page and says
 * "Kundenbesuch gespeichert"; a failed save keeps the form open.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { CustomerVisitCard } from "../components/customers/CustomerVisitCard";
import { apiFetch } from "../api/client";
import type { CustomerListItem } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

const TOKEN = "test-token";
const EMPTY_TEXT =
  "Noch kein Besuch erfasst — was der erste Termin ergeben hat, gehört hierher. Wird am Anfang des Projektberichts gedruckt.";

function customer(overrides: Partial<CustomerListItem> = {}): CustomerListItem {
  return {
    id: 7,
    name: "Müller GmbH",
    address: null,
    contact_person: null,
    email: null,
    phone: null,
    mobile: null,
    tax_id: null,
    notes: null,
    birthday: null,
    marktakteur_nummer: null,
    customer_type: "company",
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

const VISITED = customer({
  visit_summary: "Dach prüfen.\nZähler im Keller.",
  visit_date: "2026-09-12",
  visit_by_user_id: 3,
});

function renderCard(row: CustomerListItem, overrides: Record<string, unknown> = {}) {
  const spies = { onSaved: vi.fn(), setNotice: vi.fn(), setError: vi.fn() };
  const context = makeAppContextStub({
    overrides: {
      menuUserNameById: (id: number) => (id === 3 ? "Anna" : `#${id}`),
      setNotice: spies.setNotice,
      setError: spies.setError,
      ...overrides,
    },
  });
  render(
    <AppContext.Provider value={context as never}>
      <CustomerVisitCard customer={row} language="de" onSaved={spies.onSaved} />
    </AppContext.Provider>,
  );
  return spies;
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("CustomerVisitCard", () => {
  it("says what belongs here when nothing is recorded, and records a visit with one PATCH", async () => {
    const saved = customer({ visit_summary: "Dach prüfen", visit_date: "2026-09-12", visit_by_user_id: 3 });
    apiFetchMock.mockResolvedValueOnce(saved as never);
    const { onSaved, setNotice, setError } = renderCard(customer());

    expect(screen.getByRole("heading", { level: 3, name: "Kundenbesuch" })).toBeInTheDocument();
    expect(screen.getByText(EMPTY_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bearbeiten" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Besuch erfassen" }));
    fireEvent.change(screen.getByLabelText(/Besuch am/), { target: { value: "2026-09-12" } });
    fireEvent.change(screen.getByLabelText(/Zusammenfassung des Besuchs/), { target: { value: "  Dach prüfen  " } });
    expect(screen.getByText("Wird am Anfang des Projektberichts gedruckt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7", TOKEN, {
      method: "PATCH",
      body: JSON.stringify({ visit_summary: "Dach prüfen", visit_date: "2026-09-12" }),
    });
    expect(setNotice).toHaveBeenCalledWith("Kundenbesuch gespeichert");
    expect(setError).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Zusammenfassung des Besuchs/)).not.toBeInTheDocument();
  });

  it("shows the summary as typed under the date and the name of who went", () => {
    renderCard(VISITED);
    expect(screen.getByText("Besuch am 12.09.2026 · Anna")).toBeInTheDocument();
    expect(screen.getByText(/Dach prüfen/).textContent).toBe(VISITED.visit_summary);
    expect(screen.queryByText(EMPTY_TEXT)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bearbeiten" })).toBeInTheDocument();
  });

  it("leaves the name out when the lookup has none for the user", () => {
    renderCard(customer({ ...VISITED, visit_by_user_id: 9 }));
    expect(screen.getByText("Besuch am 12.09.2026")).toBeInTheDocument();
  });

  it("opens the form seeded with the saved values and closes it on Abbrechen without a request", () => {
    renderCard(VISITED);
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    expect(screen.getByLabelText(/Besuch am/)).toHaveValue("2026-09-12");
    expect(screen.getByLabelText(/Zusammenfassung des Besuchs/)).toHaveValue(VISITED.visit_summary);

    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Besuch am 12.09.2026 · Anna")).toBeInTheDocument();
  });

  it("clears the visit with nulls and keeps the form open when the save fails", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("Nicht erreichbar"));
    const { onSaved, setError } = renderCard(VISITED);
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
    fireEvent.change(screen.getByLabelText(/Besuch am/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/Zusammenfassung des Besuchs/), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(setError).toHaveBeenCalledWith("Nicht erreichbar"));
    expect(apiFetchMock).toHaveBeenCalledWith("/customers/7", TOKEN, {
      method: "PATCH",
      body: JSON.stringify({ visit_summary: null, visit_date: null }),
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Zusammenfassung des Besuchs/)).toBeInTheDocument();
  });
});
