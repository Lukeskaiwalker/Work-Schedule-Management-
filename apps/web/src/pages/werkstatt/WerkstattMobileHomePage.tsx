import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { splitCompactNameParts } from "../../utils/names";
import { createRequestSequence } from "../../utils/latestRequest";
import { unitLabel } from "../../components/werkstatt/unitLabel";
import { MobileArticleSearch } from "../../components/werkstatt/mobile/MobileArticleSearch";
import { MobileReturnSheet } from "../../components/werkstatt/mobile/MobileReturnSheet";
import {
  greeting,
  isOverdue,
  projectLabel,
  returnNotice,
  sinceLabel,
} from "../../components/werkstatt/mobile/mobileLabels";
import {
  fetchBelowMinCount,
  listMyCheckouts,
  returnArticle,
  type MyCheckout,
} from "../../utils/werkstattMobileApi";
import "../../styles/mobile.css";

/**
 * WerkstattMobileHomePage — mobile-only Werkstatt start screen, ported from
 * Paper artboard A3Y-0 ("Werkstatt — Mobile: Start").
 *
 * Self-gates on:
 *   - mainView === "werkstatt"
 *   - werkstattTab === "dashboard"
 *   - viewport < 768px (Paper mobile artboards are drawn at 390px)
 *
 * Outside those conditions the component returns null so the Desktop FE
 * dashboard renders instead. See useIsMobileViewport for the live media
 * query subscription.
 *
 * Every number on this screen comes from the server:
 *   - the checkout card from `GET /werkstatt/mobile/my-checkouts`
 *   - the reorder pill from `kpis.below_min_count` on `GET /werkstatt/dashboard`
 *
 * The two loads are settled independently on purpose. They are different
 * questions, and one of them failing must not blank the other — nor turn into
 * a zero, which on this screen would read as "nothing is borrowed" or "nothing
 * needs ordering" to a workshop that acts on both.
 */
