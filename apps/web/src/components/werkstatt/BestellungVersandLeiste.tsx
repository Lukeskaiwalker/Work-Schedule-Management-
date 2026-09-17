/**
 * BestellungVersandLeiste — how an order leaves the building.
 *
 * Two hand-over routes, chosen by the supplier's channel:
 *
 *   Shop   — "Im Shop bestellen" fills the wholesaler's basket (IDS). Offered
 *            only when the supplier has an enabled connection.
 *   Export — "Bestellung exportieren" for everyone else: a CSV download, or
 *            the article numbers copied to the clipboard for a shop's
 *            quick-order box. Also offered beside the shop button, because a
 *            buyer who wants the list on paper has that right regardless.
 *
 * Both routes refuse (409) while a line has no supplier number — the short
 * basket the resolver exists to prevent. The refusal renders here as a list
 * of the affected positions with "Trotzdem übergeben", which re-runs the same
 * route with the override. The gate is the server's, and the click must be
 * able to reach it: the shop button stays enabled while a line is red and
 * only its title says what will happen. Greying it out looked safer but made
 * the override unreachable — the 409 that mounts the panel was never raised,
 * and a buyer who accepts a short basket (a free line nobody can number) had
 * to delete the line or leave the shop route entirely.
 */
import { useEffect, useRef, useState } from "react";

import type { WerkstattOrder } from "../../types/werkstatt";
import type { OrderResolution, UnresolvedLinesConflict } from "../../types/werkstattProcurement";

export type ExportKind = "csv" | "text";
export type SendRoute = { kind: "shop" } | { kind: "export"; format: ExportKind };

export interface SendConflict {
  route: SendRoute;
  detail: UnresolvedLinesConflict;
}

export interface BestellungVersandLeisteProps {
  order: WerkstattOrder;
  de: boolean;
  canManage: boolean;
  busy: boolean;
  resolution: OrderResolution | null;
  conflict: SendConflict | null;
  onSend: (route: SendRoute, allowUnresolved: boolean) => void;
  onDismissConflict: () => void;
  onMarkSent: () => void;
  onMarkDelivered: () => void;
  onCancel: () => void;
}

export function BestellungVersandLeiste({
  order,
  de,
  canManage,
  busy,
  resolution,
  conflict,
  onSend,
  onDismissConflict,
  onMarkSent,
  onMarkDelivered,
  onCancel,
}: BestellungVersandLeisteProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Close the export menu on an outside click — it floats over the footer
  // and would otherwise stay open across every other button press.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const isDraft = order.status === "draft";
  const hasLines = order.lines.length > 0;
  const missingCount = resolution ? resolution.line_count - resolution.ready_count : 0;
  // Export stays available for a sent order — re-downloading the list is
  // bookkeeping — but the shop hand-over is a draft-only act.
  const canExport = canManage && hasLines && !order.is_template && order.status !== "cancelled";

  return (
    <>
      {conflict && (
        <div className="werkstatt-orders-send-conflict" role="alert">
          <b>{conflict.detail.message}</b>
          {conflict.detail.warnings.length > 0 && (
            <ul>
              {conflict.detail.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <span>
            {de
              ? "Diese Positionen fehlen im Warenkorb, wenn trotzdem übergeben wird. Besser: die Lieferanten-Artikelnummer oben eintragen."
              : "These positions will be missing from the basket if you send anyway. Better: enter the supplier article number above."}
          </span>
          <div className="werkstatt-orders-send-conflict-actions">
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              disabled={busy}
              onClick={() => onSend(conflict.route, true)}
            >
              {de ? "Trotzdem übergeben" : "Send anyway"}
            </button>
            <button type="button" className="werkstatt-action-btn" onClick={onDismissConflict}>
              {de ? "Zurück" : "Back"}
            </button>
          </div>
        </div>
      )}

      {order.supplier_has_shop && isDraft && canManage && (
        <button
          type="button"
          className="werkstatt-action-btn"
          disabled={busy || !hasLines}
          onClick={() => onSend({ kind: "shop" }, false)}
          title={
            missingCount > 0
              ? de
                ? `${missingCount} Position(en) ohne Lieferanten-Artikelnummer — bitte oben eintragen; der Shop erhält sie sonst nicht`
                : `${missingCount} line(s) without a supplier article number — enter them above; the shop will not receive them otherwise`
              : de
                ? "Öffnet den Warenkorb im Shop. Bestellt wird dort — mit den Preisen und Beständen des Lieferanten."
                : "Fills the basket in the shop. You order there, under the supplier's prices and stock."
          }
        >
          {de ? "Im Shop bestellen" : "Order in shop"}
        </button>
      )}

      {canExport && (
        <div className="werkstatt-orders-export" ref={menuRef}>
          <button
            type="button"
            className={`werkstatt-action-btn${
              !order.supplier_has_shop && isDraft ? " werkstatt-action-btn--primary" : ""
            }`}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {de ? "Bestellung exportieren" : "Export order"}
          </button>
          {menuOpen && (
            <div className="werkstatt-orders-export-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onSend({ kind: "export", format: "csv" }, false);
                }}
              >
                {de ? "CSV herunterladen" : "Download CSV"}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onSend({ kind: "export", format: "text" }, false);
                }}
              >
                {de ? "Artikelnummern kopieren" : "Copy article numbers"}
              </button>
            </div>
          )}
        </div>
      )}

      {canManage && isDraft && (
        <button type="button" className="werkstatt-action-btn" onClick={onCancel}>
          {de ? "Stornieren" : "Cancel order"}
        </button>
      )}
      {canManage && (
        <button
          type="button"
          className="werkstatt-action-btn"
          disabled={!isDraft || busy}
          onClick={onMarkSent}
        >
          {de ? "Als versendet markieren" : "Mark as sent"}
        </button>
      )}
      {canManage && (
        <button
          type="button"
          className="werkstatt-action-btn werkstatt-action-btn--primary"
          disabled={busy || !["sent", "confirmed", "partially_delivered"].includes(order.status)}
          onClick={onMarkDelivered}
        >
          {de ? "Als geliefert markieren" : "Mark as delivered"}
        </button>
      )}
    </>
  );
}
