import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { CustomerListRow } from "../components/customers/CustomerListRow";
import type { CustomerListItem } from "../types";

type ArchivedFilter = "all" | "active" | "archived";

/**
 * Top-level "Kunden" list page. Self-gates on `mainView !== "customers"` so
 * it participates in App.tsx's flat render branch without triggering effects
 * when hidden. Drives its own search + archived-filter local state and uses
 * AppContext for the customer collection and actions.
 */
export function CustomersPage() {
  const {
    mainView,
    language,
    customers,
    loadCustomers,
    openCustomer,
    openCustomerModal,
    archiveCustomer,
    unarchiveCustomer,
  } = useAppContext();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ArchivedFilter>("active");

  // Refresh the list whenever we enter the page or change filters — the
  // server query is cheap and this keeps archived toggles in sync.
  useEffect(() => {
    if (mainView !== "customers") return;
    void loadCustomers(query, filter === "archived");
  }, [mainView, filter, query, loadCustomers]);

  const visibleCustomers = useMemo<CustomerListItem[]>(() => {
    if (filter === "all") return customers;
    if (filter === "archived") return customers.filter((row) => row.archived_at);
    return customers.filter((row) => !row.archived_at);
  }, [customers, filter]);

  if (mainView !== "customers") return null;

  const de = language === "de";

  function handleArchiveToggle(customer: CustomerListItem) {
    if (customer.archived_at) {
      void unarchiveCustomer(customer.id);
    } else {
      void archiveCustomer(customer.id);
    }
  }

  function handleExport() {
    // Stub: real export will go through the backend. For now we generate a
    // CSV client-side from what's on screen so the button is functional.
    const header = [
      "id",
      "name",
      "address",
      "contact_person",
      "email",
      "phone",
      "tax_id",
    ];
    const escape = (v: string | null | undefined) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = visibleCustomers.map((row) =>
      [
        row.id,
        escape(row.name),
        escape(row.address),
        escape(row.contact_person),
        escape(row.email),
        escape(row.phone),
        escape(row.tax_id),
      ].join(","),
    );
    const csv = [header.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "kunden.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="customers-page">
      <header className="customers-page-head">
        <div className="customers-page-title-block">
          <span className="customers-page-eyebrow">
            {de ? "STAMMDATEN" : "MASTER DATA"}
          </span>
          <h2 className="customers-page-title">
            {de ? "Kunden" : "Customers"}
          </h2>
        </div>
        <div className="customers-page-actions">
          <button
            type="button"
            className="customers-action-btn"
            onClick={handleExport}
          >
            {de ? "Exportieren" : "Export"}
          </button>
          <button
            type="button"
            className="customers-action-btn customers-action-btn--primary"
            onClick={() => openCustomerModal({})}
          >
            + {de ? "Neuer Kunde" : "New customer"}
          </button>
        </div>
      </header>

      <div className="customers-page-toolbar">
        <div className="customers-search-wrap">
          <svg
            className="customers-search-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path
              d="m15.6 15.6 4 4"
              stroke="#5C7895"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="search"
            className="customers-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              de
                ? "Name, Adresse, E-Mail durchsuchen…"
                : "Search by name, address, email…"
            }
          />
        </div>
        <div
          className="customers-filter-segmented"
          role="group"
          aria-label={de ? "Kundenfilter" : "Customer filter"}
        >
          {(
            [
              { key: "all", labelDe: "Alle", labelEn: "All" },
              { key: "active", labelDe: "Aktiv", labelEn: "Active" },
              { key: "archived", labelDe: "Archiviert", labelEn: "Archived" },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              className={
                filter === option.key
                  ? "customers-filter-segmented-btn customers-filter-segmented-btn--active"
                  : "customers-filter-segmented-btn"
              }
              onClick={() => setFilter(option.key)}
              aria-pressed={filter === option.key}
            >
              {de ? option.labelDe : option.labelEn}
            </button>
          ))}
        </div>
      </div>

      {visibleCustomers.length === 0 ? (
        <div className="customers-empty muted">
          {query
            ? de
              ? `Keine Kunden für "${query}" gefunden.`
              : `No customers found for "${query}".`
            : de
              ? "Noch keine Kunden angelegt."
              : "No customers yet."}
        </div>
      ) : (
        <div className="customers-table-wrap">
          <table className="customers-table">
            <thead>
              <tr>
                <th className="customer-list-th customer-list-th--name">
                  {de ? "Name" : "Name"}
                </th>
                <th className="customer-list-th customer-list-th--address">
                  {de ? "Adresse" : "Address"}
                </th>
                <th className="customer-list-th customer-list-th--contact">
                  {de ? "Kontakt" : "Contact"}
                </th>
                <th className="customer-list-th customer-list-th--projects">
                  {de ? "Projekte" : "Projects"}
                </th>
                <th className="customer-list-th customer-list-th--activity">
                  {de ? "Letzte Aktivität" : "Last activity"}
                </th>
                <th className="customer-list-th customer-list-th--actions">
                  <span className="visually-hidden">
                    {de ? "Aktionen" : "Actions"}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleCustomers.map((customer) => (
                <CustomerListRow
                  key={`customer-row-${customer.id}`}
                  customer={customer}
                  language={language === "de" ? "de" : "en"}
                  onOpen={(id) => openCustomer(id)}
                  onEdit={(c) => openCustomerModal({ initial: c })}
                  onArchiveToggle={handleArchiveToggle}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
