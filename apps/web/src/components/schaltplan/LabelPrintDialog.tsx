/**
 * "BMK-Etiketten drucken" / "Klemmen-Etiketten drucken" — choose what to
 * print and material, see the strip first.
 *
 * Printing used to fire straight from the toolbar. That was fine while the
 * strip was a list of names; now that every segment is cut to the width of
 * its device, the electrician needs to see the strip before 200 mm of
 * 2009-110 feed, and to print only the rail that changed. The preview is
 * drawn from `utils/schaltplanStrip.ts` — the same rules the server prints
 * with: a segment only for a labelled device (no width for a blank cover or
 * an unnamed device), one font size for the whole board, every BMK centred
 * on its segment. What scrolls past here is what comes out of the printer.
 *
 * The one size is computed over the whole document, not the ticked rails,
 * so printing a single rail later gives the same height as the rest of the
 * board. A BMK too long for its segment at that size is flagged, not
 * blocked: the electrician decides whether to shorten it or live with it.
 *
 * In `mode="reihenklemmen"` the same sheet prints the WAGO terminal markers:
 * the list is the FI groups instead of the rails, the material is the strip
 * only, a chip row picks what each marker says, and the preview comes from
 * `utils/schaltplanTerminals.ts` at the terminals' own pitch and pad.
 *
 * Same bottom sheet as the palette and the inspector: it is the reachable
 * third of a phone held in front of an open board.
 */
import { useEffect, useMemo, useState } from "react";

import { StripSvg, layoutSegments, previewFontPx } from "./StripSvg";
import {
  TERMINAL_MATERIAL,
  TERMINAL_TEXT_OPTIONS,
  TerminalGroupList,
  TerminalPreview,
} from "./LabelPrintTerminals";
import {
  DEFAULT_LABEL_MATERIAL,
  LABEL_MATERIALS,
  STRIP_HEIGHT_MM,
  STRIP_LEAD_MM,
  boardFontSize,
  formatFontMm,
  formatMm,
  rowLabelCounts,
  singleLabels,
  stripLengthMm,
  stripSegments,
  stripTotalMm,
  type BoardFontSize,
  type LabelMaterialId,
  type RowLabelCounts,
} from "../../utils/schaltplanStrip";
import {
  deriveTerminals,
  terminalFontSize,
  terminalStrips,
  unverifiedTerminalParts,
  type TerminalTextMode,
} from "../../utils/schaltplanTerminals";
import type { PrintTarget } from "../../utils/schaltplanApi";
import type { PanelDocument, PanelRow } from "../../types/schaltplan";

export type LabelPrintMode = "bmk" | "reihenklemmen";

export interface LabelPrintOptions {
  target: PrintTarget;
  terminalText: TerminalTextMode;
}

type Props = {
  open: boolean;
  document: PanelDocument;
  /** Ticked when the sheet opens: rail ids in BMK mode, FI-group ids in Reihenklemmen mode. */
  initialRowIds: string[];
  busy: boolean;
  mode?: LabelPrintMode;
  onPrint: (ids: string[], materialId: string, options: LabelPrintOptions) => void;
  onClose: () => void;
};

function BmkStrip({ row, fontPx }: { row: PanelRow; fontPx: number }) {
  const segments = layoutSegments(
    stripSegments(row).map((segment) => ({ key: segment.deviceId, text: segment.text, widthMm: segment.widthMm })),
  );
  return <StripSvg label={row.label} segments={segments} lengthMm={stripLengthMm(row)} fontPx={fontPx} />;
}

function SingleLabels({ row }: { row: PanelRow }) {
  return (
    <div className="sp-label-chips" role="list" aria-label={`Etiketten ${row.label}`}>
      {singleLabels(row).map((label) => (
        <span key={label.deviceId} role="listitem" className="sp-label-chip">
          {label.text}
        </span>
      ))}
    </div>
  );
}

function deviceCountLabel(count: number): string {
  return count === 1 ? "1 Gerät" : `${count} Geräte`;
}

function rowMeta(row: PanelRow, counts: RowLabelCounts, strip: boolean): string {
  const parts = [deviceCountLabel(row.devices.length)];
  if (counts.withoutBmk > 0) parts.push(`${counts.withoutBmk} ohne BMK`);
  if (strip && counts.labelled > 0) parts.push(`${formatMm(stripLengthMm(row))} mm`);
  return parts.join(" · ");
}

