/**
 * The Reihenklemmen half of the print sheet: the FI-group list and the strip
 * preview. `LabelPrintDialog` owns the sheet, the state and the buttons;
 * this file only knows how a group reads as a checkbox row and what its
 * strip looks like — derived from `utils/schaltplanTerminals.ts`, the same
 * rules the server prints with.
 */
import { StripSvg, layoutSegments } from "./StripSvg";
import { STRIP_LEAD_MM, formatFontMm, formatMm, type BoardFontSize } from "../../utils/schaltplanStrip";
import type { TerminalPart } from "../../utils/schaltplanTerminalRules";
import {
  terminalGroupTitle,
  terminalStrips,
  type TerminalGroup,
  type TerminalStrip,
  type TerminalTextMode,
} from "../../utils/schaltplanTerminals";

/** The only stock a terminal marker fits: the 11 mm strip, one per FI group. */
export const TERMINAL_MATERIAL = {
  id: "wago-2009-110",
  label: "WAGO 2009-110",
  hint: "11 mm Endlosstreifen — ein Streifen je FI-Gruppe, in den WAGO-Beschriftungsträger einschieben",
} as const;

export const TERMINAL_TEXT_OPTIONS: readonly { id: TerminalTextMode; label: string }[] = [
  // Stromkreis-Nr. first: "7" fits a 5.2 mm terminal, "F1.12" does not.
  { id: "circuit", label: "Stromkreis-Nr." },
  { id: "bmk", label: "BMK" },
];

function terminalCountLabel(count: number): string {
  return count === 1 ? "1 Klemme" : `${count} Klemmen`;
}

/** "3 Klemmen · 1 ohne Beschriftung · 17,2 mm" — the group row's second line. */
export function groupMeta(group: TerminalGroup, strip: TerminalStrip | undefined): string {
  const markers = group.terminals.filter((terminal) => terminal.marker).length;
  const labelled = strip?.segments.length ?? 0;
  const parts = [terminalCountLabel(group.terminals.length)];
  if (markers - labelled > 0) parts.push(`${markers - labelled} ohne Beschriftung`);
  if (strip) parts.push(`${formatMm(strip.lengthMm)} mm`);
  return parts.join(" · ");
}

/** Total strip the printer feeds for one group: lead + printed length + lead. */
export function stripTotal(strip: TerminalStrip): number {
  return STRIP_LEAD_MM + strip.lengthMm + STRIP_LEAD_MM;
}

/**
 * The preview's one-line total. `skipped` is the selection's count from
 * `terminalStrips`, not a sum over the strips: a ticked group with no text
 * at all has no strip, and its terminals would otherwise vanish from the line.
 */
export function terminalSummary(strips: readonly TerminalStrip[], board: BoardFontSize, skipped: number): string {
  if (strips.length === 0) {
    return skipped > 0 ? `Nichts zu drucken · ${skipped} ohne Beschriftung` : "Keine FI-Gruppe ausgewählt.";
  }
  const labelled = strips.reduce((sum, strip) => sum + strip.segments.length, 0);
  const total = strips.reduce((sum, strip) => sum + stripTotal(strip), 0);
  const tail = skipped > 0 ? ` · ${skipped} ohne Beschriftung` : "";
  return `${strips.length} Streifen · ${labelled} Klemmen · ${formatMm(total)} mm Material · Schriftgröße: ${formatFontMm(board.sizeDots)} mm${tail}`;
}

type ListProps = {
  groups: readonly TerminalGroup[];
  mode: TerminalTextMode;
  selectedIds: readonly string[];
  onToggle: (groupId: string) => void;
  onToggleAll: () => void;
};

export function TerminalGroupList({ groups, mode, selectedIds, onToggle, onToggleAll }: ListProps) {
  const allSelected = groups.length > 0 && groups.every((group) => selectedIds.includes(group.groupId));
  const stripsById = new Map(terminalStrips(groups, mode).strips.map((strip) => [strip.groupId, strip] as const));
  return (
    <div className="sp-field">
      <div className="sp-label-rows-head">
        <span className="sp-field-label">FI-Gruppen</span>
        <button type="button" className="sp-label-toggle" onClick={onToggleAll} disabled={groups.length === 0}>
          {allSelected ? "Keine" : "Alle"}
        </button>
      </div>
      {groups.length === 0 ? (
        <p className="sp-label-empty">
          Noch keine Reihenklemmen — im Gerätedialog „Reihenklemme am Abgang“ setzen oder auf dem Klemmen-Tab
          alle auf einmal.
        </p>
      ) : (
        <ul className="sp-label-rows" aria-label="FI-Gruppen">
          {groups.map((group) => {
            const title = terminalGroupTitle(group);
            const checked = selectedIds.includes(group.groupId);
            return (
              <li key={group.groupId} className={checked ? "sp-label-row sp-label-row--on" : "sp-label-row"}>
                <label className="sp-label-row-main">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(group.groupId)}
                    aria-label={`${title} drucken`}
                  />
                  <span className="sp-label-row-text">
                    <b>{title}</b>
                    <small>{groupMeta(group, stripsById.get(group.groupId))}</small>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type PreviewProps = {
  strips: readonly TerminalStrip[];
  /** The selection's unmarked terminals, dropped groups included (see `terminalSummary`). */
  skipped: number;
  board: BoardFontSize;
  fontPx: number;
  unverified: readonly TerminalPart[];
};

export function TerminalPreview({ strips, skipped, board, fontPx, unverified }: PreviewProps) {
  return (
    <section className="sp-label-preview" aria-label="Vorschau">
      <div className="sp-label-rows-head">
        <span className="sp-field-label">Vorschau</span>
        <small className="sp-label-summary">{terminalSummary(strips, board, skipped)}</small>
      </div>
      {unverified.length > 0 && (
        <p className="sp-label-warn" role="status">
          {`Breite nicht bestätigt: ${unverified.map((part) => part.partNo).join(", ")} — vor dem ersten Druck am Träger messen.`}
        </p>
      )}
      {board.overflowing.length > 0 && (
        <p className="sp-label-warn" role="status">
          {`Zu lang für die Klemme bei einheitlicher Größe: ${board.overflowing.join(", ")}`}
        </p>
      )}
      {strips.map((strip) => (
        <div key={strip.groupId} className="sp-strip-preview">
          <div className="sp-strip-head">
            <b>{strip.label}</b>
            <small>
              {`${formatMm(stripTotal(strip))} mm (${STRIP_LEAD_MM} + ${formatMm(strip.lengthMm)} + ${STRIP_LEAD_MM})`}
            </small>
          </div>
          <div className="sp-strip-scroll">
            <StripSvg
              label={strip.label}
              segments={layoutSegments(
                strip.segments.map((segment, index) => ({ key: `${index}-${segment.text}`, ...segment })),
              )}
              lengthMm={strip.lengthMm}
              fontPx={fontPx}
            />
          </div>
        </div>
      ))}
    </section>
  );
}
