/**
 * What happened to one supplier's reorder, said plainly.
 *
 * Shared by the desktop and the phone reorder screen so the four outcomes of
 * `POST /werkstatt/reorder/submit` read the same on both:
 *
 *   sending  — in flight.
 *   conflict — 409 `unresolved_lines`. NOTHING was created: the server refuses
 *              to send a basket it cannot fully number. The positions are
 *              named (not just counted) and "Trotzdem übergeben" re-submits
 *              with `allow_unresolved`, the same override the Bestellungen
 *              drawer offers in `BestellungVersandLeiste`.
 *   sent     — the order exists and is `sent`; its number is the receipt.
 *              After a reload of the list it is shown as "bereits bestellt",
 *              because the same shortfall is suggested again until the goods
 *              arrive and the order number is the only thing that knows.
 *   error    — anything else, in the server's own words, and split by whether
 *              the server actually ANSWERED. "Es wurde nichts versendet" is a
 *              claim about a rollback that only a real HTTP status supports;
 *              a dropped connection leaves the outcome unknown (the endpoint
 *              commits before it replies), so that case says so and sends the
 *              buyer to Werkstatt › Bestellungen instead of offering a retry
 *              that would order the same shortfall twice.
 *
 * Nothing here ever reports success on its own: every line of it is rendered
 * from the state the request actually produced.
 */
import type { ReorderSendState } from "../../hooks/useReorderBasket";
import { unresolvedPositions } from "../../utils/reorderBasket";
import type { ReorderSuggestionGroup } from "../../utils/werkstattReorderApi";

export interface ReorderExportAction {
  onExport: () => void;
  busy: boolean;
  /** What the download did, once it did it. */
  notice: string | null;
  error: string | null;
}

export interface ReorderSendPanelProps {
  group: ReorderSuggestionGroup;
  state: ReorderSendState;
  de: boolean;
  busy: boolean;
  onOverride: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  /** Open Werkstatt › Bestellungen — where an uncertain outcome is settled. */
  onOpenOrders?: () => void;
  /** Desktop only: the created order's CSV. Omitted on the phone. */
  exportAction?: ReorderExportAction;
}

