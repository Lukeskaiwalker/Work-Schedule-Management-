/**
 * "BMK-Etiketten drucken" — choose rails and material, see the strip first.
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
 * Same bottom sheet as the palette and the inspector: it is the reachable
 * third of a phone held in front of an open board.
 */
import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_LABEL_MATERIAL,
  DOTS_PER_MM,
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
import type { PanelDocument, PanelRow } from "../../types/schaltplan";

type Props = {
  open: boolean;
  document: PanelDocument;
  /** Rails ticked when the sheet opens — every rail from the toolbar, one from a rail. */
  initialRowIds: string[];
  busy: boolean;
  onPrint: (rowIds: string[], materialId: string) => void;
  onClose: () => void;
};

/** Preview scale. 2.4 px/mm puts a 12-module rail at ~520 px — scrollable on a phone, whole on a tablet. */
const PX_PER_MM = 2.4;
/** The same scale in printer dots, so the board font size lands on screen at its true proportion. */
const PX_PER_DOT = PX_PER_MM / DOTS_PER_MM;
/** Room above and below the band so the thick end lines are not clipped. */
const BAND_PAD_PX = 6;

/** Font size for the preview, in px, rounded so SVG attributes do not carry float noise. */
function previewFontPx(sizeDots: number): number {
  return Math.round(sizeDots * PX_PER_DOT * 100) / 100;
}

function StripSvg({ row, fontPx }: { row: PanelRow; fontPx: number }) {
  const segments = stripSegments(row);
  const length = stripLengthMm(row);
  const total = stripTotalMm(row);
  const width = total * PX_PER_MM;
  const band = STRIP_HEIGHT_MM * PX_PER_MM;
  const height = band + BAND_PAD_PX * 2;
  const top = BAND_PAD_PX;
  const bottom = top + band;
  const leadPx = STRIP_LEAD_MM * PX_PER_MM;
  const x = (mm: number) => leadPx + mm * PX_PER_MM;

  return (
    <svg
      className="sp-strip-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Streifen ${row.label}, ${formatMm(total)} mm`}
    >
      <rect className="sp-strip-band" x={0} y={top} width={width} height={band} />
      <rect className="sp-strip-lead" x={0} y={top} width={leadPx} height={band} />
      <rect className="sp-strip-lead" x={x(length)} y={top} width={leadPx} height={band} />
      {segments.map((segment, index) => (
        <g key={segment.deviceId}>
          {index > 0 && (
            <line
              className="sp-strip-cut"
              x1={x(segment.start)}
              x2={x(segment.start)}
              y1={top}
              y2={bottom}
            />
          )}
          <text
            className="sp-strip-text"
            x={x(segment.start + segment.widthMm / 2)}
            y={top + band / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={fontPx}
          >
            {segment.text}
          </text>
        </g>
      ))}
      <line className="sp-strip-end" x1={x(0)} x2={x(0)} y1={top - 3} y2={bottom + 3} />
      <line className="sp-strip-end" x1={x(length)} x2={x(length)} y1={top - 3} y2={bottom + 3} />
    </svg>
  );
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

export function LabelPrintDialog({ open, document, initialRowIds, busy, onPrint, onClose }: Props) {
  const [materialId, setMaterialId] = useState<LabelMaterialId>(DEFAULT_LABEL_MATERIAL);
  const [selectedIds, setSelectedIds] = useState<string[]>(initialRowIds);

  // Re-seed on every open: the toolbar preselects every rail, the per-rail
  // button just its own, and a selection left over from the last print
  // would quietly print the wrong rails. Keyed on the ids, not the array,
  // so a parent re-render with a fresh array does not undo a tick.
  const seedKey = initialRowIds.join(" ");
  useEffect(() => {
    if (open) setSelectedIds(seedKey === "" ? [] : seedKey.split(" "));
  }, [open, seedKey]);

  const rows = document.rows;
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.includes(row.id)),
    [rows, selectedIds],
  );
  const counts = useMemo(() => sumCounts(selectedRows), [selectedRows]);
  // Over the whole document on purpose — see the header comment.
  const board = useMemo(() => boardFontSize(document, STRIP_HEIGHT_MM), [document]);

  if (!open) return null;

  const strip = materialId === "wago-2009-110";
  const material = LABEL_MATERIALS.find((entry) => entry.id === materialId) ?? LABEL_MATERIALS[0];
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.includes(row.id));
  const canPrint = !busy && selectedRows.length > 0 && counts.labelled > 0;
  const fontPx = previewFontPx(board.sizeDots);

  const toggleRow = (rowId: string) =>
    setSelectedIds((current) =>
      current.includes(rowId) ? current.filter((id) => id !== rowId) : [...current, rowId],
    );
  const toggleAll = () => setSelectedIds(allSelected ? [] : rows.map((row) => row.id));

  return (
    <>
      <div className="sp-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="sp-sheet sp-sheet--labels"
        role="dialog"
        aria-modal="true"
        aria-label="BMK-Etiketten drucken"
      >
        <div className="sp-sheet-head">
          <div>
            <h3>BMK-Etiketten drucken</h3>
            <small>{material.hint}</small>
          </div>
          <button type="button" className="sp-sheet-close" onClick={onClose} aria-label="Schließen">
            ×
          </button>
        </div>

        <div className="sp-sheet-body">
          <div className="sp-field">
            <span className="sp-field-label">Material</span>
            <div className="sp-chips" role="radiogroup" aria-label="Material">
              {LABEL_MATERIALS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={materialId === entry.id}
                  className={materialId === entry.id ? "sp-chip-btn sp-chip-btn--active" : "sp-chip-btn"}
                  onClick={() => setMaterialId(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <div className="sp-field">
            <div className="sp-label-rows-head">
              <span className="sp-field-label">Reihen</span>
              <button
                type="button"
                className="sp-label-toggle"
                onClick={toggleAll}
                disabled={rows.length === 0}
              >
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
                        onChange={() => toggleRow(row.id)}
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
                      <StripSvg row={row} fontPx={fontPx} />
                    </div>
                  ) : (
                    <SingleLabels row={row} />
                  )}
                </div>
              );
            })}
          </section>
        </div>

        <div className="sp-sheet-actions">
          <button type="button" className="sp-btn sp-btn--ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            disabled={!canPrint}
            onClick={() => onPrint(selectedIds, materialId)}
          >
            {busy ? "Drucke…" : "Drucken"}
          </button>
        </div>
      </div>
    </>
  );
}
