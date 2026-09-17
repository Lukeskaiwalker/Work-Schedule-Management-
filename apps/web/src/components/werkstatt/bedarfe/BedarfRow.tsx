import { useEffect, useState } from "react";
import type { Language, MaterialNeedStatus } from "../../../types";
import type { MaterialNeedPatch, MaterialNeedRow } from "../../../types/materialNeeds";
import { formatDayLabel } from "../../../utils/dates";
import {
  MATERIAL_NEED_STATUSES,
  materialNeedStatusClass,
  materialNeedStatusLabel,
  normalizeMaterialNeedStatus,
} from "../../../utils/materials";
import { KebabMenu } from "../KebabMenu";

/**
 * One need, editable where it stands.
 *
 * Everything on this row used to require either a trip to another screen or a
 * status pill cycled until it happened to land on the right value: the
 * quantity, the unit and the text could not be corrected at all, and
 * "Erledigt" was only reachable from "Verfügbar". So: text and quantity edit
 * in place (Enter commits, Escape reverts, blur commits), the status is a
 * select with every rung on it, and "Erledigt" is one button on every
 * unfinished row.
 *
 * The row never writes to its own copy of the data — it calls up with a patch
 * and re-renders from whatever the server returned.
 */
export interface BedarfRowProps {
  row: MaterialNeedRow;
  language: Language;
  selected: boolean;
  busy: boolean;
  onToggleSelect: (id: number, extend: boolean) => void;
  onPatch: (id: number, patch: MaterialNeedPatch) => void;
  onDelete: (row: MaterialNeedRow) => void;
  onLinkCatalog: (row: MaterialNeedRow) => void;
  onOpenOrder: (row: MaterialNeedRow) => void;
}

type EditField = "item" | "quantity" | "notes" | null;