export function WerkstattMobileHomePage() {
  const {
    mainView,
    werkstattTab,
    setMainView,
    setWerkstattTab,
    setActiveWerkstattArticleId,
    language,
    token,
    user,
    setNotice,
  } = useAppContext();
  const { isMobile } = useIsMobileViewport();

  const active = mainView === "werkstatt" && werkstattTab === "dashboard" && isMobile;
  const de = language === "de";

  const [checkouts, setCheckouts] = useState<ReadonlyArray<MyCheckout> | null>(null);
  const [checkoutsError, setCheckoutsError] = useState<string | null>(null);
  const [belowMin, setBelowMin] = useState<number | null>(null);
  const [belowMinError, setBelowMinError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [returnTarget, setReturnTarget] = useState<MyCheckout | null>(null);
  const [returnSaving, setReturnSaving] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);

  // Leaving for the scanner and coming back re-runs the effect below, so the
  // list is never older than the last time this screen was looked at.
  const sequence = useMemo(() => createRequestSequence(), []);

  const load = useCallback(async () => {
    const ticket = sequence.issue();
    setLoading(true);
    const [mine, kpi] = await Promise.allSettled([
      listMyCheckouts(token),
      fetchBelowMinCount(token),
    ]);
    if (!sequence.isCurrent(ticket)) return;

    if (mine.status === "fulfilled") {
      setCheckouts(mine.value);
      setCheckoutsError(null);
    } else {
      // The previous list is dropped as well: a stale list beside a "could not
      // load" banner is the ambiguity this screen exists to remove.
      setCheckouts(null);
      setCheckoutsError(
        mine.reason instanceof Error ? mine.reason.message : String(mine.reason),
      );
    }

    if (kpi.status === "fulfilled") {
      setBelowMin(kpi.value);
      setBelowMinError(null);
    } else {
      setBelowMin(null);
      setBelowMinError(
        kpi.reason instanceof Error ? kpi.reason.message : String(kpi.reason),
      );
    }
    setLoading(false);
  }, [token, sequence]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const confirmReturn = useCallback(
    async (payload: {
      quantity: number;
      condition: "ok" | "repair" | "lost";
      notes: string;
      project_id: number | null;
    }) => {
      if (!returnTarget || returnSaving) return;
      setReturnSaving(true);
      setReturnError(null);
      try {
        const article = await returnArticle(token, {
          articleId: returnTarget.article_id,
          quantity: payload.quantity,
          condition: payload.condition,
          // The row IS the loan: it is one (article, project) bucket, and the
          // server balances those buckets separately. Dropping the project
          // here left the row standing after a successful return — the notice
          // below and the reloaded list said opposite things — and subtracted
          // the quantity from a project-less loan nobody had brought back.
          projectId: payload.project_id,
          notes: payload.notes.trim() || null,
        });
        setReturnTarget(null);
        setNotice(
          returnNotice(
            {
              condition: payload.condition,
              quantity: payload.quantity,
              itemName: returnTarget.article_name,
              availableAfter: article.stock_available,
              totalAfter: article.stock_total,
            },
            de,
          ),
        );
        // The row's remaining quantity is a server-side fact; refetch it
        // rather than subtracting here.
        await load();
      } catch (err: unknown) {
        // Stays in the sheet: "more than is out" and "article archived" are
        // both answers the user can act on without retyping.
        setReturnError(err instanceof Error ? err.message : String(err));
      } finally {
        setReturnSaving(false);
      }
    },
    [returnTarget, returnSaving, token, de, setNotice, load],
  );

  if (!active) return null;

  const now = new Date();
  const firstName = user ? splitCompactNameParts(user.display_name).first : "";
  const initials = (() => {
    if (!user) return "";
    const parts = splitCompactNameParts(user.display_name);
    const first = parts.first ? parts.first[0] : "";
    return `${first}${parts.lastInitial}`.toUpperCase();
  })();

  const openScanner = () => setMainView("werkstatt_scan");

  const openArticle = (articleId: number) => {
    setActiveWerkstattArticleId(articleId);
    setWerkstattTab("artikel");
  };

  const openReorder = () => setWerkstattTab("nachbestellen");

  const cardSubtitle = checkoutsError
    ? de
      ? "nicht geladen"
      : "not loaded"
    : checkouts === null
      ? de
        ? "wird geladen…"
        : "loading…"
      : de
        ? `${checkouts.length} Artikel unterwegs`
        : `${checkouts.length} items out`;

  return (
    <section
      className="werkstatt-mobile werkstatt-mobile--home"
      aria-label={de ? "Werkstatt Start" : "Werkstatt home"}
    >
      <header className="werkstatt-mobile-home-top">
        <div className="werkstatt-mobile-home-greeting">
          <span className="werkstatt-mobile-home-folder-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M3.5 7.5a1.8 1.8 0 0 1 1.8-1.8h3.9l1.8 2.1h7.7a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Z"
                stroke="#FFFFFF"
                strokeWidth="1.8"
              />
            </svg>
          </span>
          <div className="werkstatt-mobile-home-greeting-text">
            <span className="werkstatt-mobile-home-eyebrow">WERKSTATT</span>
            <span className="werkstatt-mobile-home-title">
              {greeting(now, firstName, de)}
            </span>
          </div>
          <span className="werkstatt-mobile-home-avatar" aria-hidden="true">
            {initials || "–"}
          </span>
        </div>

        <button
          type="button"
          className="werkstatt-mobile-home-scan-card"
          onClick={openScanner}
        >
          <span className="werkstatt-mobile-home-scan-icon" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="#2F70B7" strokeWidth="1.8" />
              <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="#2F70B7" strokeWidth="1.8" />
              <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="#2F70B7" strokeWidth="1.8" />
              <path d="M13.5 13.5h2v2h-2zM17.5 13.5h3v2h-3zM13.5 17.5h2v3h-2zM18.5 17.5h2v3h-2z" fill="#2F70B7" />
            </svg>
          </span>
          <span className="werkstatt-mobile-home-scan-text">
            <span className="werkstatt-mobile-home-scan-title">
              {de ? "QR-Code scannen" : "Scan QR code"}
            </span>
            <span className="werkstatt-mobile-home-scan-subtitle">
              {de
                ? "Artikel entnehmen oder zurückgeben"
                : "Check out or return an article"}
            </span>
          </span>
          <span className="werkstatt-mobile-home-scan-chevron" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="#2F70B7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      </header>

      <div className="werkstatt-mobile-home-body">
        <MobileArticleSearch
          token={token}
          language={language}
          onOpenArticle={openArticle}
        />

        <section className="werkstatt-mobile-card werkstatt-mobile-checkouts">
          <header className="werkstatt-mobile-card-head">
            <div>
              <h3 className="werkstatt-mobile-card-title">
                {de ? "Meine Entnahmen" : "My checkouts"}
              </h3>
              <span className="werkstatt-mobile-card-subtitle">{cardSubtitle}</span>
            </div>
            {/* The slot used to hold an inert "Alle →". There is no second
                list to go to — this endpoint returns every outstanding
                checkout — so it holds the refresh the screen actually needs. */}
            <button
              type="button"
              className="werkstatt-mobile-card-action werkstatt-mobile-refresh"
              onClick={() => void load()}
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
          </header>

          {checkoutsError ? (
            <div className="werkstatt-mobile-state werkstatt-mobile-state--error" role="alert">
              <b>
                {de
                  ? "Entnahmen konnten nicht geladen werden"
                  : "Could not load your checkouts"}
              </b>
              <small>{checkoutsError}</small>
              <button
                type="button"
                className="werkstatt-mobile-state-retry"
                onClick={() => void load()}
                disabled={loading}
              >
                {de ? "Erneut versuchen" : "Try again"}
              </button>
            </div>
          ) : checkouts === null ? (
            <div className="werkstatt-mobile-state" role="status">
              <b>{de ? "Wird geladen…" : "Loading…"}</b>
            </div>
          ) : checkouts.length === 0 ? (
            <div className="werkstatt-mobile-state">
              <b>{de ? "Nichts ausgeliehen" : "Nothing checked out"}</b>
              <small>
                {de
                  ? "Auf deinen Namen ist gerade kein Artikel unterwegs."
                  : "No item is out under your name right now."}
              </small>
            </div>
          ) : (
            <ul className="werkstatt-mobile-checkouts-list">
              {checkouts.map((row, idx) => {
                const overdue = isOverdue(row.latest_expected_return_at, now);
                const since = sinceLabel(row.earliest_checkout_at, now, de);
                const meta = [
                  `${row.quantity_out} ${unitLabel(row.unit, de)}`,
                  since,
                  projectLabel(row, de),
                  overdue ? (de ? "überfällig" : "overdue") : null,
                ]
                  .filter((part): part is string => Boolean(part))
                  .join(" · ");
                const isLast = idx === checkouts.length - 1;
                return (
                  <li
                    key={`${row.article_id}-${row.project_id ?? "none"}`}
                    className={`werkstatt-mobile-checkout-row${
                      isLast ? " werkstatt-mobile-checkout-row--last" : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="werkstatt-mobile-checkout-row-main"
                      onClick={() => openArticle(row.article_id)}
                    >
                      <span className="werkstatt-mobile-checkout-icon" aria-hidden="true">
                        {row.image_url ? (
                          <img
                            className="werkstatt-mobile-thumb"
                            src={row.image_url}
                            alt=""
                          />
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M3 7l9-4 9 4v10l-9 4-9-4V7z"
                              stroke="#5C7895"
                              strokeWidth="1.6"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </span>
                      <span className="werkstatt-mobile-checkout-text">
                        <span className="werkstatt-mobile-checkout-title">
                          {row.article_name}
                        </span>
                        <span
                          className={`werkstatt-mobile-checkout-meta${
                            overdue ? " werkstatt-mobile-checkout-meta--overdue" : ""
                          }`}
                        >
                          {meta}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`werkstatt-mobile-return-btn${
                        overdue ? " werkstatt-mobile-return-btn--overdue" : ""
                      }`}
                      /* Every row's button reads "Zurück". Without the name a
                         screen reader offers a list of identical buttons. */
                      aria-label={
                        de
                          ? `${row.article_name} zurückgeben`
                          : `Return ${row.article_name}`
                      }
                      onClick={() => {
                        setReturnError(null);
                        setReturnTarget(row);
                      }}
                    >
                      {de ? "Zurück" : "Return"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <button
          type="button"
          className={`werkstatt-mobile-alert-pill${
            belowMinError
              ? " werkstatt-mobile-alert-pill--error"
              : belowMin === 0
                ? " werkstatt-mobile-alert-pill--ok"
                : ""
          }`}
          onClick={openReorder}
        >
          <span className="werkstatt-mobile-alert-icon" aria-hidden="true">
            {belowMin === 0 && !belowMinError ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="m5 12 5 5 9-10"
                  stroke="#0E6F45"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3 2.5 19.5h19L12 3Z"
                  stroke="#9A4A06"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path d="M12 10v4M12 17v.1" stroke="#9A4A06" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
          </span>
          <span className="werkstatt-mobile-alert-text">
            <span className="werkstatt-mobile-alert-title">
              {belowMinError
                ? de
                  ? "Mindestbestand konnte nicht geladen werden"
                  : "Could not load the minimum-stock count"
                : belowMin === null
                  ? de
                    ? "Mindestbestand wird geladen…"
                    : "Loading minimum-stock count…"
                  : belowMin === 0
                    ? de
                      ? "Kein Artikel unter Mindestbestand"
                      : "No item below minimum stock"
                    : de
                      ? `${belowMin} Artikel unter Mindestbestand`
                      : `${belowMin} items below minimum stock`}
            </span>
            <span className="werkstatt-mobile-alert-subtitle">
              {belowMinError
                ? belowMinError
                : de
                  ? "Jetzt Bestellbericht öffnen"
                  : "Open reorder report"}
            </span>
          </span>
          <span className="werkstatt-mobile-alert-chevron" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="#8B6B2C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      </div>

      {returnTarget && (
        <MobileReturnSheet
          open
          language={language}
          item={{
            article_name: returnTarget.article_name,
            article_number: returnTarget.article_number,
            unit: returnTarget.unit,
          }}
          /* Exactly one: the tapped row already is a single (article, project)
             loan with the caller's own outstanding quantity on it. */
          targets={[
            {
              project_id: returnTarget.project_id,
              project_label: returnTarget.project_number ?? returnTarget.project_name,
              quantity_out: returnTarget.quantity_out,
            },
          ]}
          submitting={returnSaving}
          error={returnError}
          onClose={() => {
            setReturnTarget(null);
            setReturnError(null);
          }}
          onConfirm={(payload) => void confirmReturn(payload)}
        />
      )}
    </section>
  );
}
