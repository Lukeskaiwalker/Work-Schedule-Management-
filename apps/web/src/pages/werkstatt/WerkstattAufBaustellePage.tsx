import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { OnSiteItemRow } from "../../components/werkstatt/onsite/OnSiteItemRow";
import { OnSiteKpiStrip } from "../../components/werkstatt/onsite/OnSiteKpiStrip";
import { WerkstattLoadError } from "../../components/werkstatt/dashboard/WerkstattLoadError";
import { useWerkstattOverview } from "../../hooks/useWerkstattOverview";
import {
  listOnSiteGroups,
  returnArticle,
  type WerkstattOnSiteGroup,
  type WerkstattOnSiteItem,
} from "../../utils/werkstattDashboardApi";
import {
  articlesOnSeveralSites,
  computeOnSiteTotals,
  filterOnSiteGroups,
  ON_SITE_FILTERS,
  type OnSiteFilterKey,
} from "../../utils/werkstattOnSiteTotals";
import { formatQuantity, pluralize } from "../../utils/werkstattOverviewFormat";
import "../../styles/werkstatt-overview.css";

/**
 * WerkstattAufBaustellePage — everything still checked out, grouped by site.
 *
 * Two things were wrong with the screen this replaces. It rendered fixtures,
 * and both of its actions lied: "Zurückgeben" printed a notice and booked
 * nothing, "Mahnen" claimed a reminder had been sent to a named colleague. The
 * second one is the worse of the two, because the office had no way to tell it
 * had not happened until somebody asked why nobody replied.
 *
 * So: the list comes from `GET /werkstatt/on-site`, which nets returns against
 * checkouts and does not cap at three projects the way the dashboard preview
 * does; "Zurückgeben" books through `POST /werkstatt/mobile/return` and shows
 * the server's own words when that fails; and the reminder buttons are gone,
 * replaced by a line that says reminders are not available. There is no
 * notification endpoint to wire them to, and a disabled button that looks like
 * it might work on a better day is its own kind of claim.
 *
 * Self-gates on `mainView === "werkstatt" && werkstattTab === "on_site"`.
 */

/** Identity of one row across a reload — article, who holds it, and when it is
 *  due back, which is exactly how the endpoint groups them. The deadline is
 *  part of the key because two lots of one article can sit with one person on
 *  one site under different return dates; without it the two rows would share
 *  a busy flag and an error message. */
function rowKey(group: WerkstattOnSiteGroup, item: WerkstattOnSiteItem): string {
  return [
    group.project_id ?? "none",
    item.article_id,
    item.assignee_user_id ?? "none",
    item.expected_return_at ?? "none",
  ].join(":");
}

