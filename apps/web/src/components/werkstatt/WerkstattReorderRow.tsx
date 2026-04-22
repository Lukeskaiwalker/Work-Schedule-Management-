/**
 * WerkstattReorderRow — one line in the "Nachbestellen" card.
 * Mirrors Paper design node 7KM (Low Stock Card): a warm beige icon tile,
 * stacked title + mono article/category line, a location column of fixed
 * width, a stock-pill (warning or danger), and an outlined "Bestellen" button.
 *
 * Uses fixed-width columns for icon, location, and stock-pill so repeated
 * rows form clean vertical lanes across the list.
 */
export type WerkstattStockSeverity = "low" | "out";

export interface WerkstattReorderRowProps {
  itemName: string;
  articleNo: string;
  category: string;
  location: string;
  stockLabel: string;
  severity: WerkstattStockSeverity;
  orderLabel: string;
  onOrder?: () => void;
}

export function WerkstattReorderRow({
  itemName,
  articleNo,
  category,
  location,
  stockLabel,
  severity,
  orderLabel,
  onOrder,
}: WerkstattReorderRowProps) {
  return (
    <li className="werkstatt-reorder-row">
      <span className="werkstatt-reorder-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path
            d="M3 7l9-4 9 4v10l-9 4-9-4V7z"
            stroke="#9A7A2B"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path d="M3 7l9 4 9-4M12 11v10" stroke="#9A7A2B" strokeWidth="1.8" />
        </svg>
      </span>
      <div className="werkstatt-reorder-copy">
        <span className="werkstatt-reorder-title">{itemName}</span>
        <span className="werkstatt-reorder-meta">
          {articleNo} · {category}
        </span>
      </div>
      <span className="werkstatt-reorder-location">{location}</span>
      <span
        className={`werkstatt-stock-pill werkstatt-stock-pill--${severity}`}
      >
        <span
          className={`werkstatt-stock-pill-dot werkstatt-stock-pill-dot--${severity}`}
          aria-hidden="true"
        />
        {stockLabel}
      </span>
      <button
        type="button"
        className="werkstatt-reorder-btn"
        onClick={onOrder}
      >
        {orderLabel}
      </button>
    </li>
  );
}