export function BedarfRow({
  row,
  language,
  selected,
  busy,
  onToggleSelect,
  onPatch,
  onDelete,
  onLinkCatalog,
  onOpenOrder,
}: BedarfRowProps) {
  const de = language === "de";
  const status = normalizeMaterialNeedStatus(row.status);
  const [editing, setEditing] = useState<EditField>(null);
  const [draftItem, setDraftItem] = useState(row.item);
  const [draftQuantity, setDraftQuantity] = useState(row.quantity ?? "");
  const [draftUnit, setDraftUnit] = useState(row.unit ?? "");
  const [draftNotes, setDraftNotes] = useState(row.notes ?? "");

  // A row replaced by a server response must not keep a stale draft on screen.
  useEffect(() => {
    setDraftItem(row.item);
    setDraftQuantity(row.quantity ?? "");
    setDraftUnit(row.unit ?? "");
    setDraftNotes(row.notes ?? "");
  }, [row.item, row.quantity, row.unit, row.notes]);

  function commitItem() {
    setEditing(null);
    const next = draftItem.trim();
    if (!next || next === row.item) {
      setDraftItem(row.item);
      return;
    }
    onPatch(row.id, { item: next });
  }

  function commitQuantity() {
    setEditing(null);
    const quantity = draftQuantity.trim();
    const unit = draftUnit.trim();
    const patch: MaterialNeedPatch = {};
    if (quantity !== (row.quantity ?? "")) patch.quantity = quantity || null;
    if (unit !== (row.unit ?? "")) patch.unit = unit || null;
    if (Object.keys(patch).length > 0) onPatch(row.id, patch);
  }

  function commitNotes() {
    setEditing(null);
    const notes = draftNotes.trim();
    if (notes === (row.notes ?? "")) return;
    onPatch(row.id, { notes: notes || null });
  }

  function cancelEdit() {
    setEditing(null);
    setDraftItem(row.item);
    setDraftQuantity(row.quantity ?? "");
    setDraftUnit(row.unit ?? "");
    setDraftNotes(row.notes ?? "");
  }

  function onEditKey(event: React.KeyboardEvent, commit: () => void) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
    }
  }

  const quantityLabel = [row.quantity, row.unit].filter(Boolean).join(" ");
  const metaParts: string[] = [];
  if (row.article_no) metaParts.push(`Art.-Nr. ${row.article_no}`);
  if (row.supplier_name) metaParts.push(row.supplier_name);
  if (row.ean) metaParts.push(`EAN ${row.ean}`);

  return (
    <li className={`bedarfe-row${selected ? " bedarfe-row--selected" : ""}`}>
      <input
        type="checkbox"
        className="bedarfe-row-check"
        checked={selected}
        aria-label={de ? `${row.item} auswählen` : `Select ${row.item}`}
        onChange={() => undefined}
        onClick={(event) => onToggleSelect(row.id, event.shiftKey)}
      />

      <span className="bedarfe-row-thumb" aria-hidden="true">
        {row.image_url ? <img src={row.image_url} alt="" loading="lazy" /> : <span>▢</span>}
      </span>

      <div className="bedarfe-row-main">
        {editing === "item" ? (
          <input
            type="text"
            className="bedarfe-input bedarfe-inline-input"
            autoFocus
            value={draftItem}
            onChange={(event) => setDraftItem(event.target.value)}
            onKeyDown={(event) => onEditKey(event, commitItem)}
            onBlur={commitItem}
          />
        ) : (
          <button
            type="button"
            className="bedarfe-row-title"
            title={de ? "Bezeichnung bearbeiten" : "Edit description"}
            onClick={() => setEditing("item")}
          >
            {row.item}
          </button>
        )}

        <span className="bedarfe-row-meta">
          {editing === "quantity" ? (
            <span className="bedarfe-inline-qty">
              <input
                type="text"
                className="bedarfe-input bedarfe-inline-input bedarfe-inline-input--qty"
                autoFocus
                value={draftQuantity}
                aria-label={de ? "Menge" : "Quantity"}
                placeholder={de ? "Menge" : "Qty"}
                onChange={(event) => setDraftQuantity(event.target.value)}
                onKeyDown={(event) => onEditKey(event, commitQuantity)}
              />
              <input
                type="text"
                className="bedarfe-input bedarfe-inline-input bedarfe-inline-input--unit"
                value={draftUnit}
                aria-label={de ? "Einheit" : "Unit"}
                placeholder={de ? "Einheit" : "Unit"}
                onChange={(event) => setDraftUnit(event.target.value)}
                onKeyDown={(event) => onEditKey(event, commitQuantity)}
              />
              <button type="button" className="bedarfe-link-btn" onClick={commitQuantity}>
                {de ? "Übernehmen" : "Apply"}
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="bedarfe-row-qty"
              title={de ? "Menge bearbeiten" : "Edit quantity"}
              onClick={() => setEditing("quantity")}
            >
              {quantityLabel || (de ? "Menge?" : "Qty?")}
            </button>
          )}
          {metaParts.length > 0 && <span className="muted">{metaParts.join(" · ")}</span>}
          <span className="bedarfe-badge bedarfe-badge--source">
            {row.source === "report"
              ? de
                ? `Bericht${row.report_date ? ` vom ${formatDayLabel(row.report_date, language)}` : ""}`
                : `Report${row.report_date ? ` of ${formatDayLabel(row.report_date, language)}` : ""}`
              : de
                ? "Manuell"
                : "Manual"}
          </span>
          {!row.orderable && (
            <span
              className="bedarfe-badge bedarfe-badge--warn"
              title={
                de
                  ? "Ohne Katalog-Artikel kann daraus keine Bestellposition werden."
                  : "Without a catalogue article this cannot become an order line."
              }
            >
              {de ? "Kein Katalog-Artikel" : "No catalogue article"}
            </span>
          )}
          {row.werkstatt_order_number && (
            <button
              type="button"
              className="bedarfe-badge bedarfe-badge--order"
              onClick={() => onOpenOrder(row)}
              title={de ? "Bestellung öffnen" : "Open order"}
            >
              {row.werkstatt_order_number}
            </button>
          )}
        </span>

        {editing === "notes" ? (
          <input
            type="text"
            className="bedarfe-input bedarfe-inline-input"
            autoFocus
            value={draftNotes}
            placeholder={de ? "Notiz hinzufügen…" : "Add a note…"}
            onChange={(event) => setDraftNotes(event.target.value)}
            onKeyDown={(event) => onEditKey(event, commitNotes)}
            onBlur={commitNotes}
          />
        ) : row.notes ? (
          <button
            type="button"
            className="bedarfe-row-note"
            onClick={() => setEditing("notes")}
            title={de ? "Notiz bearbeiten" : "Edit note"}
          >
            {row.notes}
          </button>
        ) : (
          <button
            type="button"
            className="bedarfe-row-note-add"
            onClick={() => setEditing("notes")}
          >
            {de ? "+ Notiz" : "+ Note"}
          </button>
        )}
      </div>

      <label className="bedarfe-row-status">
        <span className="bedarfe-sr-only">{de ? "Status" : "Status"}</span>
        <select
          className={`bedarfe-status-select bedarfe-status-select--${materialNeedStatusClass(status)}`}
          value={status}
          disabled={busy}
          onChange={(event) =>
            onPatch(row.id, { status: event.target.value as MaterialNeedStatus })
          }
        >
          {MATERIAL_NEED_STATUSES.map((option) => (
            <option key={`status-${row.id}-${option}`} value={option}>
              {materialNeedStatusLabel(option, language)}
            </option>
          ))}
        </select>
      </label>

      <div className="bedarfe-row-actions">
        {status !== "completed" && (
          <button
            type="button"
            className="bedarfe-done-btn"
            disabled={busy}
            onClick={() => onPatch(row.id, { status: "completed" })}
          >
            {de ? "Erledigt" : "Done"}
          </button>
        )}
        <KebabMenu
          ariaLabel={de ? "Weitere Aktionen" : "More actions"}
          items={[
            {
              key: "link",
              label: de ? "Katalog-Artikel zuordnen" : "Link catalogue article",
              onSelect: () => onLinkCatalog(row),
            },
            {
              key: "delete",
              label: de ? "Löschen" : "Delete",
              danger: true,
              onSelect: () => onDelete(row),
            },
          ]}
        />
      </div>
    </li>
  );
}
