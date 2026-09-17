import {
  movementFamily,
  movementSubtitle,
  movementTitle,
} from "./mobileLabels";
import type { WerkstattMovement } from "../../../types/werkstatt";

/**
 * MobileArtikelMovements — the ledger card on the phone's article screen.
 *
 * Two qualifiers, both load-bearing, because the request answers less than the
 * card would otherwise appear to claim:
 *
 *   WHOSE — `GET /werkstatt/mobile/movements` answers with the CALLER's
 *     movements (`?all=true` needs `werkstatt:manage`), so the heading says
 *     "Meine letzten Bewegungen". The previous fixture said "Letzte Bewegungen
 *     · 128 gesamt" over invented rows.
 *   HOW FAR BACK — the endpoint is not article-scoped either. It answers the
 *     caller's newest `windowSize` movements across ALL articles, and the page
 *     filters those down to this one. A storeman who books sixty movements in
 *     a shift can therefore hold an item whose checkout has already dropped
 *     out of the window.
 *
 * So the empty state is worded as a window and not as a fact. "Zu diesem
 * Artikel ist nichts auf deinen Namen gebucht" was a flat negative the request
 * cannot support, and it looked exactly like the true empty state. The real
 * fix is an article-scoped endpoint (see the handoff note); until it exists
 * the wording has to carry the caveat.
 *
 * Presentational — the host page owns the fetch and passes the outcome:
 *   null + no error → still loading
 *   error           → the load failed, say so and offer the retry
 *   []              → loaded, and nothing for this article is IN THE WINDOW
 */
export interface MobileArtikelMovementsProps {
  movements: ReadonlyArray<WerkstattMovement> | null;
  error: string | null;
  /** How many of the caller's movements the request looked at. */
  windowSize: number;
  de: boolean;
  onRetry: () => void;
}

/** Icons per family — drawn inline so the list has no image dependency. */
function familyIcon(family: "checkout" | "return" | "inspection") {
  if (family === "checkout") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path
          d="M5 12h14M13 6l6 6-6 6"
          stroke="#A4171C"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (family === "return") {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path
          d="M19 12H5M11 18l-6-6 6-6"
          stroke="#0E6F45"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="m5 12 5 5 9-10"
        stroke="#1E4E82"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "1 Eintrag" / "3 Einträge" — a German plural the workshop reads all day. */
function countLabel(count: number, de: boolean): string {
  if (de) return count === 1 ? "1 Eintrag" : `${count} Einträge`;
  return count === 1 ? "1 entry" : `${count} entries`;
}

export function MobileArtikelMovements({
  movements,
  error,
  windowSize,
  de,
  onRetry,
}: MobileArtikelMovementsProps) {
  return (
    <section className="werkstatt-mobile-artikel-movements">
      <header className="werkstatt-mobile-artikel-movements-head">
        <div className="werkstatt-mobile-artikel-movements-heading">
          <h3 className="werkstatt-mobile-artikel-movements-title">
            {de ? "Meine letzten Bewegungen" : "My recent movements"}
          </h3>
          {/* The count is post-filter and post-truncation, so it is captioned
              rather than left to look like this article's total. */}
          <span className="werkstatt-mobile-artikel-movements-window">
            {de
              ? `aus deinen letzten ${windowSize} Buchungen`
              : `from your last ${windowSize} bookings`}
          </span>
        </div>
        <span className="werkstatt-mobile-artikel-movements-count">
          {movements === null ? "" : countLabel(movements.length, de)}
        </span>
      </header>

      {error ? (
        <div className="werkstatt-mobile-state werkstatt-mobile-state--error" role="alert">
          <b>
            {de
              ? "Bewegungen konnten nicht geladen werden"
              : "Could not load the movements"}
          </b>
          <small>{error}</small>
          <button type="button" className="werkstatt-mobile-state-retry" onClick={onRetry}>
            {de ? "Erneut versuchen" : "Try again"}
          </button>
        </div>
      ) : movements === null ? (
        <div className="werkstatt-mobile-state" role="status">
          <b>{de ? "Wird geladen…" : "Loading…"}</b>
        </div>
      ) : movements.length === 0 ? (
        <div className="werkstatt-mobile-state">
          <b>
            {de
              ? "Nichts in diesem Ausschnitt"
              : "Nothing in this window"}
          </b>
          <small>
            {de
              ? `In deinen letzten ${windowSize} Buchungen ist zu diesem Artikel nichts dabei — ältere können darunter fehlen.`
              : `Nothing for this item in your last ${windowSize} bookings — older ones may be missing.`}
          </small>
        </div>
      ) : (
        <ul className="werkstatt-mobile-artikel-movements-list">
          {movements.map((movement) => {
            const family = movementFamily(movement.movement_type);
            return (
              <li
                key={movement.id}
                className={`werkstatt-mobile-artikel-movement werkstatt-mobile-artikel-movement--${family}`}
              >
                <span className="werkstatt-mobile-artikel-movement-dot" aria-hidden="true">
                  {familyIcon(family)}
                </span>
                <span className="werkstatt-mobile-artikel-movement-text">
                  <span className="werkstatt-mobile-artikel-movement-title">
                    {movementTitle(movement.movement_type, de)}
                  </span>
                  <span className="werkstatt-mobile-artikel-movement-subtitle">
                    {movementSubtitle(movement, de)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