export function WerkstattAufBaustellePage() {
  const { mainView, language, werkstattTab, token, user, now, setNotice, setWerkstattTab } =
    useAppContext();

  const de = language === "de";
  const active = mainView === "werkstatt" && werkstattTab === "on_site";

  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<OnSiteFilterKey>("all");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busyRows, setBusyRows] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});

  const { data, loading, error, reload } = useWerkstattOverview(
    active,
    token,
    listOnSiteGroups,
    de ? "Ausgegebene Artikel nicht geladen." : "Checked-out items not loaded.",
  );

  // A per-row refusal belongs to the numbers it was refused against. Once a
  // new payload lands those numbers are gone — a colleague may have booked the
  // item back from the mobile screen — so the message underneath the row would
  // be contradicting the figures beside it and reading as a failed refresh.
  useEffect(() => {
    setRowErrors({});
  }, [data]);

  const groups = data ?? [];
  const totals = useMemo(
    () => (data ? computeOnSiteTotals(data, now) : null),
    [data, now],
  );
  const visibleGroups = useMemo(
    () => filterOnSiteGroups(groups, activeFilter, search, now),
    [groups, activeFilter, search, now],
  );
  // Computed over the FULL response: an article is shared across sites whether
  // or not the current filter happens to show both of them.
  const sharedArticleIds = useMemo(() => articlesOnSeveralSites(groups), [groups]);

  const canManage = (user?.effective_permissions ?? []).includes("werkstatt:manage");
  const currentUserId = user?.id ?? null;

  const handleReturn = useCallback(
    async (group: WerkstattOnSiteGroup, item: WerkstattOnSiteItem) => {
      const key = rowKey(group, item);
      // Booking somebody else's checkout back in has to be written against
      // THEIR balance — a return only settles checkouts of the same person, so
      // an office user booking it as themselves would leave the technician's
      // "Meine Entnahmen" showing the tool forever.
      const onBehalfOf =
        item.assignee_user_id != null && item.assignee_user_id !== currentUserId
          ? item.assignee_user_id
          : null;
      setBusyRows((current) => new Set([...current, key]));
      setRowErrors((current) => {
        const { [key]: _dropped, ...rest } = current;
        return rest;
      });
      try {
        await returnArticle(token, {
          articleId: item.article_id,
          quantity: item.quantity_out,
          onBehalfOf,
        });
        setNotice(
          de
            ? `${formatQuantity(item.quantity_out, item.unit)} ${item.article_name} zurückgebucht.`
            : `${formatQuantity(item.quantity_out, item.unit)} ${item.article_name} booked back in.`,
        );
        reload();
      } catch (cause: unknown) {
        const message =
          cause instanceof Error && cause.message
            ? cause.message
            : de
              ? "Unbekannter Fehler."
              : "Unknown error.";
        setRowErrors((current) => ({ ...current, [key]: message }));
      } finally {
        setBusyRows((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [currentUserId, de, reload, setNotice, token],
  );

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!active) return null;

  const anyOverdue = (totals?.overdue ?? 0) > 0;

  return (
    <section className="werkstatt-tab-page werkstatt-onsite-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › AUF BAUSTELLE" : "WORKSHOP › ON SITE"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Auf Baustelle — alle Projekte" : "On site — all projects"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {totals == null
              ? de
                ? "Bestand nicht geladen"
                : "List not loaded"
              : de
                ? `${pluralize(totals.lineCount, "Position", "Positionen")} bei ${pluralize(totals.projectCount, "Projekt", "Projekten")}`
                : `${pluralize(totals.lineCount, "line item", "line items")} at ${pluralize(totals.projectCount, "project", "projects")}`}
            {anyOverdue && totals && (
              <>
                {" · "}
                <span className="werkstatt-onsite-subtitle-danger">
                  {totals.overdue} {de ? "überfällig" : "overdue"}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={reload}
            disabled={loading}
          >
            {loading
              ? de
                ? "Lädt…"
                : "Loading…"
              : de
                ? "Aktualisieren"
                : "Refresh"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            onClick={() => setWerkstattTab("inventar")}
            title={
              de
                ? "Öffnet Werkstatt › Bestand — dort wird entnommen."
                : "Opens Workshop › Stock, where checkouts are booked."
            }
          >
            {de ? "Entnahme im Bestand buchen" : "Book a checkout in Stock"}
          </button>
        </div>
      </header>

      {error && (
        <WerkstattLoadError
          headline={
            de
              ? "Die Liste konnte nicht geladen werden — was hier steht, ist nicht der Bestand."
              : "This list could not be loaded — what you see is not the current state."
          }
          detail={error}
          retryLabel={de ? "Erneut versuchen" : "Try again"}
          onRetry={reload}
        />
      )}

      <OnSiteKpiStrip totals={totals} language={de ? "de" : "en"} />

      {/* Reminders have no endpoint. The buttons that claimed to send them are
          gone; this says why, once, instead of three dead controls. */}
      {anyOverdue && (
        <p className="wsov-note">
          {de
            ? "Erinnerungen lassen sich von hier nicht verschicken — dafür gibt es keine Funktion. Überfällige Ausgaben bitte direkt beim Kollegen nachfragen."
            : "Reminders cannot be sent from here — there is no such function. Please chase overdue items with the colleague directly."}
        </p>
      )}

      {/* Said once, and only when it can actually happen: a return carries no
          project, so the list has to guess which checkout it settled. */}
      {sharedArticleIds.size > 0 && (
        <p className="wsov-note">
          {de
            ? `${pluralize(sharedArticleIds.size, "Artikel ist", "Artikel sind")} gleichzeitig auf mehreren Baustellen ausgegeben. Eine Rückgabe wird im Bestand je Artikel gebucht, nicht je Baustelle — welcher Zeile sie hier abgezogen wird, ist danach eine Annahme (die älteste offene Entnahme zuerst).`
            : `${pluralize(sharedArticleIds.size, "article is", "articles are")} out at several sites at once. A return is booked per article, not per site — which row it is deducted from here is an assumption afterwards (oldest open checkout first).`}
        </p>
      )}

      <div className="werkstatt-filter-bar werkstatt-filter-bar--slim">
        <div className="werkstatt-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              de
                ? "Projekt, Artikel oder Person suchen…"
                : "Search project, article or person…"
            }
          />
        </div>
        <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
          {ON_SITE_FILTERS.map((def) => (
            <button
              key={def.key}
              type="button"
              role="tab"
              aria-selected={activeFilter === def.key}
              className={`werkstatt-segmented-btn${activeFilter === def.key ? " werkstatt-segmented-btn--active" : ""}`}
              onClick={() => setActiveFilter(def.key)}
            >
              {de ? def.label_de : def.label_en}
            </button>
          ))}
        </div>
      </div>

      <div className="werkstatt-onsite-groups">
        {visibleGroups.map((group) => {
          const key = String(group.project_id ?? "none");
          const isCollapsed = collapsed.has(key);
          return (
            <article
              key={key}
              className={`werkstatt-onsite-group${isCollapsed ? " werkstatt-onsite-group--collapsed" : ""}`}
            >
              <header className="werkstatt-onsite-group-head">
                <button
                  type="button"
                  className="werkstatt-onsite-group-toggle"
                  onClick={() => toggleGroup(key)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="werkstatt-onsite-caret" aria-hidden="true">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <div className="werkstatt-onsite-group-identity">
                    <div className="werkstatt-onsite-group-title-row">
                      <span className="werkstatt-onsite-project-number">
                        {group.project_number ?? (de ? "OHNE PROJEKT" : "NO PROJECT")}
                      </span>
                      <span className="werkstatt-onsite-project-title">
                        {group.project_title ??
                          (de
                            ? "Entnahmen ohne Baustelle"
                            : "Checkouts without a site")}
                      </span>
                    </div>
                    {/* Project number and title only. The endpoint sends no
                        customer name and no site address: it is gated on
                        authentication alone, and every other project read
                        scopes on membership. */}
                    <p className="werkstatt-onsite-group-meta">
                      {de
                        ? pluralize(group.item_count, "Position", "Positionen")
                        : pluralize(group.item_count, "line item", "line items")}
                      {group.overdue_count > 0 && (
                        <>
                          {" · "}
                          <span className="werkstatt-onsite-group-overdue">
                            {group.overdue_count} {de ? "überfällig" : "overdue"}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                </button>
              </header>

              {!isCollapsed && (
                <ul className="werkstatt-onsite-items">
                  {group.items.map((item) => {
                    const itemKey = rowKey(group, item);
                    const needsOnBehalf =
                      item.assignee_user_id != null && item.assignee_user_id !== currentUserId;
                    return (
                      <OnSiteItemRow
                        key={itemKey}
                        item={item}
                        now={now}
                        language={de ? "de" : "en"}
                        canReturn={!needsOnBehalf || canManage}
                        sharedAcrossSites={sharedArticleIds.has(item.article_id)}
                        busy={busyRows.has(itemKey)}
                        failure={rowErrors[itemKey] ?? null}
                        onReturn={() => void handleReturn(group, item)}
                      />
                    );
                  })}
                </ul>
              )}
            </article>
          );
        })}

        {visibleGroups.length === 0 && (
          <div className="werkstatt-card werkstatt-onsite-empty muted">
            {data == null && error == null
              ? de
                ? "Lädt…"
                : "Loading…"
              : error
                ? de
                  ? "Nicht geladen — die Liste oben zeigt nichts Aktuelles."
                  : "Not loaded — nothing above is current."
                : groups.length === 0
                  ? de
                    ? "Nichts ausgegeben — alles ist in der Werkstatt."
                    : "Nothing checked out — everything is in the workshop."
                  : de
                    ? "Keine Artikel für die aktuelle Auswahl."
                    : "No items match the current filter."}
          </div>
        )}
      </div>
    </section>
  );
}