function emptyRowMessage(row: PanelRow): string {
  return row.devices.length === 0
    ? "Keine Geräte auf dieser Reihe."
    : "Keine BMK in dieser Reihe — nichts zu drucken.";
}

function sumCounts(rows: PanelRow[]): RowLabelCounts {
  return rows.reduce<RowLabelCounts>(
    (total, row) => {
      const counts = rowLabelCounts(row);
      return {
        labelled: total.labelled + counts.labelled,
        withoutBmk: total.withoutBmk + counts.withoutBmk,
      };
    },
    { labelled: 0, withoutBmk: 0 },
  );
}

function summaryLine(rows: PanelRow[], counts: RowLabelCounts, strip: boolean, board: BoardFontSize): string {
  if (rows.length === 0) return "Keine Reihe ausgewählt.";
  const skipped = counts.withoutBmk > 0 ? ` · ${counts.withoutBmk} ohne BMK` : "";
  if (strip) {
    const total = rows.reduce((sum, row) => sum + stripTotalMm(row), 0);
    const font = `Schriftgröße: ${formatFontMm(board.sizeDots)} mm`;
    return `${rows.length} Streifen · ${counts.labelled} BMK · ${formatMm(total)} mm Material · ${font}${skipped}`;
  }
  return `${counts.labelled} Etiketten${skipped ? `${skipped} werden übersprungen` : ""}`;
}

