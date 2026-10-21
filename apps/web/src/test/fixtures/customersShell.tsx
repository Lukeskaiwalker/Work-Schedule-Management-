/**
 * App in miniature for the Kunden page.
 *
 * The page's search text, archive filter and last answer live in App
 * (`useCustomersPageMemory`), like the project list's search, so a test that
 * gave the page a fixed context could not even type into it. This shell holds
 * that memory the way App does and swaps the page out the way App's main view
 * does: opening a customer unmounts the page, "Zurück zu Kunden" mounts it
 * again, and a signed-out user (`userId: null`) sees no page at all.
 */
import { useState } from "react";

import { AppContext } from "../../context/AppContext";
import { useCustomersPageMemory } from "../../hooks/useCustomersPageMemory";
import { CustomersPage } from "../../pages/CustomersPage";
import type { CustomerListItem } from "../../types";
import { makeAppContextStub } from "../appContextStub";

export const SEARCH_PLACEHOLDER = "Name, Adresse, E-Mail, Telefon durchsuchen…";
export const BACK_TO_CUSTOMERS = "Zurück zu Kunden";

const NO_CUSTOMERS: CustomerListItem[] = [];

export interface CustomersShellProps {
  /** The signed-in user; null is the login screen. */
  userId?: number | null;
  /** The shared directory list — the page's refresh trigger. */
  customers?: CustomerListItem[];
  /** Extra context members (spies), applied under the memory. */
  overrides?: Record<string, unknown>;
}

export function CustomersShell({ userId = 1, customers = NO_CUSTOMERS, overrides = {} }: CustomersShellProps) {
  const memory = useCustomersPageMemory(userId);
  const [view, setView] = useState<"customers" | "customer_detail">("customers");

  if (userId === null) return <p>Anmeldung</p>;

  const value = makeAppContextStub({
    overrides: {
      mainView: view,
      language: "de",
      token: "t",
      customers,
      openCustomer: () => setView("customer_detail"),
      ...overrides,
      ...memory,
    },
  });
  return (
    <AppContext.Provider value={value as never}>
      {view === "customers" ? (
        <CustomersPage />
      ) : (
        <button type="button" onClick={() => setView("customers")}>
          {BACK_TO_CUSTOMERS}
        </button>
      )}
    </AppContext.Provider>
  );
}

export function tableRows(): Element[] {
  return Array.from(document.querySelectorAll(".customers-table tbody tr"));
}

/** The names in the table, top to bottom. */
export function rowNames(): string[] {
  return Array.from(document.querySelectorAll(".customers-table tbody .customer-list-name")).map(
    (node) => node.textContent ?? "",
  );
}
