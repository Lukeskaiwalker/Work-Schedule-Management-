/**
 * WerkstattProjectGroup — one project-grouped block in the "Auf Baustelle"
 * card. Mirrors Paper design node 7OM (Checked Out Card). Header shows
 * mono project number + title on the left and the item count on the right;
 * the body is a small bullet list where the bullet color signals status
 * (neutral = on site, warning = overdue).
 */
export type WerkstattCheckedOutStatus = "on_site" | "overdue";

export interface WerkstattCheckedOutItem {
  id: string;
  title: string;
  trailing: string;
  status: WerkstattCheckedOutStatus;
}

export interface WerkstattProjectGroupProps {
  projectNumber: string;
  projectTitle: string;
  itemsLabel: string;
  items: ReadonlyArray<WerkstattCheckedOutItem>;
}

export function WerkstattProjectGroup({
  projectNumber,
  projectTitle,
  itemsLabel,
  items,
}: WerkstattProjectGroupProps) {
  return (
    <div className="werkstatt-checkout-group">
      <div className="werkstatt-checkout-group-head">
        <div className="werkstatt-checkout-group-title">
          <span className="werkstatt-checkout-group-number">{projectNumber}</span>
          <span className="werkstatt-checkout-group-name">{projectTitle}</span>
        </div>
        <span className="werkstatt-checkout-group-count">{itemsLabel}</span>
      </div>
      <ul className="werkstatt-checkout-items">
        {items.map((item) => (
          <li key={item.id} className="werkstatt-checkout-item">
            <span
              className={`werkstatt-checkout-dot werkstatt-checkout-dot--${item.status}`}
              aria-hidden="true"
            />
            <span className="werkstatt-checkout-item-title">{item.title}</span>
            <span className="werkstatt-checkout-item-trailing">
              {item.trailing}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