function Chips<T extends string>({
  name,
  options,
  active,
  onPick,
}: {
  name: string;
  options: readonly { id: T; label: string }[];
  active: T;
  onPick: (id: T) => void;
}) {
  return (
    <div className="sp-chips" role="radiogroup" aria-label={name}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={active === option.id}
          className={active === option.id ? "sp-chip-btn sp-chip-btn--active" : "sp-chip-btn"}
          onClick={() => onPick(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function LabelPrintDialog({ open, document, initialRowIds, busy, mode = "bmk", onPrint, onClose }: Props) {
  const terminalMode = mode === "reihenklemmen";
  const [materialId, setMaterialId] = useState<LabelMaterialId>(DEFAULT_LABEL_MATERIAL);
  const [terminalText, setTerminalText] = useState<TerminalTextMode>("circuit");
  const [selectedIds, setSelectedIds] = useState<string[]>(initialRowIds);

  // Re-seed on every open: the toolbar preselects every rail (or group),
  // the per-rail button just its own, and a selection left over from the
  // last print would quietly print the wrong rails. Keyed on the ids, not
  // the array, so a parent re-render with a fresh array does not undo a tick.
  const seedKey = initialRowIds.join(" ");
  useEffect(() => {
    if (open) setSelectedIds(seedKey === "" ? [] : seedKey.split(" "));
  }, [open, seedKey]);

  const rows = document.rows;
  const selectedRows = useMemo(() => rows.filter((row) => selectedIds.includes(row.id)), [rows, selectedIds]);
  const counts = useMemo(() => sumCounts(selectedRows), [selectedRows]);
  // Over the whole document on purpose — see the header comment.
  const board = useMemo(() => boardFontSize(document, STRIP_HEIGHT_MM), [document]);

  const groups = useMemo(() => (terminalMode ? deriveTerminals(document) : []), [document, terminalMode]);
  // Exactly the ticked groups: an empty selection is an empty preview and a
  // disabled Drucken, never "every group" — the server reads [] the same way.
  const selection = useMemo(
    () => terminalStrips(groups, terminalText, selectedIds),
    [groups, terminalText, selectedIds],
  );
  const selectedStrips = selection.strips;
  // Fitted over every group of the board in this text mode, not the ticked ones.
  const terminalBoard = useMemo(() => terminalFontSize(groups, terminalText, STRIP_HEIGHT_MM), [groups, terminalText]);
  const unverified = useMemo(() => unverifiedTerminalParts(groups), [groups]);

  if (!open) return null;

  const strip = terminalMode || materialId === "wago-2009-110";
  const material = terminalMode
    ? TERMINAL_MATERIAL
    : (LABEL_MATERIALS.find((entry) => entry.id === materialId) ?? LABEL_MATERIALS[0]);
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.includes(row.id));
  const canPrint = terminalMode
    ? !busy && selectedStrips.length > 0
    : !busy && selectedRows.length > 0 && counts.labelled > 0;
  const fontPx = previewFontPx(terminalMode ? terminalBoard.sizeDots : board.sizeDots);

  const toggle = (id: string) =>
    setSelectedIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  const toggleAllRows = () => setSelectedIds(allSelected ? [] : rows.map((row) => row.id));
  const toggleAllGroups = () => {
    const every = groups.every((group) => selectedIds.includes(group.groupId));
    setSelectedIds(every ? [] : groups.map((group) => group.groupId));
  };

  const print = () =>
    onPrint(selectedIds, material.id, {
      target: terminalMode ? "reihenklemmen" : "bmk",
      terminalText,
    });

  const title = terminalMode ? "Klemmen-Etiketten drucken" : "BMK-Etiketten drucken";

  return (
    <>
      <div className="sp-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sp-sheet sp-sheet--labels" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sp-sheet-head">
          <div>
            <h3>{title}</h3>
            <small>{material.hint}</small>
          </div>
          <button type="button" className="sp-sheet-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        <div className="sp-sheet-body">
          <div className="sp-field">
            <span className="sp-field-label">Material</span>
            {terminalMode ? (
              <Chips name="Material" options={[TERMINAL_MATERIAL]} active={TERMINAL_MATERIAL.id} onPick={() => undefined} />
            ) : (
              <Chips name="Material" options={LABEL_MATERIALS} active={materialId} onPick={setMaterialId} />
            )}
          </div>

          {terminalMode && (
            <div className="sp-field">
              <span className="sp-field-label">Text</span>
              <Chips name="Text" options={TERMINAL_TEXT_OPTIONS} active={terminalText} onPick={setTerminalText} />
            </div>
          )}

          {terminalMode ? (
            <TerminalGroupList
              groups={groups}
              mode={terminalText}
              selectedIds={selectedIds}
              onToggle={toggle}
              onToggleAll={toggleAllGroups}
            />
          ) : (
            <div className="sp-field">
              <div className="sp-label-rows-head">
                <span className="sp-field-label">Reihen</span>
                <button type="button" className="sp-label-toggle" onClick={toggleAllRows} disabled={rows.length === 0}>
                  {allSelected ? "Keine" : "Alle"}
                </button>
              </div>
              <ul className="sp-label-rows" aria-label="Reihen">
                {rows.map((row) => {
                  const checked = selectedIds.includes(row.id);
                  return (
                    <li key={row.id} className={checked ? "sp-label-row sp-label-row--on" : "sp-label-row"}>
                      <label className="sp-label-row-main">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(row.id)}
                          aria-label={`${row.label} drucken`}
                        />
                        <span className="sp-label-row-text">
                          <b>{row.label}</b>
                          <small>{rowMeta(row, rowLabelCounts(row), strip)}</small>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {terminalMode ? (
            <TerminalPreview
              strips={selectedStrips}
              skipped={selection.skipped}
              board={terminalBoard}
              fontPx={fontPx}
              unverified={unverified}
            />
          ) : (
            <section className="sp-label-preview" aria-label="Vorschau">
              <div className="sp-label-rows-head">
                <span className="sp-field-label">Vorschau</span>
                <small className="sp-label-summary">{summaryLine(selectedRows, counts, strip, board)}</small>
              </div>
              {strip && board.overflowing.length > 0 && (
                <p className="sp-label-warn" role="status">
                  {`Zu lang für die Box bei einheitlicher Größe: ${board.overflowing.join(", ")}`}
                </p>
              )}
              {selectedRows.map((row) => {
                const rowCounts = rowLabelCounts(row);
                return (
                  <div key={row.id} className="sp-strip-preview">
                    <div className="sp-strip-head">
                      <b>{row.label}</b>
                      {strip && rowCounts.labelled > 0 && (
                        <small>
                          {`${formatMm(stripTotalMm(row))} mm (${STRIP_LEAD_MM} + ${formatMm(stripLengthMm(row))} + ${STRIP_LEAD_MM})`}
                        </small>
                      )}
                    </div>
                    {rowCounts.labelled === 0 ? (
                      <p className="sp-label-empty">{emptyRowMessage(row)}</p>
                    ) : strip ? (
                      <div className="sp-strip-scroll">
                        <BmkStrip row={row} fontPx={fontPx} />
                      </div>
                    ) : (
                      <SingleLabels row={row} />
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </div>

        <div className="sp-sheet-actions">
          <button type="button" className="sp-btn sp-btn--ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="sp-btn sp-btn--primary" disabled={!canPrint} onClick={print}>
            {busy ? "Drucke…" : "Drucken"}
          </button>
        </div>
      </div>
    </>
  );
}
