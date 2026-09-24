import { useEffect, useMemo, useRef, useState } from "react";
import type { CustomerListItem } from "../../types";
import { fuzzyFilterCustomers } from "../../utils/fuzzyMatch";
// Only the leading-group rules; the combobox itself is styled in styles.css.
import "../../styles/customer-combobox-leading.css";

export type CustomerComboboxValue = {
  customerId: number | null;
  /** Free-text fallback for legacy drafts (pre-migration projects). */
  customerName: string;
};

export type CustomerComboboxLeadingItem = {
  id: string;
  primary: string;
  secondary?: string;
  /** A tiny right-aligned chip, e.g. "vor 2 Std.". */
  hint?: string;
};

/**
 * A group of rows shown ABOVE the customers while the query is empty — the
 * Schaltplan page's "Zuletzt bearbeitet" panels. Picking one is the caller's
 * business (`onPick` with the item's id); the combobox only closes.
 */
export type CustomerComboboxLeadingItems = {
  title: string;
  items: CustomerComboboxLeadingItem[];
  onPick: (id: string) => void;
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
  /** Rows shown before the customers while nothing is typed. Absent = the plain customer list. */
  leadingItems?: CustomerComboboxLeadingItems;
};

/**
 * Searchable customer combobox. Shows matching existing customers in a
 * dropdown with keyboard navigation (↑/↓/Enter/Escape). When there's no
 * exact-name match, adds a "+ Neuen Kunden anlegen: »{query}«" action row
 * at the bottom that fires `onRequestCreate` with the current text.
 *
 * Intentionally free of any global context — it's driven entirely by props
 * so it can render both inside ProjectModal and wherever else we need it.
 *
 * Keyboard rows are one list: leading items (empty query only), then the
 * customer matches, then the create action; `activeIndex` spans all three.
 */
export function CustomerCombobox({
  language,
  customers,
  value,
  onChange,
  onRequestCreate,
  disabled,
  placeholder,
  leadingItems,
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
  // Typo-tolerant, word-order-independent ranking so a slightly-misspelled or
  // partial query still surfaces the customer (e.g. "Schmit" → "Schmidt").
  const matches = useMemo(() => {
    if (!trimmed) return customers.slice(0, 8);
    return fuzzyFilterCustomers(customers, trimmed, 8);
  }, [customers, trimmed]);

  // Kept strict (exact name equality against the FULL list, not the fuzzy
  // matches) so the "+ create new customer" action still appears for a
  // near-but-not-exact name and is suppressed only for a true exact match.
  const exactMatch = useMemo(
    () => customers.find((row) => row.name.trim().toLowerCase() === lowerQuery),
    [customers, lowerQuery],
  );
  const showCreateAction = trimmed.length > 0 && !exactMatch;
  // Leading rows exist only before anything is typed: once the user searches,
  // they are searching customers.
  const leading = trimmed.length === 0 && leadingItems ? leadingItems.items : [];
  const leadingCount = leading.length;
  // Final dropdown rows = leading + matches + optional create action. We
  // track the active index against this combined list for keyboard nav.
  const createIndex = leadingCount + matches.length;
  const rowCount = createIndex + (showCreateAction ? 1 : 0);

  function selectCustomer(row: CustomerListItem) {
    onChange({ customerId: row.id, customerName: row.name });
    setQuery(row.name);
    setOpen(false);
    setActiveIndex(0);
  }

  function pickLeading(item: CustomerComboboxLeadingItem) {
    leadingItems?.onPick(item.id);
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
      if (activeIndex < leadingCount) {
        const item = leading[activeIndex];
        if (item) pickLeading(item);
        return;
      }
      if (activeIndex < createIndex) {
        const row = matches[activeIndex - leadingCount];
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
          {leadingCount > 0 && leadingItems && (
            <>
              <li className="customer-combobox-group" role="presentation">
                {leadingItems.title}
              </li>
              {leading.map((item, index) => {
                const isActive = index === activeIndex;
                return (
                  <li
                    key={`leading-${item.id}`}
                    className={
                      isActive
                        ? "customer-combobox-option customer-combobox-lead customer-combobox-option--active"
                        : "customer-combobox-option customer-combobox-lead"
                    }
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pickLeading(item);
                    }}
                  >
                    <span className="customer-combobox-option-name">{item.primary}</span>
                    {item.secondary && (
                      <span className="customer-combobox-option-meta">{item.secondary}</span>
                    )}
                    {item.hint && <span className="customer-combobox-lead-hint">{item.hint}</span>}
                  </li>
                );
              })}
              <li className="customer-combobox-group" role="presentation">
                {de ? "Kunden" : "Customers"}
              </li>
            </>
          )}

          {matches.length === 0 && !showCreateAction && (
            <li className="customer-combobox-empty muted">
              {de ? "Keine Kunden gefunden." : "No customers found."}
            </li>
          )}
          {matches.map((row, index) => {
            const rowIndex = leadingCount + index;
            const isActive = rowIndex === activeIndex;
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
                onMouseEnter={() => setActiveIndex(rowIndex)}
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
                  activeIndex === createIndex
                    ? "customer-combobox-create customer-combobox-create--active"
                    : "customer-combobox-create"
                }
                role="option"
                aria-selected={activeIndex === createIndex}
                onMouseEnter={() => setActiveIndex(createIndex)}
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