export function ReorderSendPanel({
  group,
  state,
  de,
  busy,
  onOverride,
  onRetry,
  onDismiss,
  onOpenOrders,
  exportAction,
}: ReorderSendPanelProps) {
  if (state.kind === "sending") {
    return (
      <div className="reorder-send-panel reorder-send-panel--busy" role="status">
        {de ? "Bestellung wird übergeben…" : "Submitting the order…"}
      </div>
    );
  }

  if (state.kind === "conflict") {
    const positions = unresolvedPositions(
      group,
      state.submittedArticleIds,
      state.detail.unresolved_positions,
    );
    return (
      <div className="reorder-send-panel reorder-send-panel--conflict" role="alert">
        <b>{state.detail.message}</b>
        <p className="reorder-send-panel-text">
          {de
            ? "Es wurde nichts bestellt und nichts versendet. Ohne Lieferanten-Artikelnummer kann der Lieferant diese Positionen nicht zuordnen — besser zuerst die Nummer am Artikel hinterlegen."
            : "Nothing was ordered and nothing was sent. Without a supplier article number the supplier cannot identify these positions — better to enter the number on the article first."}
        </p>
        {positions.length > 0 && (
          <ul className="reorder-send-panel-list">
            {positions.map((entry) => (
              <li key={entry.position}>
                {de ? "Pos." : "Item"} {entry.position}
                {entry.articleName ? ` · ${entry.articleName}` : ""}
                {entry.articleNumber ? ` (${entry.articleNumber})` : ""}
              </li>
            ))}
          </ul>
        )}
        {state.detail.warnings.length > 0 && (
          <ul className="reorder-send-panel-list reorder-send-panel-list--muted">
            {state.detail.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <div className="reorder-send-panel-actions">
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={busy}
            onClick={onOverride}
          >
            {de ? "Trotzdem übergeben" : "Send anyway"}
          </button>
          <button type="button" className="werkstatt-action-btn" onClick={onDismiss}>
            {de ? "Zurück" : "Back"}
          </button>
        </div>
      </div>
    );
  }

  // No answer arrived, so nobody knows whether the order exists. The one
  // thing this panel must NOT do is offer a bare "Erneut versuchen": the
  // endpoint commits before it replies, and a second click would be a second
  // real purchase order at the supplier.
  if (state.kind === "error" && state.outcome === "unknown") {
    return (
      <div className="reorder-send-panel reorder-send-panel--unknown" role="alert">
        <b>
          {de
            ? "Verbindung abgebrochen — Ergebnis unklar"
            : "Connection lost — outcome unknown"}
        </b>
        <p className="reorder-send-panel-text">{state.message}</p>
        <p className="reorder-send-panel-text">
          {de
            ? "Die Verbindung brach ab, bevor der Server geantwortet hat — ob die Bestellung angelegt und versendet wurde, ist unklar. Bitte zuerst unter Werkstatt › Bestellungen nachsehen."
            : "The connection dropped before the server answered — whether the order was created and sent is unclear. Please check under Werkstatt › Bestellungen first."}
        </p>
        <p className="reorder-send-panel-text">
          {de
            ? "Erst „Schließen“ gibt den Bestell-Knopf wieder frei; ein zweiter Versuch legt sonst womöglich eine zweite Bestellung an."
            : "Only “Dismiss” releases the order button again; a second attempt may otherwise create a second order."}
        </p>
        <div className="reorder-send-panel-actions">
          {onOpenOrders && (
            <button type="button" className="werkstatt-action-btn" onClick={onOpenOrders}>
              {de ? "Zu den Bestellungen" : "Go to orders"}
            </button>
          )}
          <button type="button" className="werkstatt-action-btn" onClick={onDismiss}>
            {de ? "Schließen" : "Dismiss"}
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="reorder-send-panel reorder-send-panel--error" role="alert">
        <b>{de ? "Bestellung fehlgeschlagen" : "Order failed"}</b>
        <p className="reorder-send-panel-text">{state.message}</p>
        <p className="reorder-send-panel-text">
          {/* Safe to claim only because the server answered: the submit
              endpoint rolls the whole transaction back on an HTTPException. */}
          {de
            ? "Es wurde nichts versendet. Bitte erneut versuchen."
            : "Nothing was sent. Please try again."}
        </p>
        <div className="reorder-send-panel-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={busy}
            onClick={onRetry}
          >
            {de ? "Erneut versuchen" : "Try again"}
          </button>
          <button type="button" className="werkstatt-action-btn" onClick={onDismiss}>
            {de ? "Schließen" : "Dismiss"}
          </button>
        </div>
      </div>
    );
  }

  const { order, allowUnresolved, carriedOver } = state;
  return (
    <div className="reorder-send-panel reorder-send-panel--sent" role="status">
      <b>
        {carriedOver
          ? de
            ? `Bereits bestellt: ${order.order_number}`
            : `Already ordered: ${order.order_number}`
          : de
            ? `Bestellung ${order.order_number} versendet`
            : `Order ${order.order_number} submitted`}
      </b>
      <p className="reorder-send-panel-text">
        {de
          ? `${order.line_count} ${order.line_count === 1 ? "Position" : "Positionen"} an ${order.supplier_name}. Weiter unter Werkstatt › Bestellungen.`
          : `${order.line_count} ${order.line_count === 1 ? "line" : "lines"} to ${order.supplier_name}. Continue under Werkstatt › Bestellungen.`}
      </p>
      {carriedOver && (
        <p className="reorder-send-panel-text">
          {/* The list was re-read and suggests the same shortfall again: the
              engine looks at stock only and knows nothing about open orders. */}
          {de
            ? "Die Liste wurde neu geladen — die Artikel stehen noch unter Mindestbestand, weil die Ware noch nicht da ist. Erneut bestellen legt eine ZWEITE Bestellung an; dafür zuerst „Schließen“."
            : "The list was reloaded — these articles are still below minimum because the goods have not arrived. Ordering again creates a SECOND order; dismiss this first if that is what you want."}
        </p>
      )}
      {allowUnresolved && (
        <p className="reorder-send-panel-text reorder-send-panel-text--warn">
          {de
            ? "Übergeben ohne vollständige Lieferanten-Artikelnummern — bitte beim Lieferanten gegenprüfen."
            : "Sent without complete supplier article numbers — please double-check with the supplier."}
        </p>
      )}
      {exportAction && (
        <div className="reorder-send-panel-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={exportAction.busy}
            onClick={exportAction.onExport}
          >
            {exportAction.busy
              ? de
                ? "CSV wird erstellt…"
                : "Building CSV…"
              : de
                ? "CSV herunterladen"
                : "Download CSV"}
          </button>
        </div>
      )}
      {exportAction?.notice && (
        <p className="reorder-send-panel-text">{exportAction.notice}</p>
      )}
      {exportAction?.error && (
        <p className="reorder-send-panel-text reorder-send-panel-text--warn" role="alert">
          {exportAction.error}
        </p>
      )}
      {carriedOver && (
        <div className="reorder-send-panel-actions">
          <button type="button" className="werkstatt-action-btn" onClick={onDismiss}>
            {de ? "Schließen" : "Dismiss"}
          </button>
        </div>
      )}
    </div>
  );
}
