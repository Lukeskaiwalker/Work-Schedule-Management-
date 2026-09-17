import { useState } from "react";
import type { Language, MaterialNeedStatus } from "../../../types";
import type { MaterialNeedSkipReason } from "../../../types/materialNeeds";
import {
  MATERIAL_NEED_STATUSES,
  materialNeedStatusLabel,
  needSkipSummary,
} from "../../../utils/materials";

/**
 * The bar that appears once anything is selected.
 *
 * This is the answer to "ten projects, eight items each, one click at a
 * time". It only ever shows actions that are safe for a mixed selection, and
 * it says out loud why one of them is unavailable: "In Bestellung übernehmen"
 * is disabled with the REASONS the rows were skipped ("3 bereits in einer
 * Bestellung, 1 ohne Katalog-Artikel"), rather than silently ordering a
 * subset — or blaming one reason for all of them, which sent people to a
 * recovery action that could not have helped.
 *
 * The order action is hidden entirely without `werkstatt:manage` — an
 * employee pressing it would get a 403 with nothing to do about it.
 */
export interface BedarfBulkBarProps {
  language: Language;
  count: number;
  orderableCount: number;
  /** One entry per selected row that would be skipped, in any order. */
  skipReasons: readonly MaterialNeedSkipReason[];
  canCreateOrder: boolean;
  busy: boolean;
  onSetStatus: (status: MaterialNeedStatus) => void;
  onCreateOrder: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export function BedarfBulkBar({
  language,
  count,
  orderableCount,
  skipReasons,
  canCreateOrder,
  busy,
  onSetStatus,
  onCreateOrder,
  onDelete,
  onClear,
}: BedarfBulkBarProps) {
  const de = language === "de";
  const [pendingStatus, setPendingStatus] = useState<MaterialNeedStatus | "">("");
  if (count === 0) return null;

  const notOrderable = skipReasons.length;
  const skipSummary = notOrderable > 0 ? needSkipSummary(skipReasons, language) : "";

  return (
    <div className="bedarfe-bulkbar" role="region" aria-label={de ? "Massenaktionen" : "Bulk actions"}>
      <span className="bedarfe-bulkbar-count">
        {count} {de ? "ausgewählt" : "selected"}
      </span>

      <label className="bedarfe-select bedarfe-bulkbar-select">
        <span className="bedarfe-select-label">{de ? "Status setzen" : "Set status"}</span>
        <select
          value={pendingStatus}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value as MaterialNeedStatus | "";
            setPendingStatus("");
            if (next) onSetStatus(next);
          }}
        >
          <option value="">{de ? "wählen…" : "choose…"}</option>
          {MATERIAL_NEED_STATUSES.map((status) => (
            <option key={`bulk-status-${status}`} value={status}>
              {materialNeedStatusLabel(status, language)}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className="werkstatt-action-btn"
        disabled={busy}
        onClick={() => onSetStatus("completed")}
      >
        {de ? "Erledigt" : "Done"}
      </button>

      {canCreateOrder && (
        <button
          type="button"
          className="werkstatt-action-btn werkstatt-action-btn--primary"
          disabled={busy || orderableCount === 0}
          onClick={onCreateOrder}
          title={
            orderableCount === 0
              ? de
                ? `Nichts bestellbar: ${skipSummary}`
                : `Nothing orderable: ${skipSummary}`
              : notOrderable > 0
                ? de
                  ? `${skipSummary} — wird übersprungen`
                  : `${skipSummary} — will be skipped`
                : undefined
          }
        >
          {de ? "In Bestellung übernehmen" : "Add to an order"}
          {orderableCount > 0 && notOrderable > 0 ? ` (${orderableCount})` : ""}
        </button>
      )}

      <button
        type="button"
        className="werkstatt-action-btn werkstatt-action-btn--danger"
        disabled={busy}
        onClick={onDelete}
      >
        {de ? "Löschen" : "Delete"}
      </button>

      <button type="button" className="bedarfe-link-btn" onClick={onClear} disabled={busy}>
        {de ? "Auswahl aufheben" : "Clear selection"}
      </button>
    </div>
  );
}
