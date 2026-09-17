import { useCallback, useEffect, useMemo, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { BestandAnpassenModal } from "../../components/werkstatt/BestandAnpassenModal";
import { EntnehmenModal } from "../../components/werkstatt/EntnehmenModal";
import { KebabMenu } from "../../components/werkstatt/KebabMenu";
import {
  MobileReturnSheet,
  type MobileReturnTarget,
} from "../../components/werkstatt/mobile/MobileReturnSheet";
import { MobileArtikelMovements } from "../../components/werkstatt/mobile/MobileArtikelMovements";
import {
  MobileArtikelBestand,
  MobileArtikelHero,
} from "../../components/werkstatt/mobile/MobileArtikelStammdaten";
import { returnNotice } from "../../components/werkstatt/mobile/mobileLabels";
import { stockAdjustmentNotice, staleStockMessage } from "../../components/werkstatt/stockNotices";
import { ApiError } from "../../api/client";
import { createRequestSequence } from "../../utils/latestRequest";
import { expectedReturnIso } from "../../utils/werkstattReturnDates";
import {
  adjustArticleStock,
  checkoutArticle,
  getArticle,
} from "../../utils/werkstattArticlesApi";
import {
  MY_MOVEMENTS_WINDOW,
  listMyCheckouts,
  listMyMovements,
  returnArticle,
  type MyCheckout,
} from "../../utils/werkstattMobileApi";
import type { WerkstattArticle, WerkstattMovement } from "../../types/werkstatt";
import "../../styles/mobile.css";

/**
 * WerkstattMobileArtikelPage — mobile-only article detail, ported from Paper
 * artboard A7D-0 ("Werkstatt — Mobile: Artikel-Detail").
 *
 * This is the screen a scan lands on, and until now it rendered a fixture:
 * LAGER 0 / UNTERWEGS 0 / BESTAND 0 and an empty name for an article with
 * fourteen on the shelf. It now reads `GET /werkstatt/articles/{id}` and every
 * counter on it is the server's.
 *
 * Self-gates on mainView + werkstattTab + viewport + a selected article id.
 *
 * Three write paths, all against endpoints that already existed:
 *   Entnehmen        → POST /werkstatt/mobile/checkout
 *   Zurückgeben      → POST /werkstatt/mobile/return
 *   Bestand anpassen → POST /werkstatt/articles/{id}/movements (werkstatt:manage)
 *
 * After each one the screen RELOADS rather than doing arithmetic on the
 * figures it is holding: the checkout and adjust clients answer with narrowed
 * payloads that carry no `stock_out`, and this screen prints `stock_out`. The
 * write's own response is what the confirmation message quotes.
 *
 * It also reads `GET /werkstatt/mobile/my-checkouts`, which is not shown
 * anywhere on the screen. The article's `stock_out` is what the whole TEAM has
 * out; a return can only give back what the CALLER holds, and those are
 * different numbers. Seeding the return sheet with the team figure let two
 * taps book a colleague's tools back onto the shelf, and the server could not
 * refuse it — `apply_movement` validates a return against the article's global
 * `stock_out` only. So the caller's own loans are what the sheet is handed.
 */
export function WerkstattMobileArtikelPage() {
  const {
    mainView,
    werkstattTab,
    setWerkstattTab,
    activeWerkstattArticleId,
    setActiveWerkstattArticleId,
    language,
    token,
    user,
    projects,
    setNotice,
  } = useAppContext();
  const { isMobile } = useIsMobileViewport();

  const articleId = activeWerkstattArticleId;
  const active =
    mainView === "werkstatt" && werkstattTab === "artikel" && isMobile && articleId != null;
  const de = language === "de";

  /* `POST /werkstatt/articles/{id}/movements` is gated on `werkstatt:manage`.
   * Offering "Bestand anpassen" to everyone would mean filling in a stock-take
   * on a phone only to learn from a 403 that it was never going to be booked;
   * checkout and return need no such permission and stay open to everyone. */
  const canManageStock = (user?.effective_permissions ?? []).includes("werkstatt:manage");

  const [article, setArticle] = useState<WerkstattArticle | null>(null);
  const [movements, setMovements] = useState<ReadonlyArray<WerkstattMovement> | null>(null);
  const [movementsError, setMovementsError] = useState<string | null>(null);
  const [myCheckouts, setMyCheckouts] = useState<ReadonlyArray<MyCheckout> | null>(null);
  const [myCheckoutsError, setMyCheckoutsError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const sequence = useMemo(() => createRequestSequence(), []);

  const load = useCallback(async () => {
    if (articleId == null) return;
    const ticket = sequence.issue();
    setLoading(true);
    const [detail, ledger, mine] = await Promise.allSettled([
      getArticle(token, articleId),
      listMyMovements(token),
      listMyCheckouts(token),
    ]);
    if (!sequence.isCurrent(ticket)) return;

    if (detail.status === "fulfilled") {
      setArticle(detail.value);
      setLoadError(null);
    } else {
      // No stale article left behind an error banner: this screen's whole job
      // is to be the number the workshop can act on.
      setArticle(null);
      setLoadError(
        detail.reason instanceof Error ? detail.reason.message : String(detail.reason),
      );
    }

    if (ledger.status === "fulfilled") {
      setMovements(ledger.value.filter((row) => row.article_id === articleId));
      setMovementsError(null);
    } else {
      setMovements(null);
      setMovementsError(
        ledger.reason instanceof Error ? ledger.reason.message : String(ledger.reason),
      );
    }

    if (mine.status === "fulfilled") {
      setMyCheckouts(mine.value);
      setMyCheckoutsError(null);
    } else {
      // Not knowing what the caller holds is not the same as holding nothing:
      // the return action says it could not check rather than capping at a
      // number nobody answered.
      setMyCheckouts(null);
      setMyCheckoutsError(
        mine.reason instanceof Error ? mine.reason.message : String(mine.reason),
      );
    }
    setLoading(false);
  }, [articleId, token, sequence]);

  /**
   * The caller's OWN open loans of this article — one per project, because
   * that is the granularity the server balances them at and the granularity a
   * return has to name to close one.
   */
  const myTargets = useMemo<ReadonlyArray<MobileReturnTarget>>(() => {
    if (myCheckouts === null || articleId == null) return [];
    return myCheckouts
      .filter((row) => row.article_id === articleId && row.quantity_out > 0)
      .map((row) => ({
        project_id: row.project_id,
        project_label: row.project_number ?? row.project_name,
        quantity_out: row.quantity_out,
      }));
  }, [myCheckouts, articleId]);

  const myOut = myTargets.reduce((sum, target) => sum + target.quantity_out, 0);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  /** Book a checkout, then take the new counters from the server. */
  const confirmCheckout = useCallback(
    async (payload: {
      quantity: number;
      project_id: string | null;
      expected_return: Parameters<typeof expectedReturnIso>[0];
      notes: string;
    }) => {
      if (!article || saving) return;
      setSaving(true);
      setActionError(null);
      try {
        const projectId = payload.project_id ? Number(payload.project_id) : null;
        const snapshot = await checkoutArticle(token, {
          articleId: article.id,
          quantity: payload.quantity,
          projectId: projectId !== null && Number.isFinite(projectId) ? projectId : null,
          expectedReturnAt: expectedReturnIso(payload.expected_return, new Date()),
          notes: payload.notes.trim() || null,
        });
        setCheckoutOpen(false);
        setNotice(
          de
            ? `${payload.quantity}× ${article.item_name} entnommen — ${snapshot.stock_available} von ${snapshot.stock_total} noch verfügbar`
            : `Checked out ${payload.quantity}× ${article.item_name} — ${snapshot.stock_available} of ${snapshot.stock_total} still available`,
        );
        await load();
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [article, saving, token, de, setNotice, load],
  );

  const confirmReturn = useCallback(
    async (payload: {
      quantity: number;
      condition: "ok" | "repair" | "lost";
      notes: string;
      project_id: number | null;
    }) => {
      if (!article || saving) return;
      setSaving(true);
      setActionError(null);
      try {
        const updated = await returnArticle(token, {
          articleId: article.id,
          quantity: payload.quantity,
          condition: payload.condition,
          // Which loan the sheet was pointed at. Without it the movement lands
          // in the caller's no-project bucket and the loan it was meant to
          // close stays open on "Meine Entnahmen" for good.
          projectId: payload.project_id,
          notes: payload.notes.trim() || null,
        });
        setReturnOpen(false);
        setNotice(
          returnNotice(
            {
              condition: payload.condition,
              quantity: payload.quantity,
              itemName: article.item_name,
              availableAfter: updated.stock_available,
              totalAfter: updated.stock_total,
            },
            de,
          ),
        );
        await load();
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [article, saving, token, de, setNotice, load],
  );

  /**
   * Book a manual adjustment.
   *
   * A stock-take sends the TARGET total with the figure the dialog displayed
   * as an optimistic lock — a count is a statement about one observed total
   * and has to be refused if the shelf moved underneath it. A delivery is not:
   * the boxes arrived whatever else happened.
   */
  const confirmAdjust = useCallback(
    async (payload: {
      kind: "intake" | "defect" | "inventory";
      amount: number;
      new_total: number;
      reason: string;
    }) => {
      if (!article || saving) return;
      setSaving(true);
      setActionError(null);
      try {
        const snapshot = await adjustArticleStock(
          token,
          article.id,
          payload.kind === "inventory"
            ? {
                kind: "inventory",
                targetTotal: payload.new_total,
                reason: payload.reason,
                expectedTotal: article.stock_total,
              }
            : { kind: payload.kind, quantity: payload.amount, reason: payload.reason },
        );
        setAdjustOpen(false);
        setNotice(
          stockAdjustmentNotice(
            {
              kind: payload.kind,
              itemName: article.item_name,
              amount: payload.amount,
              confirmedTotalBefore:
                payload.kind === "inventory" ? article.stock_total : null,
              totalAfter: snapshot.stock_total,
              availableAfter: snapshot.stock_available,
            },
            de,
          ),
        );
        await load();
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        // A 409 means the shelf moved while this dialog was open, so the total
        // it is showing — and the `expected_total` the next save would send —
        // are the ones the server has just called stale. Without the refetch
        // every retry re-sends that same figure and collects the same refusal,
        // with no way out of the dialog. Same handling as the desktop Bestand
        // page; `staleStockMessage` drops the server's "reopen the dialog",
        // which is not what happens here.
        const stale = err instanceof ApiError && err.status === 409;
        setActionError(stale ? staleStockMessage(detail, de) : detail);
        if (stale) await load();
      } finally {
        setSaving(false);
      }
    },
    [article, saving, token, de, setNotice, load],
  );

  if (!active) return null;

  const goBack = () => {
    setActiveWerkstattArticleId(null);
    setWerkstattTab("dashboard");
  };

  if (loadError) {
    return (
      <section
        className="werkstatt-mobile werkstatt-mobile--artikel"
        aria-label={de ? "Artikel-Detail" : "Article detail"}
      >
        <div className="werkstatt-mobile-state werkstatt-mobile-state--page" role="alert">
          <b>{de ? "Artikel konnte nicht geladen werden" : "Could not load the article"}</b>
          <small>{loadError}</small>
          <button
            type="button"
            className="werkstatt-mobile-state-retry"
            onClick={() => void load()}
            disabled={loading}
          >
            {de ? "Erneut versuchen" : "Try again"}
          </button>
          <button type="button" className="werkstatt-mobile-state-back" onClick={goBack}>
            {de ? "Zurück zur Übersicht" : "Back to the overview"}
          </button>
        </div>
      </section>
    );
  }

  if (!article) {
    return (
      <section
        className="werkstatt-mobile werkstatt-mobile--artikel"
        aria-label={de ? "Artikel-Detail" : "Article detail"}
      >
        <div className="werkstatt-mobile-state werkstatt-mobile-state--page" role="status">
          <b>{de ? "Artikel wird geladen…" : "Loading the article…"}</b>
        </div>
      </section>
    );
  }

  const canCheckOut = !article.is_archived && article.stock_available > 0 && !saving;

  /**
   * Why "Zurückgeben" is off, or null when it is on.
   *
   * The condition used to be `article.stock_out !== 0` — whether ANYONE has
   * this article out — which offered the action to somebody holding none of
   * it and then seeded the sheet with the team's quantity. A disabled item
   * with no reason is its own dead end, so the reason rides on the label.
   */
  const returnBlockedReason = myCheckoutsError
    ? de
      ? "Entnahmen nicht geladen"
      : "checkouts not loaded"
    : myCheckouts === null
      ? de
        ? "wird geprüft…"
        : "checking…"
      : myOut === 0
        ? de
          ? "nichts auf deinen Namen"
          : "nothing under your name"
        : null;
  const primaryLabel = article.is_archived
    ? de
      ? "Artikel archiviert"
      : "Article archived"
    : article.stock_available === 0
      ? de
        ? "Nichts verfügbar"
        : "Nothing available"
      : de
        ? "Entnehmen"
        : "Check out";

  return (
    <section
      className="werkstatt-mobile werkstatt-mobile--artikel"
      aria-label={de ? "Artikel-Detail" : "Article detail"}
    >
      <header className="werkstatt-mobile-artikel-top">
        <button
          type="button"
          className="werkstatt-mobile-icon-btn"
          onClick={goBack}
          aria-label={de ? "Zurück" : "Back"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M15.5 5.5 8.5 12l7 6.5"
              stroke="#14293D"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="werkstatt-mobile-artikel-topcenter">
          <span className="werkstatt-mobile-artikel-eyebrow">
            {de ? "ARTIKEL-DETAIL" : "ARTICLE DETAIL"}
          </span>
          <span className="werkstatt-mobile-artikel-topnumber">
            {article.article_number}
          </span>
        </div>
        <KebabMenu
          ariaLabel={de ? "Weitere Aktionen" : "More actions"}
          buttonClassName="werkstatt-mobile-icon-btn"
          items={[
            {
              key: "return",
              label: `${de ? "Zurückgeben" : "Return"}${
                returnBlockedReason ? ` — ${returnBlockedReason}` : ""
              }`,
              disabled: returnBlockedReason !== null || saving,
              onSelect: () => {
                setActionError(null);
                setReturnOpen(true);
              },
            },
            ...(canManageStock
              ? [
                  {
                    key: "adjust",
                    label: de ? "Bestand anpassen" : "Adjust stock",
                    disabled: saving,
                    onSelect: () => {
                      setActionError(null);
                      setAdjustOpen(true);
                    },
                  },
                ]
              : []),
            {
              key: "refresh",
              label: de ? "Aktualisieren" : "Refresh",
              disabled: loading,
              onSelect: () => void load(),
            },
          ]}
        />
      </header>

      {/* Outside the body: the hero is a full-bleed band, and the body pads. */}
      <MobileArtikelHero article={article} de={de} />

      <div className="werkstatt-mobile-artikel-body">
        {article.is_archived && (
          <p className="werkstatt-mobile-note werkstatt-mobile-note--error">
            {de
              ? "Dieser Artikel ist archiviert — Buchungen werden abgelehnt."
              : "This article is archived — bookings are refused."}
          </p>
        )}

        <MobileArtikelBestand article={article} de={de} />

        <MobileArtikelMovements
          movements={movements}
          error={movementsError}
          windowSize={MY_MOVEMENTS_WINDOW}
          de={de}
          onRetry={() => void load()}
        />
      </div>

      {/* Only when no dialog is up: each dialog shows the same message itself,
          and two role="alert" nodes announce the refusal twice. */}
      {actionError && !checkoutOpen && !returnOpen && !adjustOpen && (
        <p className="werkstatt-mobile-note werkstatt-mobile-note--error" role="alert">
          {actionError}
        </p>
      )}

      <footer className="werkstatt-mobile-artikel-footer">
        <button
          type="button"
          className="werkstatt-mobile-artikel-back"
          onClick={goBack}
          aria-label={de ? "Zurück" : "Back"}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M19 12H5M11 18l-6-6 6-6"
              stroke="#5C7895"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="werkstatt-mobile-artikel-primary"
          disabled={!canCheckOut}
          onClick={() => {
            setActionError(null);
            setCheckoutOpen(true);
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="#FFFFFF"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{primaryLabel}</span>
        </button>
      </footer>

      {/* Mounted only while open. Both dialogs seed their fields from the
          counters they were handed; kept mounted, a second checkout would open
          on the numbers from before the first one. */}
      {checkoutOpen && (
        <EntnehmenModal
          open
          onClose={() => {
            setCheckoutOpen(false);
            setActionError(null);
          }}
          language={language}
          article={{
            item_name: article.item_name,
            article_number: article.article_number,
            location_name: article.location_name,
            stock_available: article.stock_available,
            stock_total: article.stock_total,
          }}
          projects={projects.map((project) => ({
            id: String(project.id),
            number: project.project_number,
            title: project.name,
          }))}
          submitting={saving}
          error={actionError}
          onConfirm={(payload) => void confirmCheckout(payload)}
        />
      )}

      {returnOpen && (
        <MobileReturnSheet
          open
          onClose={() => {
            setReturnOpen(false);
            setActionError(null);
          }}
          language={language}
          item={{
            article_name: article.item_name,
            article_number: article.article_number,
            unit: article.unit,
          }}
          targets={myTargets}
          submitting={saving}
          error={actionError}
          onConfirm={(payload) => void confirmReturn(payload)}
        />
      )}

      {adjustOpen && (
        <BestandAnpassenModal
          open
          language={language}
          article={{
            item_name: article.item_name,
            article_number: article.article_number,
            category_name: article.category_name,
            stock_total: article.stock_total,
            stock_available: article.stock_available,
            unit: article.unit,
          }}
          submitting={saving}
          error={actionError}
          onClose={() => {
            setAdjustOpen(false);
            setActionError(null);
          }}
          onConfirm={(payload) => void confirmAdjust(payload)}
        />
      )}
    </section>
  );
}
