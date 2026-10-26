/**
 * The "Aderbeschriftung drucken" half of the print sheet
 * (docs/PANEL_ENCLOSURE_R4.md §9.2): the wire labels of the §14a block on
 * the board's own heat-shrink tube. `LabelPrintDialog` owns the sheet and
 * the buttons; this file knows what the tube will carry.
 *
 * Every named terminal gets two 15 mm sleeves — the same text at both ends
 * of its wire — on one continuous piece, with the lead, the dividers and the
 * end lines of every strip, at one size fitted to the tube (at most 48
 * dots). There is nothing to choose: the board says which tube its wires
 * take, so the material is one chip and there is no list. The derivation
 * needs no cabinet catalogue.
 */
import { StripSvg, layoutSegments, previewFontPx } from "./StripSvg";
import { DEFAULT_LABEL_MATERIAL, storedBlock } from "../../utils/enclosureControlBlock";
import {
  NO_WIRE_LABELS_DETAIL,
  WIRE_STRIP_LABEL,
  tubeMaterial,
  wireLabelSegments,
  wireLabelSize,
  type TubeMaterial,
} from "../../utils/schaltplanControlStrip";
import {
  STRIP_LEAD_MM,
  formatFontMm,
  formatMm,
  type BoardFontSize,
  type FitSegment,
} from "../../utils/schaltplanStrip";

export interface WireSheet {
  /** The board's tube (`control_block.label_material`; the default without a block). */
  tube: TubeMaterial;
  /** Two sleeves per named terminal; null = nothing to print. */
  segments: FitSegment[] | null;
  size: BoardFontSize;
}

/** What the sheet shows and prints for a board, derived from the saved block. */
export function wireSheet(document: unknown): WireSheet {
  const tube = tubeMaterial(storedBlock(document)?.label_material ?? DEFAULT_LABEL_MATERIAL);
  const segments = wireLabelSegments(document);
  return { tube, segments, size: wireLabelSize(segments ?? [], tube.widthMm) };
}

/** Printed length between the end lines: every sleeve, summed left → right. */
function piecesMm(segments: readonly FitSegment[]): number {
  let total = 0;
  for (const segment of segments) total += segment.widthMm;
  return total;
}

/** "6 Adern · 12 Hülsen · 186 mm Schlauch · Schriftgröße: 4,1 mm" — the tube fed, leads included. */
export function wireSummary(segments: readonly FitSegment[], sizeDots: number): string {
  const sleeves = segments.length;
  const tube = STRIP_LEAD_MM + piecesMm(segments) + STRIP_LEAD_MM;
  return `${sleeves / 2} Adern · ${sleeves} Hülsen · ${formatMm(tube)} mm Schlauch · Schriftgröße: ${formatFontMm(sizeDots)} mm`;
}

export function WirePreview({ sheet }: { sheet: WireSheet }) {
  const { segments, size, tube } = sheet;
  if (!segments) {
    return (
      <section className="sp-label-preview" aria-label="Vorschau">
        <p className="sp-label-empty">{NO_WIRE_LABELS_DETAIL}</p>
      </section>
    );
  }
  const laid = layoutSegments(segments.map((segment, index) => ({ key: `${index}-${segment.text}`, ...segment })));
  const overflowing = Array.from(new Set(size.overflowing));
  return (
    <section className="sp-label-preview" aria-label="Vorschau">
      <div className="sp-label-rows-head">
        <span className="sp-field-label">Vorschau</span>
        <small className="sp-label-summary">{wireSummary(segments, size.sizeDots)}</small>
      </div>
      {overflowing.length > 0 && (
        <p className="sp-label-warn" role="status">
          {`Zu lang für die Hülse bei einheitlicher Größe: ${overflowing.join(", ")}`}
        </p>
      )}
      <div className="sp-strip-preview">
        <div className="sp-strip-scroll">
          <StripSvg
            label={WIRE_STRIP_LABEL}
            segments={laid}
            lengthMm={piecesMm(segments)}
            fontPx={previewFontPx(size.sizeDots)}
            heightMm={tube.widthMm}
          />
        </div>
      </div>
    </section>
  );
}
