/**
 * The Kontaktdaten card of the customer page. What must hold: the header
 * says Firma or Privatkunde and says nothing for a row from before the
 * field; Telefon and Mobil are rows of their own, each a tel: link; and
 * the Ansprechpartner row is there for a company and for an unset row,
 * never for a private person.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CustomerContactCard } from "../components/customers/CustomerContactCard";
import type { Customer } from "../types";

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 7,
    name: "Müller GmbH",
    address: "Hauptstraße 1, 12345 Musterstadt",
    contact_person: "Max Müller",
    email: "info@mueller.example",
    phone: "030 123 45",
    mobile: "0171 555 66",
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
    ...overrides,
  };
}

function rowValue(label: string): HTMLElement | null {
  const term = screen.queryByText(label, { selector: "dt" });
  return term ? (term.nextElementSibling as HTMLElement) : null;
}

describe("CustomerContactCard", () => {
  it("badges a company and lists Telefon, Mobil and the Ansprechpartner", () => {
    render(<CustomerContactCard customer={customer()} language="de" />);
    expect(screen.getByRole("heading", { level: 3, name: "Kontaktdaten" })).toBeInTheDocument();
    expect(screen.getByText("Firma")).toHaveClass("customer-type-badge--company");

    expect(rowValue("Ansprechpartner")).toHaveTextContent("Max Müller");
    expect(screen.getByRole("link", { name: "030 123 45" })).toHaveAttribute("href", "tel:03012345");
    expect(screen.getByRole("link", { name: "0171 555 66" })).toHaveAttribute("href", "tel:017155566");
    expect(rowValue("Mobil")).toHaveTextContent("0171 555 66");
  });

  it("badges a private person and drops the Ansprechpartner row", () => {
    render(<CustomerContactCard customer={customer({ customer_type: "private", name: "Erika Muster" })} language="de" />);
    expect(screen.getByText("Privatkunde")).toHaveClass("customer-type-badge--private");
    expect(rowValue("Ansprechpartner")).toBeNull();
    expect(rowValue("Telefon")).toHaveTextContent("030 123 45");
  });

  it("shows no badge for a row from before the field, keeps the Ansprechpartner, and dashes an empty Mobil", () => {
    render(<CustomerContactCard customer={customer({ customer_type: null, mobile: null })} language="de" />);
    expect(screen.queryByText("Firma")).not.toBeInTheDocument();
    expect(screen.queryByText("Privatkunde")).not.toBeInTheDocument();
    expect(rowValue("Ansprechpartner")).toHaveTextContent("Max Müller");
    expect(rowValue("Mobil")).toHaveTextContent("—");
  });
});
