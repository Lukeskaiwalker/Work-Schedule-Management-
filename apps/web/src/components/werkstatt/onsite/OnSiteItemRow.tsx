import {
  dueStatus,
  formatDueLabel,
  formatQuantity,
  type WerkstattDueStatus,
} from "../../../utils/werkstattOverviewFormat";
import { initialsFromName } from "../../../utils/names";
import type { WerkstattOnSiteItem } from "../../../utils/werkstattDashboardApi";

/**
 * One outstanding article on the "Auf Baustelle" list.
 *
 * The return button is the only write on this screen, and it is gated on what
 * `POST /werkstatt/mobile/return` actually needs rather than on a blanket
 * permission: booking your own checkout back in needs nothing beyond being
 * signed in, booking somebody ELSE'S means `?on_behalf_of=`, which the server
 * refuses without `werkstatt:manage`. So a user without that right sees the
 * button disabled, with the reason on it, instead of a form that can only 403.
 *
 * There is no "Mahnen" button. The API has no reminder endpoint — see the note
 * the page renders above the list.
 */
export interface OnSiteItemRowProps {
  item: WerkstattOnSiteItem;
  now: Date;
  language: "de" | "en";
  /** True when this row would need `on_behalf_of` and the user may send it. */
  canReturn: boolean;
  /** This article is out on more than one site, so the return the server books
   *  against it may be attributed to another site's row. Said on the button
   *  rather than hidden, because the button is what causes it. */
  sharedAcrossSites: boolean;
  /** Set while this row's return request is in flight. */
  busy: boolean;
  /** Server's own words when this row's last return attempt failed. */
  failure: string | null;
  onReturn: () => void;
}

function statusClass(status: WerkstattDueStatus): string {
  if (status === "overdue") return "werkstatt-onsite-return werkstatt-onsite-return--overdue";
  if (status === "due_today") return "werkstatt-onsite-return werkstatt-onsite-return--today";
  if (status === "due_soon") return "werkstatt-onsite-return werkstatt-onsite-return--soon";
  return "werkstatt-onsite-return";
}


/** What the return button promises, in full. Split out because the honest
 *  version is three sentences and none of them may be dropped. */
function returnTitle(
  item: WerkstattOnSiteItem,
  flags: { canReturn: boolean; sharedAcrossSites: boolean; de: boolean },
): string {
  const { canReturn, sharedAcrossSites, de } = flags;
  if (!canReturn) {
    return de
      ? "Rückgabe für andere braucht das Recht „Werkstatt verwalten“."
      : "Returning for someone else requires the “manage workshop” permission.";
  }
  const amount = formatQuantity(item.quantity_out, item.unit);
  const base = de ? `${amount} zurückbuchen` : `Book ${amount} back in`;
  if (!sharedAcrossSites) return base;
  return de
    ? `${base}. Achtung: Der Artikel ist auf mehreren Baustellen ausgegeben, und eine Rückgabe wird je Artikel gebucht — die Zuordnung in dieser Liste kann danach abweichen.`
    : `${base}. Note: this article is out at several sites and a return is booked per article, so this list may attribute it elsewhere.`;
}

export function OnSiteItemRow({
  item,
  now,
  language,
  canReturn,
  sharedAcrossSites,
  busy,
  failure,
  onReturn,
}: OnSiteItemRowProps) {
  const de = language === "de";
  // The server's flag wins over a locally recomputed one: the KPI strip counts
  // `is_overdue`, so the red dot has to be driven by the same bit or a row can
  // look fine under a headline that counts it as late.
  const status = item.is_overdue ? "overdue" : dueStatus(item.expected_return_at, now);
  const assignee = item.assignee_display_name;

  return (
    <li className="werkstatt-onsite-item">
      <div className="werkstatt-onsite-item-icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
            stroke="#5C7895"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M3 7.5 12 12l9-4.5M12 12v9" stroke="#5C7895" strokeWidth="1.6" />
        </svg>
      </div>
      <div className="werkstatt-onsite-item-main">
        <div className="werkstatt-onsite-item-title">{item.article_name}</div>
        <div className="werkstatt-onsite-item-meta">
          <span className="werkstatt-onsite-item-sp">{item.article_number}</span>
          <span aria-hidden="true">·</span>
          <span>
            {formatQuantity(item.quantity_out, item.unit)} {de ? "draußen" : "out"}
          </span>
        </div>
      </div>
      <div className="werkstatt-onsite-item-assignee">
        {assignee ? (
          <>
            <span className="werkstatt-initials" aria-hidden="true">
              {initialsFromName(assignee, "?")}
            </span>
            <span className="werkstatt-onsite-assignee-name">{assignee}</span>
          </>
        ) : (
          <span className="werkstatt-onsite-assignee-name">
            {de ? "Ohne Zuordnung" : "Unassigned"}
          </span>
        )}
      </div>
      <div className={statusClass(status)}>
        {status === "overdue" && (
          <span className="werkstatt-onsite-return-dot" aria-hidden="true" />
        )}
        <span>{formatDueLabel(item.expected_return_at, now, de)}</span>
      </div>
      <div className="werkstatt-onsite-item-actions">
        <button
          type="button"
          className="werkstatt-action-btn werkstatt-action-btn--small"
          onClick={onReturn}
          disabled={busy || !canReturn}
          title={returnTitle(item, { canReturn, sharedAcrossSites, de })}
        >
          {busy ? (de ? "Bucht…" : "Booking…") : `↩ ${de ? "Zurück" : "Return"}`}
        </button>
      </div>
      {failure && (
        <p className="wsov-row-error" role="alert">
          {de ? "Nicht gebucht: " : "Not booked: "}
          {failure}
        </p>
      )}
    </li>
  );
}
