import { useMemo } from "react";
import type { Partner, PartnerListItem } from "../../types";
import { PartnerTradePill, tradePalette } from "./PartnerTradePill";

type Props = {
  language: "de" | "en";
  query: string;
  onQueryChange: (next: string) => void;
  partners: ReadonlyArray<PartnerListItem>;
  value: ReadonlyArray<number>;
  onAdd: (partnerId: number) => void;
  onRemove: (partnerId: number) => void;
  /** Invoked when the user picks the "+ Neuen Partner anlegen …" row. The
   *  parent is expected to open `PartnerModal` with `prefillName` + an
   *  `onSaved` callback that calls `onAdd(newPartner.id)`. */
  onRequestCreate: (prefillName: string) => void;
};

/**
 * Partner multi-select field. Mirrors the assignee picker pattern in
 * TaskModal: search input → suggestion list → inline "+ Neuen Partner
 * anlegen" action → chip list of currently-selected partners with a
 * remove control.
 *
 * Intentionally presentational — all state lives in the caller (so
 * TaskModal and TaskEditModal can keep their selections on the shared form
 * state objects).
 */
export function PartnerMultiSelect({
  language,
  query,
  onQueryChange,
  partners,
  value,
  onAdd,
  onRemove,
  onRequestCreate,
}: Props) {
  const de = language === "de";
  const trimmed = query.trim();
  const lowerQuery = trimmed.toLowerCase();

  const suggestions = useMemo<PartnerListItem[]>(() => {
    const selected = new Set(value);
    const pool = partners.filter((row) => !selected.has(row.id) && !row.archived_at);
    if (!lowerQuery) return pool.slice(0, 5);
    return pool
      .filter((row) => {
        const haystack = [
          row.name,
          row.trade ?? "",
          row.contact_person ?? "",
          row.email ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(lowerQuery);
      })
      .slice(0, 5);
  }, [partners, value, lowerQuery]);

  const exactMatch = useMemo(() => {
    if (!lowerQuery) return null;
    return partners.find((row) => row.name.trim().toLowerCase() === lowerQuery) ?? null;
  }, [partners, lowerQuery]);

  const showCreateRow = trimmed.length > 0 && !exactMatch;

  const selectedPartners = useMemo<Partner[]>(() => {
    const byId = new Map(partners.map((row) => [row.id, row]));
    return value
      .map((id) => byId.get(id))
      .filter((row): row is PartnerListItem => Boolean(row));
  }, [partners, value]);

  return (
    <div className="partner-multi-select">
      <input
        className="task-modal-input"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const first = suggestions[0];
          if (first) {
            onAdd(first.id);
            onQueryChange("");
            return;
          }
          if (showCreateRow) {
            onRequestCreate(trimmed);
          }
        }}
        placeholder={
          de
            ? "Partnerfirma oder Gewerk suchen…"
            : "Search company or trade…"
        }
      />

      {(suggestions.length > 0 || showCreateRow) && (
        <div className="partner-multi-suggestions">
          {suggestions.map((partner) => (
            <button
              key={`partner-suggestion-${partner.id}`}
              type="button"
              className="partner-multi-suggestion-btn"
              onClick={() => {
                onAdd(partner.id);
                onQueryChange("");
              }}
            >
              <span className="partner-multi-suggestion-main">
                <PartnerTradePill trade={partner.trade} compact />
                <span className="partner-multi-suggestion-name">{partner.name}</span>
              </span>
              {partner.contact_person && (
                <span className="partner-multi-suggestion-meta">{partner.contact_person}</span>
              )}
            </button>
          ))}

          {showCreateRow && (
            <>
              {suggestions.length > 0 && (
                <div className="partner-multi-divider" aria-hidden="true" />
              )}
              <button
                type="button"
                className="partner-multi-create-btn"
                onClick={() => onRequestCreate(trimmed)}
              >
                <span className="partner-multi-create-icon" aria-hidden="true">
                  +
                </span>
                <span>
                  {de ? "Neuen Partner anlegen" : "Create new partner"}:{" "}
                  <b>«{trimmed}»</b>
                </span>
              </button>
            </>
          )}
        </div>
      )}

      <div className="partner-multi-chip-list task-modal-assignee-chip-list">
        {selectedPartners.map((partner) => {
          const palette = tradePalette(partner.trade);
          return (
            <button
              key={`partner-chip-${partner.id}`}
              type="button"
              className="task-modal-assignee-chip partner-multi-chip"
              onClick={() => onRemove(partner.id)}
              title={de ? "Entfernen" : "Remove"}
              style={{ borderColor: palette.bg }}
            >
              <span
                className="partner-multi-chip-badge"
                aria-hidden="true"
                style={{ backgroundColor: palette.bg, color: palette.fg }}
              >
                {palette.icon}
              </span>
              <span className="task-modal-assignee-name">{partner.name}</span>
              {partner.trade && (
                <span className="partner-multi-chip-trade" style={{ color: palette.fg }}>
                  {partner.trade}
                </span>
              )}
              <span aria-hidden="true" className="task-modal-assignee-remove">
                ×
              </span>
            </button>
          );
        })}
        {selectedPartners.length === 0 && (
          <small className="muted">
            {de
              ? "Noch keine Partnerfirma ausgewählt."
              : "No external partner selected yet."}
          </small>
        )}
      </div>
    </div>
  );
}
