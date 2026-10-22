import { useId, type ReactNode } from "react";

import { useAppContext } from "../../context/AppContext";
import "../../styles/dashboard.css";

/**
 * The card every start-page widget sits in: title, optional count badge,
 * optional header link to the full page, and a body that is exactly one of
 * the states in docs/DASHBOARD.md §8.4.
 *
 * The frame, not each widget, decides between those states, so no widget can
 * get the house rule wrong: a figure nobody fetched is never shown as „0“
 * (useWerkstattOverview). While a widget's data is null it shows skeleton
 * rows or the error with a retry, and its badge and „+n weitere“ stay hidden.
 *
 * `state` takes a resource snapshot as it comes (useDashboardResource): its
 * `loading` is true only while there is nothing to show. Widgets fed from the
 * app context pass no `state` and always render their body.
 */
export type DashboardWidgetFrameState = {
  loading: boolean;
  error: string | null;
  stale?: boolean;
  forbidden?: boolean;
  onRetry?: () => void;
};

export type DashboardWidgetFrameProps = {
  title: string;
  badge?: number | null;
  action?: { label: string; onClick: () => void } | null;
  state?: DashboardWidgetFrameState;
  isEmpty?: boolean;
  emptyText?: string;
  /** „+{n} weitere“: rows beyond the size's limit, linking to the full page. */
  more?: { count: number; onClick: () => void } | null;
  children?: ReactNode;
};

type BodyKind = "forbidden" | "error" | "loading" | "empty" | "content";

const SKELETON_ROWS = [0, 1, 2];

function bodyKindOf(state: DashboardWidgetFrameState | undefined, isEmpty: boolean): BodyKind {
  if (state?.forbidden) return "forbidden";
  // Stale data outranks the error: what was loaded stays readable, flagged.
  if (state?.error && !state.stale) return "error";
  if (state?.loading) return "loading";
  return isEmpty ? "empty" : "content";
}

export function DashboardWidgetFrame({
  title,
  badge = null,
  action = null,
  state,
  isEmpty = false,
  emptyText,
  more = null,
  children,
}: DashboardWidgetFrameProps): JSX.Element {
  const { language } = useAppContext();
  const titleId = useId();
  const de = language === "de";
  const kind = bodyKindOf(state, isEmpty);
  const settled = kind === "content" || kind === "empty";
  const showBadge = settled && badge !== null && badge > 0;
  const showStale = settled && state?.stale === true;
  const showMore = kind === "content" && more !== null && more.count > 0;

  let body: ReactNode;
  if (kind === "forbidden") {
    body = <p className="dashboard-widget__note">{de ? "Keine Berechtigung." : "No permission."}</p>;
  } else if (kind === "error") {
    body = (
      <div className="dashboard-widget__error">
        <p>{de ? "Konnte nicht geladen werden." : "Could not be loaded."}</p>
        {state?.onRetry ? (
          <button type="button" className="dashboard-widget__retry" onClick={state.onRetry}>
            {de ? "Erneut versuchen" : "Try again"}
          </button>
        ) : null}
      </div>
    );
  } else if (kind === "loading") {
    body = (
      <div className="dashboard-widget__skeleton" aria-busy="true">
        <span className="visually-hidden">{de ? "Wird geladen …" : "Loading …"}</span>
        {SKELETON_ROWS.map((row) => (
          <span key={row} className="dashboard-widget__skeleton-row" aria-hidden="true" />
        ))}
      </div>
    );
  } else if (kind === "empty") {
    body = <p className="dashboard-widget__note">{emptyText ?? (de ? "Keine Einträge." : "Nothing here.")}</p>;
  } else {
    body = children;
  }

  return (
    <section className="dashboard-widget" aria-labelledby={titleId}>
      <header className="dashboard-widget__head">
        <div className="dashboard-widget__heading">
          <h3 id={titleId} className="dashboard-widget__title">
            {title}
          </h3>
          {showBadge ? <span className="dashboard-widget__badge">{badge}</span> : null}
        </div>
        {showStale ? (
          <span className="dashboard-widget__stale">{de ? "Nicht aktuell" : "Not up to date"}</span>
        ) : null}
        {action && kind !== "forbidden" ? (
          <button type="button" className="dashboard-widget__action" onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </header>
      <div className="dashboard-widget__body">{body}</div>
      {showMore ? (
        <button type="button" className="dashboard-widget__more" onClick={more.onClick}>
          {de ? `+${more.count} weitere` : `+${more.count} more`}
        </button>
      ) : null}
    </section>
  );
}
