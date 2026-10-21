import { useEffect, useMemo, useRef, useState } from "react";
import type { CustomerListItem } from "../../types";
import { isSameCustomerName } from "../../utils/customerRows";
import { fuzzyFilterCustomers } from "../../utils/fuzzyMatch";
import { useRemoteCustomerSearch } from "./useRemoteCustomerSearch";
// Only the leading-group rules; the combobox itself is styled in styles.css.
import "../../styles/customer-combobox-leading.css";

export {
  CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS,
  CUSTOMER_REMOTE_SEARCH_MIN_LENGTH,
} from "./useRemoteCustomerSearch";

/** Customers the server check may add to the local matches: an exact name above them, the rest below. */
const MAX_REMOTE_EXTRAS = 8;
const NO_ROWS: CustomerListItem[] = [];

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
  /** The list to filter locally — the complete active list (AppContext `customers`). */
  customers: CustomerListItem[];
  /**
   * The selection. `customerId` set and absent from `customers` (created
   * elsewhere since the list loaded, or a stale row) still shows
   * `customerName` and the clear button, so pass the name you know — e.g. a
   * box's or project's `customer_name` — rather than "".
   */
  value: CustomerComboboxValue;
  /**
   * Every change. Typing sends `{ customerId: null, customerName: text }`;
   * picking a row sends its id and name plus the row itself as `picked`, which
   * matters for a row the server check found: it is not in `customers`, so a
   * `customers.find(id)` would come back empty.
   */
  onChange: (next: CustomerComboboxValue, picked?: CustomerListItem) => void;
  /**
   * Invoked when the user picks "+ Neuen Kunden anlegen" with the current
   * query. Absent = no create row at all (Kisten, Baustellenbericht: those
   * forms cannot create a customer, and a row that did nothing was a dead end).
   */
  onRequestCreate?: (prefillName: string) => void;
  /**
   * Server search (AppContext `searchCustomers`). With it, a query of 2+
   * characters is also checked on the server after a 250 ms pause; customers
   * the local list lacks are added to its matches (one of exactly the typed
   * name first, the others below), and the create row is
   * offered only once the server has answered without an exact name match —
   * the duplicate guard. Wire it into every mount that can create customers.
   */
  searchRemote?: (query: string) => Promise<CustomerListItem[]>;
  disabled?: boolean;
  /** Shown below the input when no customer is picked. */
  placeholder?: string;
  /** Rows shown before the customers while nothing is typed. Absent = the plain customer list. */
  leadingItems?: CustomerComboboxLeadingItems;
};

