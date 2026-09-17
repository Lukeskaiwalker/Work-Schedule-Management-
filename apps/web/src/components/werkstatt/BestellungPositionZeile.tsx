/**
 * BestellungPositionZeile — one line of an order, with its send status.
 *
 * The badge answers the question the resolver used to answer only AFTER the
 * buyer pressed "Im Shop bestellen": will the supplier receive this line, and
 * under which number? Green when the number is known, amber when it was
 * derived (from the EAN, from a catalogue lookup, or with several rows in
 * the running), red when the position would be dropped from the basket.
 *
 * The red badge is a button. Clicking it opens an inline field for the
 * supplier's article number, because the warning's advice — "bitte die
 * Lieferanten-Artikelnummer am Artikel hinterlegen" — was previously
 * impossible to follow without leaving the order. The page writes the number
 * onto the line AND onto the article↔supplier link, so the next order for
 * the same article resolves without asking.
 */
import { useState } from "react";

import type { WerkstattOrderLine } from "../../types/werkstatt";
import type {
  OrderLineResolution,
  OrderResolutionAlternative,
} from "../../types/werkstattProcurement";
import { formatMoney } from "./orderPresentation";

export type ResolutionTone = "ok" | "warn" | "missing";

/** Which badge a line gets. Exported so the badge test can pin the mapping. */
export function resolutionTone(resolution: OrderLineResolution): ResolutionTone {
  if (!resolution.is_resolved) return "missing";
  if (
    resolution.warning ||
    resolution.ambiguous_alternatives > 0 ||
    resolution.matched_by === "catalog_ean" ||
    resolution.matched_by === "catalog_article_no" ||
    resolution.matched_by === "supplier_lookup"
  ) {
    return "warn";
  }
  return "ok";
}

/**
 * The badge text. A red badge is always the short label — the server's full
 * sentence ("Position 2 (NYY-J 5x6) hat keine Lieferanten-Artikelnummer und
 * kann nicht an den Shop übergeben werden") is the tooltip, see
 * `resolutionTitle`, so a line does not grow a two-line badge.
 */
export function resolutionText(resolution: OrderLineResolution, de: boolean): string {
  const tone = resolutionTone(resolution);
  if (tone === "missing") {
    return de ? "Keine Lieferanten-Nr. — wird nicht übergeben" : "No supplier no. — will not be sent";
  }
  const number = resolution.will_send ?? resolution.supplier_article_no ?? "";
  if (tone === "ok") {
    const source =
      resolution.matched_by === "supplier_link"
        ? de
          ? "Artikel"
          : "article"
        : de
          ? "Position"
          : "line";
    return `${de ? "Lieferanten-Nr." : "Supplier no."} ${number} (${source})`;
  }
  const parts: string[] = [];
  if (resolution.matched_by === "catalog_ean") {
    parts.push(de ? `aus EAN aufgelöst: ${number}` : `resolved from EAN: ${number}`);
  } else if (resolution.matched_by === "catalog_article_no") {
    parts.push(de ? `aus Katalog aufgelöst: ${number}` : `resolved from catalogue: ${number}`);
  } else if (resolution.matched_by === "supplier_lookup") {
    parts.push(de ? `vom Lieferanten: ${number}` : `from supplier: ${number}`);
  } else {
    parts.push(`${de ? "Lieferanten-Nr." : "Supplier no."} ${number}`);
  }
  if (resolution.ambiguous_alternatives > 0) {
    parts.push(
      de
        ? `${resolution.ambiguous_alternatives} weitere Treffer`
        : `${resolution.ambiguous_alternatives} more matches`,
    );
  }
  if (resolution.warning) parts.push(resolution.warning);
  return parts.join(" · ");
}

/** The tooltip: the server's full sentence, plus what clicking does on a red badge. */
export function resolutionTitle(
  resolution: OrderLineResolution,
  de: boolean,
  editable: boolean,
): string | undefined {
  const hint =
    resolutionTone(resolution) === "missing" && editable
      ? de
        ? "Lieferanten-Artikelnummer eintragen"
        : "Enter the supplier's article number"
      : null;
  return [resolution.warning, hint].filter(Boolean).join(" — ") || undefined;
}

