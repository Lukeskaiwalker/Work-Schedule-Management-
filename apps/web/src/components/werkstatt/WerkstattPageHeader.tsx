/**
 * WerkstattPageHeader — the page eyebrow + title + action row at the top of
 * the Werkstatt dashboard. Mirrors Paper design node 7JA (Page Header):
 * uppercase eyebrow above a large title, plus three right-aligned buttons
 * (Scan / Categories / primary New Item).
 *
 * Buttons are visual placeholders in this scaffold — they don't trigger any
 * action yet. TODO(werkstatt): wire to scan modal, categories page, and
 * new-item modal once those land.
 */
export interface WerkstattPageHeaderProps {
  de: boolean;
}

export function WerkstattPageHeader({ de }: WerkstattPageHeaderProps) {
  return (
    <header className="werkstatt-page-head">
      <div className="werkstatt-page-title-block">
        <span className="werkstatt-page-eyebrow">
          {de ? "WERKSTATT" : "WORKSHOP"}
        </span>
        <h2 className="werkstatt-page-title">
          {de ? "Werkstatt & Inventar" : "Workshop & Inventory"}
        </h2>
      </div>
      <div className="werkstatt-page-actions">
        <button type="button" className="werkstatt-action-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect
              x="3.5"
              y="3.5"
              width="17"
              height="17"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M8 3.5v17M16 3.5v17M3.5 8h17M3.5 16h17"
              stroke="currentColor"
              strokeWidth="1.8"
            />
          </svg>
          {de ? "Scannen" : "Scan"}
        </button>
        <button type="button" className="werkstatt-action-btn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M4 6.5h16M4 12h16M4 17.5h16"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          {de ? "Kategorien" : "Categories"}
        </button>
        <button
          type="button"
          className="werkstatt-action-btn werkstatt-action-btn--primary"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          {de ? "Neuer Artikel" : "New Item"}
        </button>
      </div>
    </header>
  );
}