/**
 * Searchable customer combobox. Shows matching existing customers in a
 * dropdown with keyboard navigation (↑/↓/Enter/Escape). When there's no
 * exact-name match (locally, and on the server when `searchRemote` is given),
 * adds a "+ Neuen Kunden anlegen: »{query}«" action row at the bottom that
 * fires `onRequestCreate` with the current text — only if that prop is set.
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
  searchRemote,
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
  // The selection the sync below last saw, to tell "the parent took it away"
  // from "nothing was ever picked" (both arrive as an empty value).
  const lastCustomerId = useRef(value.customerId);

  // Keep the displayed text in sync when the parent swaps the selection
  // (e.g. after an inline-create returns the freshly-made customer).
  useEffect(() => {
    const hadCustomer = lastCustomerId.current != null;
    lastCustomerId.current = value.customerId;
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
      return;
    }
    // The parent cleared a selection — the Kisten card after "Erneut öffnen",
    // whose server frees the crate. The name has to go with it: left in the
    // field it reads as still chosen, with no ✕ and a dead button behind it.
    // Typing cannot trip it: it sends its text along, and a field emptied by
    // hand is empty already.
    if (hadCustomer && value.customerId == null && !value.customerName) {
      setQuery("");
    }
  }, [selectedCustomer, value.customerId, value.customerName]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Kept strict (exact name equality against the FULL list, not the fuzzy
  // matches) so the "+ create new customer" action still appears for a
  // near-but-not-exact name and is suppressed only for a true exact match.
  const localExact = useMemo(
    () => customers.find((row) => isSameCustomerName(row.name, trimmed)),
    [customers, trimmed],
  );
  // A name the list already holds needs no server check: nothing would be
  // created either way (this is also every focus of an already-picked field).
  const remote = useRemoteCustomerSearch(searchRemote, trimmed, open && !disabled && !localExact);
  // Typo-tolerant, word-order-independent ranking so a slightly-misspelled or
  // partial query still surfaces the customer (e.g. "Schmit" → "Schmidt").
  const localMatches = useMemo(() => {
    if (!trimmed) return customers.slice(0, 8);
    return fuzzyFilterCustomers(customers, trimmed, 8);
  }, [customers, trimmed]);
  // Server hits are added only when the local list does not hold them at all:
  // a held customer is the fuzzy ranking's business, and adding every server
  // substring hit would double the dropdown for a complete list.
  const remoteRows = remote.status === "done" ? remote.rows : NO_ROWS;
  const matches = useMemo(() => {
    if (remoteRows.length === 0) return localMatches;
    const held = new Set(customers.map((row) => row.id));
    const missing = remoteRows.filter((row) => !held.has(row.id));
    // The exact name leads, above the local ranking: Enter on a fully typed
    // name must pick that customer, not a near miss the list happens to hold
    // ("Mustermann, Erika-Sophie" for "Mustermann, Erika"). Other server hits
    // go below — the local ranking is typo-tolerant, the server's is not.
    const exact = missing.filter((row) => isSameCustomerName(row.name, trimmed)).slice(0, MAX_REMOTE_EXTRAS);
    const others = missing
      .filter((row) => !isSameCustomerName(row.name, trimmed))
      .slice(0, MAX_REMOTE_EXTRAS - exact.length);
    return [...exact, ...localMatches, ...others];
  }, [localMatches, remoteRows, customers, trimmed]);

  // The same strict test over the server's answer: a customer created in
  // another browser since the list loaded counts as existing too.
  const exactMatch = useMemo(
    () => localExact ?? remoteRows.find((row) => isSameCustomerName(row.name, trimmed)),
    [localExact, remoteRows, trimmed],
  );
  // With a server check, nothing is offered for creation until the server has
  // answered for exactly this text: that is the duplicate guard.
  const serverAgrees = searchRemote === undefined || remote.status === "done";
  const showCreateAction = onRequestCreate !== undefined && trimmed.length > 0 && !exactMatch && serverAgrees;
  // Said out loud where it changes what the user can do: it holds back the
  // create row, or nothing has matched yet.
  const speaksUp = onRequestCreate !== undefined || matches.length === 0;
  const checking = remote.status === "pending" && !exactMatch && speaksUp;
  // A failed check is said as such, never as "Keine Kunden gefunden.": an
  // empty answer that was really an error is how a customer who exists came
  // to look like one who does not.
  const checkFailed = remote.status === "failed" && !exactMatch && speaksUp;
  // Leading rows exist only before anything is typed: once the user searches,
  // they are searching customers.
  const leading = trimmed.length === 0 && leadingItems ? leadingItems.items : [];
  const leadingCount = leading.length;
  // Final dropdown rows = leading + matches + optional create action. We
  // track the active index against this combined list for keyboard nav.
  const createIndex = leadingCount + matches.length;
  const rowCount = createIndex + (showCreateAction ? 1 : 0);

  function selectCustomer(row: CustomerListItem) {
    onChange({ customerId: row.id, customerName: row.name }, row);
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
      if (showCreateAction && onRequestCreate) {
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
            (onRequestCreate
              ? de
                ? "Kunde suchen oder anlegen…"
                : "Search or create customer…"
              : de
                ? "Kunde suchen…"
                : "Search customer…")
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
            onChange({ customerId: null, customerName: next });
          }}
          onKeyDown={handleKeyDown}
          aria-expanded={open}
          aria-autocomplete="list"
          role="combobox"
        />
        {/* By id, not by list lookup: a picked customer the list does not
            hold must still be removable. */}
        {value.customerId != null && (
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

      {open && !disabled && (
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

          {matches.length === 0 && !showCreateAction && !checking && !checkFailed && (
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

          {checking && (
            <li className="customer-combobox-empty muted" aria-live="polite">
              {de ? "Kundenstamm wird durchsucht…" : "Searching all customers…"}
            </li>
          )}
          {checkFailed && (
            <li className="customer-combobox-empty muted" aria-live="polite">
              {onRequestCreate
                ? de
                  ? "Kundenstamm konnte nicht geprüft werden – neuer Kunde erst nach erfolgreicher Prüfung."
                  : "Could not check the customer records – a new customer can be created once the check succeeds."
                : de
                  ? "Kundenstamm konnte nicht durchsucht werden."
                  : "Could not search the customer records."}
            </li>
          )}
          {showCreateAction && onRequestCreate && (
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
