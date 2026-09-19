/**
 * CustomerActivityCard — "Letzte Änderungen" of the customer and all of
 * its projects.
 *
 * Every project overview has this card for its own log. The customer page
 * gets the union: the office asks "what happened at Müller lately", not
 * "what happened in 2026-0412". The rows are the project card's rows, plus
 * a chip naming the project — several projects share the list here, so each
 * row has to say where it came from; the chip opens that project. The
 * customer's own events (Stammdaten, notes, the visit, archiving) are in
 * the same list and carry no chip: they happened here, on this page.
 *
 * Two logs are merged, so an id cannot order the union; each row carries an
 * opaque keyset cursor instead, and "Mehr laden" hands the last row's back
 * to ask for what is older. A row posted between two requests can never
 * shift the next page. The server clamps the page size; the card treats a
 * full page as "there may be more" and a short one as the end.
 *
 * What is shown is what the server lets this user see: an employee gets the
 * projects they are on, nothing of the others. The card never filters.
 */
import { useEffect, useRef, useState } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { formatServerDateTime } from "../../utils/dates";
import { activityEventLabel } from "../../utils/projects";
import type { CustomerActivity } from "../../types";
import "../../styles/customer-activity.css";

/** Rows per request. A full page means "ask again", a short one is the end. */
const PAGE_SIZE = 30;

type Props = {
  customerId: number;
};

function activityPath(customerId: number, cursor: string | null): string {
  const page = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
  return `/customers/${customerId}/activity?limit=${PAGE_SIZE}${page}`;
}

/** A full page whose last row can be asked after: there may be more. */
function pageMayContinue(page: CustomerActivity[]): boolean {
  return page.length >= PAGE_SIZE && Boolean(page[page.length - 1]?.cursor);
}

/** The row stands for a project when it came from one: a customer-level event has no chip. */
function hasProjectChip(row: CustomerActivity): boolean {
  return row.source !== "customer" && row.project_id != null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "2026-0412 · Müller Garage", degrading to whatever the row carries. */
function projectChipLabel(row: CustomerActivity): string {
  const number = row.project_number?.trim() || `#${row.project_id}`;
  const name = row.project_name?.trim();
  return name ? `${number} · ${name}` : number;
}

export function CustomerActivityCard({ customerId }: Props) {
  const { token, language, openProjectById } = useAppContext();
  const de = language === "de";

  const [rows, setRows] = useState<CustomerActivity[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Which customer the in-flight requests belong to. A switch to another
  // customer bumps it, and a late answer for the old one is dropped instead
  // of landing in the new list.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const ticket = generation.current;
    setRows([]);
    setHasMore(false);
    setError(null);
    setLoading(true);

    apiFetch<CustomerActivity[]>(activityPath(customerId, null), token)
      .then((page) => {
        if (generation.current !== ticket) return;
        setRows(page);
        setHasMore(pageMayContinue(page));
      })
      .catch((err: unknown) => {
        if (generation.current !== ticket) return;
        setError(errorText(err));
      })
      .finally(() => {
        if (generation.current !== ticket) return;
        setLoading(false);
      });

    return () => {
      generation.current += 1;
    };
  }, [customerId, token, reloadKey]);

  async function loadMore() {
    const last = rows[rows.length - 1];
    // Without the last row's cursor there is nothing to ask for.
    if (!last?.cursor || loadingMore) return;
    const ticket = generation.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await apiFetch<CustomerActivity[]>(activityPath(customerId, last.cursor), token);
      if (generation.current !== ticket) return;
      setRows((current) => [...current, ...page]);
      setHasMore(pageMayContinue(page));
    } catch (err: unknown) {
      if (generation.current !== ticket) return;
      setError(errorText(err));
    } finally {
      if (generation.current === ticket) setLoadingMore(false);
    }
  }

  // Retry repeats the step that failed: the first page when nothing is
  // shown yet, otherwise the page that would have been appended.
  function retry() {
    if (rows.length === 0) setReloadKey((current) => current + 1);
    else void loadMore();
  }

  const retryLabel = de ? "Erneut versuchen" : "Try again";

  return (
    <article className="card customer-activity-card">
      <div className="overview-card-head customer-activity-head">
        <h3>{de ? "Letzte Änderungen" : "Recent changes"}</h3>
        <span className="muted customer-activity-hint">
          {de ? "der Kunde und alle seine Projekte" : "the customer and all of their projects"}
        </span>
      </div>

      {loading ? (
        <div className="overview-empty-state" role="status">
          {de ? "Änderungen werden geladen…" : "Loading changes…"}
        </div>
      ) : error !== null && rows.length === 0 ? (
        <div className="customer-activity-error" role="alert">
          <span>{de ? "Änderungen konnten nicht geladen werden." : "Changes could not be loaded."}</span>
          <small className="muted">{error}</small>
          <button type="button" className="linklike" onClick={retry}>
            {retryLabel}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="overview-empty-state">
          {de
            ? "Noch keine Änderungen bei diesem Kunden."
            : "No changes for this customer yet."}
        </div>
      ) : (
        <>
          <ul className="overview-list customer-activity-list">
            {rows.map((row) => (
              <li key={`customer-activity-${row.id}`} className="customer-activity-row">
                <b>{activityEventLabel(row.event_type, language)}</b>
                <small>
                  {formatServerDateTime(row.created_at, language)}
                  {row.actor_name ? ` · ${row.actor_name}` : ""}
                </small>
                <small>{row.message}</small>
                {hasProjectChip(row) && (
                  <button
                    type="button"
                    className="customer-activity-project"
                    title={de ? "Projekt öffnen" : "Open project"}
                    onClick={() => {
                      if (row.project_id != null) openProjectById(row.project_id, "customer_detail");
                    }}
                  >
                    {projectChipLabel(row)}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {(hasMore || error !== null) && (
            <div className="customer-activity-footer">
              {error !== null ? (
                <>
                  <span className="muted" role="alert">
                    {de ? "Weitere Änderungen konnten nicht geladen werden." : "More changes could not be loaded."}
                  </span>
                  <button type="button" className="linklike" onClick={retry}>
                    {retryLabel}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="linklike customer-activity-more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? (de ? "Wird geladen…" : "Loading…") : de ? "Mehr laden" : "Load more"}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}