export interface BestellungPositionZeileProps {
  line: WerkstattOrderLine;
  /** Null while the resolution is still loading; no badge is shown then. */
  resolution: OrderLineResolution | null;
  de: boolean;
  editable: boolean;
  busy: boolean;
  onUpdateQuantity: (lineId: number, quantity: number) => void;
  onDelete: (lineId: number) => void;
  /** The buyer typed the supplier's number for this line. */
  onSetSupplierNo: (line: WerkstattOrderLine, supplierArticleNo: string) => void;
  /** The buyer chose one of the other catalogue rows. */
  onPickAlternative: (line: WerkstattOrderLine, alternative: OrderResolutionAlternative) => void;
}

export function BestellungPositionZeile({
  line,
  resolution,
  de,
  editable,
  busy,
  onUpdateQuantity,
  onDelete,
  onSetSupplierNo,
  onPickAlternative,
}: BestellungPositionZeileProps) {
  const [entering, setEntering] = useState(false);
  const [number, setNumber] = useState("");

  const tone = resolution ? resolutionTone(resolution) : null;

  function commitNumber() {
    const value = number.trim();
    if (!value) return;
    onSetSupplierNo(line, value);
    setNumber("");
    setEntering(false);
  }

  return (
    <li className="werkstatt-orders-drawer-line">
      <div className="werkstatt-orders-drawer-line-main">
        <b>{line.article_name}</b>
        <small>
          {[
            line.article_number,
            line.manufacturer,
            line.ean ? `EAN ${line.ean}` : null,
            // The badge answers "will this move stock?" — see the drawer header.
            line.is_stocked ? null : de ? "Freiposition" : "Free item",
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
        {line.notes && <small className="werkstatt-orders-drawer-line-note">{line.notes}</small>}

        {resolution && tone === "missing" && editable ? (
          <button
            type="button"
            className="werkstatt-orders-resolution werkstatt-orders-resolution--missing"
            onClick={() => setEntering((open) => !open)}
            aria-expanded={entering}
            title={resolutionTitle(resolution, de, editable)}
          >
            {resolutionText(resolution, de)}
          </button>
        ) : (
          resolution && (
            <span
              className={`werkstatt-orders-resolution werkstatt-orders-resolution--${tone}`}
              title={resolutionTitle(resolution, de, editable)}
            >
              {resolutionText(resolution, de)}
            </span>
          )
        )}

        {resolution && resolution.alternatives.length > 0 && editable && (
          <ul
            className="werkstatt-orders-resolution-alternatives"
            aria-label={de ? "Weitere Katalog-Treffer" : "Other catalogue matches"}
          >
            {resolution.alternatives.map((alternative) => (
              <li key={alternative.catalog_item_id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPickAlternative(line, alternative)}
                  title={alternative.item_name}
                >
                  {alternative.article_no ?? "?"} · {alternative.item_name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {entering && editable && (
          <div className="werkstatt-orders-number-entry">
            <input
              className="werkstatt-field-input"
              autoFocus
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitNumber();
                if (event.key === "Escape") setEntering(false);
              }}
              placeholder={de ? "Lieferanten-Artikelnummer" : "Supplier article no."}
              aria-label={
                de
                  ? `Lieferanten-Artikelnummer für ${line.article_name}`
                  : `Supplier article no. for ${line.article_name}`
              }
            />
            <button
              type="button"
              className="werkstatt-action-btn"
              disabled={busy || !number.trim()}
              onClick={commitNumber}
            >
              {de ? "Eintragen" : "Save"}
            </button>
          </div>
        )}
      </div>

      <div className="werkstatt-orders-drawer-line-qty">
        {editable ? (
          <input
            type="number"
            min={1}
            className="werkstatt-field-input werkstatt-orders-qty-input"
            value={line.quantity_ordered}
            aria-label={de ? "Menge" : "Quantity"}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isFinite(next) && next >= 1) {
                onUpdateQuantity(line.id, Math.floor(next));
              }
            }}
          />
        ) : (
          <span>
            {line.quantity_received} / {line.quantity_ordered}
          </span>
        )}
        <small>
          {formatMoney(line.unit_price_cents, line.currency)}
          {line.unit ? ` / ${line.unit}` : ""}
        </small>
      </div>

      {editable && (
        <button
          type="button"
          className="werkstatt-orders-line-remove"
          onClick={() => onDelete(line.id)}
          aria-label={de ? `${line.article_name} entfernen` : `Remove ${line.article_name}`}
        >
          ✕
        </button>
      )}
    </li>
  );
}
