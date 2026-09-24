/**
 * The customer page's sub-menu: Übersicht · Aufgaben · Berichte & Kisten ·
 * Dateien · Zugangsdaten · Änderungen.
 *
 * The page grew one card at a time until "Dateien" sat below everything a
 * customer with a few projects produces, and reaching it meant scrolling
 * past all of it. The project page answers the same problem with the tabs
 * under its banner; this is the customer page's version of that — the same
 * idea, in the light look the page already uses for its Aktiv/Abgeschlossen/
 * Archiviert switch rather than the banner's dark one.
 *
 * The strip only knows which tab is chosen and says when that changes. The
 * page mounts the chosen panel and nothing else, so a closed tab costs no
 * requests. The choice is kept per browser session so a trip to a project
 * and back — or a reload — lands where the reader left off, and a fresh
 * session starts on Übersicht.
 */
import type { KeyboardEvent, ReactNode } from "react";

export type CustomerDetailTab = "overview" | "tasks" | "reports" | "files" | "credentials" | "activity";

/**
 * In strip order. "reports" pairs the reports with the boxes: both are what
 * came back from the site. "credentials" is the plant's logins — read on a
 * service call, next to the files the call needs.
 */
export const CUSTOMER_DETAIL_TABS: readonly CustomerDetailTab[] = [
  "overview",
  "tasks",
  "reports",
  "files",
  "credentials",
  "activity",
];

export const DEFAULT_CUSTOMER_DETAIL_TAB: CustomerDetailTab = "overview";

/**
 * sessionStorage, not localStorage: the tab is where the reader is in this
 * sitting, not a preference. Tomorrow's first look at a customer should be
 * the overview again.
 */
export const CUSTOMER_TAB_STORAGE_KEY = "smpl_customer_tab";

export function isCustomerDetailTab(value: unknown): value is CustomerDetailTab {
  return typeof value === "string" && (CUSTOMER_DETAIL_TABS as readonly string[]).includes(value);
}

/**
 * The remembered tab — or Übersicht when nothing is remembered, the value is
 * not a tab this build knows, or storage is unavailable (private mode, a
 * blocked origin). None of those is worth telling the reader about.
 */
export function readStoredCustomerTab(): CustomerDetailTab {
  try {
    const stored = window.sessionStorage.getItem(CUSTOMER_TAB_STORAGE_KEY);
    return isCustomerDetailTab(stored) ? stored : DEFAULT_CUSTOMER_DETAIL_TAB;
  } catch {
    return DEFAULT_CUSTOMER_DETAIL_TAB;
  }
}

/** Remember the tab for this session. Storage that refuses is not an error: the tab still switches. */
export function storeCustomerTab(tab: CustomerDetailTab): void {
  try {
    window.sessionStorage.setItem(CUSTOMER_TAB_STORAGE_KEY, tab);
  } catch {
    // The choice lives on in state; only the memory across a reload is lost.
  }
}

export function customerDetailTabLabel(tab: CustomerDetailTab, language: "de" | "en"): string {
  const de = language === "de";
  switch (tab) {
    case "overview":
      return de ? "Übersicht" : "Overview";
    case "tasks":
      return de ? "Aufgaben" : "Tasks";
    case "reports":
      return de ? "Berichte & Kisten" : "Reports & boxes";
    case "files":
      return de ? "Dateien" : "Files";
    case "credentials":
      return de ? "Zugangsdaten" : "Credentials";
    case "activity":
      return de ? "Änderungen" : "Changes";
  }
}

function tabElementId(tab: CustomerDetailTab): string {
  return `customer-tab-${tab}`;
}

function panelElementId(tab: CustomerDetailTab): string {
  return `customer-tabpanel-${tab}`;
}

/** Where an arrow, Home or End lands from `current`; null for any other key. */
function tabAfterKey(current: CustomerDetailTab, key: string): CustomerDetailTab | null {
  const index = CUSTOMER_DETAIL_TABS.indexOf(current);
  const last = CUSTOMER_DETAIL_TABS.length - 1;
  switch (key) {
    case "ArrowRight":
      return CUSTOMER_DETAIL_TABS[index === last ? 0 : index + 1];
    case "ArrowLeft":
      return CUSTOMER_DETAIL_TABS[index === 0 ? last : index - 1];
    case "Home":
      return CUSTOMER_DETAIL_TABS[0];
    case "End":
      return CUSTOMER_DETAIL_TABS[last];
    default:
      return null;
  }
}

type StripProps = {
  active: CustomerDetailTab;
  onChange: (tab: CustomerDetailTab) => void;
  language: "de" | "en";
};

/**
 * The strip. A WAI-ARIA tab list with a roving tabindex: Tab reaches the
 * chosen tab only, the arrows walk the strip (wrapping at the ends), Home
 * and End jump. Selection follows focus — an arrow opens the panel it lands
 * on, so there is no second key to learn.
 */
export function CustomerDetailTabs({ active, onChange, language }: StripProps) {
  const de = language === "de";

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabAfterKey(active, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
    // The tab that opens is the one that has to hold the focus ring; the
    // strip is small, so the lookup stays inside it rather than in a ref map.
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={de ? "Kundenbereiche" : "Customer sections"}
      className="customer-detail-tabs customer-detail-tabs--wrap"
      onKeyDown={handleKeyDown}
    >
      {CUSTOMER_DETAIL_TABS.map((tab) => {
        const selected = tab === active;
        return (
          <button
            key={tabElementId(tab)}
            type="button"
            role="tab"
            id={tabElementId(tab)}
            data-tab={tab}
            aria-selected={selected}
            // Only the chosen panel exists in the document, so only the
            // chosen tab has a panel to point at.
            aria-controls={selected ? panelElementId(tab) : undefined}
            tabIndex={selected ? 0 : -1}
            className={
              selected ? "customer-detail-tab customer-detail-tab--active" : "customer-detail-tab"
            }
            onClick={() => onChange(tab)}
          >
            {customerDetailTabLabel(tab, language)}
          </button>
        );
      })}
    </div>
  );
}

type PanelProps = {
  tab: CustomerDetailTab;
  children: ReactNode;
};

/** The one mounted panel, labelled by its tab so a screen reader says where it is. */
export function CustomerDetailTabPanel({ tab, children }: PanelProps) {
  return (
    <div
      role="tabpanel"
      id={panelElementId(tab)}
      aria-labelledby={tabElementId(tab)}
      className={`customer-tab-panel customer-tab-panel--${tab}`}
    >
      {children}
    </div>
  );
}
