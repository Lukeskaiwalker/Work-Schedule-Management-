import { useEffect, useMemo, useRef, useState } from "react";
import type { CustomerListItem } from "../../types";

export type CustomerComboboxValue = {
  customerId: number | null;
  /** Free-text fallback for legacy drafts (pre-migration projects). */
  customerName: string;
};

type Props = {
  language: "de" | "en";
  customers: CustomerListItem[];
  value: CustomerComboboxValue;
  onChange: (next: CustomerComboboxValue) => void;
  /** Invoked when the user picks "+ Neuen Kunden anlegen" with the current query. */
  onRequestCreate: (prefillName: string) => void;
  disabled?: boolean;
  /** Shown below the input when no customer is picked. */
  placeholder?: string;
};

/**
 * Searchable customer combobox. Shows matching existing customers in a
 * dropdown with keyboard navigation (↑/↓/Enter/Escape). When there's no
 * exact-name match, adds a "+ Neuen Kunden anlegen: »{query}«" action row
 * at the bottom that fires `onRequestCreate` with the current text.
 *
 * Intentionally free of any global context — it's driven entirely by props
 * so it can render both inside ProjectModal and wherever else we need it.
 */
export function CustomerCombobox({
  language,
  customers,
  value,
  onChange,
  onRequestCreate,
  disabled,
  placeholder,
}: Props) {
  const de = language === "de";
  const selectedCustomer = useMemo<CustomerListItem | null>(
    () =>
      value.customerId
        ? (customers.find((row) => row.id === value.customerId) ?? null)
        : null,
    [value.customerId, customers],
  );

  const [query, setQuery] = useState<string>(
    selectedCustomer?.name ?? value.customerName ?? "",
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keep the displayed text in sync when the parent swaps the selection
  // (e.g. after an inline-create returns the freshly-made customer).
  useEffect(() => {
    if (selectedCustomer) {
      setQuery(selectedCustomer.name);
      setOpen(false);
      return;
    }
    // Legacy free-text fallback: when a draft carries only `customer_name`
    // from a pre-feature project, render it as-is so the user sees what
    // the backend has today.
    if (value.customerName && value.customerName !== query) {
      setQuery(value.customerName);
    }
  }, [selectedCustomer, value.customerName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Click-outside closes the dropdown.
  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!containerRef.current) return;
      if (containerRef.current.contains(event.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const trimmed = query.trim();
  const lowerQuery = trimmed.toLowerCase();
  const matches = useMemo(() => {
    if (!lowerQuery) return customers.slice(0, 8);
    return customers
      .filter((row) => {
        const hay = `${row.name} ${row.address ?? ""} ${row.email ?? ""} ${row.contact_person ?? ""}`.toLowerCase();
        return hay.includes(lowerQuery);
      })
      .slice(0, 8);
  }, [customers, lowerQuery]);

  const exactMatch = useMemo(
    () => matches.find((row) => row.name.toLowerCase() === lowerQuery),
    [matches, lowerQuery],
  );
  const showCreateAction = trimmed.length > 0 && !exactMatch;
  // Final dropdown rows = matches + optional create action. We track the
  // active index against this combined list for keyboard nav.
  const rowCount = matches.length + (showCreateAction ? 1 : 0);

  function selectCustomer(row: CustomerListItem) {
    onChange({ customerId: row.id, customerName: row.name });
    setQuery(row.name);
    setOpen(false);
    setActiveIndex(0);
  }

  function clearSelection() {
    onChange({ customerId: null, customerName: "" });
    setQuery("");
    setOpen(true);
    setActiveIndex(0);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
      setOpen(true);
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((i) => (rowCount === 0 ? 0 : (i + 1) % rowCount));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((i) => (rowCount === 0 ? 0 : (i - 1 + rowCount) % rowCount));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex < matches.length) {
        const row = matches[activeIndex];
        if (row) selectCustomer(row);
        return;
      }
      if (showCreateAction) {
        onRequestCreate(trimmed);
        setOpen(false);
      }
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="customer-combobox" ref={containerRef}>
      <div className="customer-combobox-input-wrap">
        <input
          type="text"
          className="customer-combobox-input"
          value={query}
          disabled={disabled}
          placeholder={
            placeholder ??
            (de ? "Kunde suchen oder anlegen…" : "Search or create customer…")
          }
          onFocus={() => {
            setOpen(true);
            setActiveIndex(0);
          }}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            setOpen(true);
            setActiveIndex(0);
            // Break link to id when the user actively types — keep the text
            // as legacy `customer_name` until they pick from the dropdown.
            if (value.customerId !== null) {
              onChange({ customerId: null, customerName: next });
            } else {
              onChange({ customerId: null, customerName: next });
            }
          }}
          onKeyDown={handleKeyDown}
          aria-expanded={open}
          aria-autocomplete="list"
          role="combobox"
        />
        {selectedCustomer && (
          <button
            type="button"
            className="customer-combobox-clear-btn"
            onClick={clearSelection}
            aria-label={de ? "Kunde entfernen" : "Remove customer"}
            title={de ? "Kunde entfernen" : "Remove customer"}
            disabled={disabled}
          >
            ✕
          </button>
        )}
      </div>

      {open && !disabled && (rowCount > 0 || lowerQuery.length === 0) && (
        <ul className="customer-combobox-dropdown" role="listbox">
          {matches.length === 0 && !showCreateAction && (
            <li className="customer-combobox-empty muted">
              {de ? "Keine Kunden gefunden." : "No customers found."}
            </li>
          )}
          {matches.map((row, index) => {
            const isActive = index === activeIndex;
            return (
              <li
                key={`customer-match-${row.id}`}
                className={
                  isActive
                    ? "customer-combobox-option customer-combobox-option--active"
                    : "customer-combobox-option"
                }
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectCustomer(row);
                }}
              >
                <span className="customer-combobox-option-name">{row.name}</span>
                {row.address && (
                  <span className="customer-combobox-option-meta">
                    {row.address}
                  </span>
                )}
                <span className="customer-combobox-option-count">
                  {row.active_project_count > 0 ? (
                    <>
                      {row.active_project_count}{" "}
                      {de ? "aktiv" : "active"}
                    </>
                  ) : (
                    <span className="muted">
                      {de ? "keine Projekte" : "no projects"}
                    </span>
                  )}
                </span>
              </li>
            );
          })}

          {showCreateAction && (
            <>
              {matches.length > 0 && (
                <li className="customer-combobox-divider" aria-hidden="true" />
              )}
              <li
                className={
                  activeIndex === matches.length
                    ? "customer-combobox-create customer-combobox-create--active"
                    : "customer-combobox-create"
                }
                role="option"
                aria-selected={activeIndex === matches.length}
                onMouseEnter={() => setActiveIndex(matches.length)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onRequestCreate(trimmed);
                  setOpen(false);
                }}
              >
                <span className="customer-combobox-create-icon" aria-hidden="true">
                  +
                </span>
                <span>
                  {de ? "Neuen Kunden anlegen" : "Create new customer"}:{" "}
                  <b>«{trimmed}»</b>
                </span>
              </li>
            </>
          )}
        </ul>
      )}
    </div>
  );
}
