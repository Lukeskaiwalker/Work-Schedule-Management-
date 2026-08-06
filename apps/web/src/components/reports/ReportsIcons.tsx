/**
 * Line icons for the Berichte ledger. All 1.5px stroke, no fill, `currentColor`
 * where the surrounding control already defines an ink colour so a single SVG
 * can serve hover and focus states without a second variant.
 */

/** 16px magnifier for the toolbar search field. */
export function ReportsSearchIcon() {
  return (
    <svg
      className="reports-search-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="6.3" stroke="#8FA2BA" strokeWidth="1.5" />
      <path d="m15.6 15.6 4 4" stroke="#8FA2BA" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 14px sheet with a folded corner and an arrow leaving the top-right. */
export function ReportsOpenIcon() {
  return (
    <svg
      className="reports-open-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V13"
        stroke="#5C7895"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.5 3H21v6.5"
        stroke="#5C7895"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M21 3l-7.5 7.5" stroke="#5C7895" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 32px document sheet — the "no reports at all" empty state. */
export function ReportsEmptyDocumentIcon() {
  return (
    <svg
      className="reports-state-icon"
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M19 4H8.5A1.5 1.5 0 0 0 7 5.5v21A1.5 1.5 0 0 0 8.5 28h15a1.5 1.5 0 0 0 1.5-1.5V10l-6-6Z"
        stroke="#A9C1D8"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M19 4v6h6" stroke="#A9C1D8" strokeWidth="1.5" strokeLinejoin="round" />
      <path
        d="M11 15h10M11 19h10M11 23h6"
        stroke="#A9C1D8"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 24px magnifier with a slash — the "filters match nothing" empty state. */
export function ReportsNoResultsIcon() {
  return (
    <svg
      className="reports-state-icon"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10.5" cy="10.5" r="6.3" stroke="#A9C1D8" strokeWidth="1.5" />
      <path d="m15.2 15.2 4.3 4.3" stroke="#A9C1D8" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M7 14 14 7" stroke="#A9C1D8" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 12px ✕ shown inside an active toolbar filter chip. */
export function ReportsChipClearIcon() {
  return (
    <svg
      className="reports-chip-clear"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m3 3 6 6M9 3l-6 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
