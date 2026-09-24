/**
 * Schematic preview of the Schrank-Etikett — the silver 99 × 44 mm type
 * label (WAGO 210-804) stuck on the finished panel.
 *
 * The real layout is rendered server-side from the owner's blueprint; this
 * box only mirrors its proportions so the electrician sees what the fields
 * will say before the label leaves the printer. Logo and QR code are the
 * server's own renderings (`typeLabelLogoUrl` / `typeLabelQrUrl`), so the
 * only thing that differs from the print is the font. Positions live in
 * `styles.css` (`.sp-type-label*`), as percentages of the label.
 *
 * Bottom-left sits the panel number as a DataMatrix, the code the Regal
 * station scans. The preview draws a placeholder symbol — the real one is
 * the printer's — with the finder pattern where a DataMatrix has it (solid
 * L on the left and bottom, alternating clock track on top and right) and
 * the inner cells seeded from the number, so the same panel always shows
 * the same picture and two panels never show the same one.
 */
import { useMemo } from "react";

import { typeLabelLogoUrl, typeLabelQrUrl } from "../../utils/schaltplanApi";

type Props = {
  customer: string;
  projectNumber: string | null;
  buildMonth: string;
  contactLines: string[];
  /** "VT-0007" — drawn bottom-left with the placeholder DataMatrix; null draws neither. */
  panelNumber: string | null;
};

/** What the Projekt line shows for a panel without a project. */
const NO_PROJECT = "—";

/** Modules per side of the placeholder symbol (a 12 × 12 ECC200 holds a "VT-0007"). */
export const MATRIX_SIZE = 12;

/** FNV-1a over the code, so the placeholder pattern is a pure function of it. */
function hashCode(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The placeholder's cells, row by row, true = dark. Left column and bottom
 * row are solid (the L finder), top row and right column alternate (the
 * clock track), and the 10 × 10 inside follows an xorshift stream seeded
 * from the code.
 */
export function placeholderMatrix(code: string): boolean[][] {
  let state = hashCode(code) || 1;
  const nextBit = (): boolean => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (state & 1) === 1;
  };
  const last = MATRIX_SIZE - 1;
  return Array.from({ length: MATRIX_SIZE }, (_, row) =>
    Array.from({ length: MATRIX_SIZE }, (_, col) => {
      if (col === 0 || row === last) return true;
      if (row === 0) return col % 2 === 0;
      if (col === last) return row % 2 === 1;
      return nextBit();
    }),
  );
}

function PlaceholderMatrix({ code }: { code: string }) {
  const cells = useMemo(() => placeholderMatrix(code), [code]);
  return (
    <svg
      className="sp-type-label-matrix"
      viewBox={`0 0 ${MATRIX_SIZE} ${MATRIX_SIZE}`}
      role="img"
      aria-label={`DataMatrix ${code}`}
      shapeRendering="crispEdges"
    >
      {cells.flatMap((row, y) =>
        row.map((dark, x) => (dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} /> : null)),
      )}
    </svg>
  );
}

export function PanelTypeLabelPreview({ customer, projectNumber, buildMonth, contactLines, panelNumber }: Props) {
  return (
    <div className="sp-type-label" aria-label="Vorschau Schrank-Etikett">
      <img className="sp-type-label-logo" src={typeLabelLogoUrl()} alt="SMPL-Logo" />
      <img className="sp-type-label-qr" src={typeLabelQrUrl()} alt="QR-Code smpl-energy.de" />
      <div className="sp-type-label-lines">
        <div>{`Kunde: ${customer}`}</div>
        <div>{`Projekt: ${projectNumber ?? NO_PROJECT}`}</div>
        <div>{`Baujahr: ${buildMonth}`}</div>
      </div>
      {panelNumber && (
        <div className="sp-type-label-number">
          <PlaceholderMatrix code={panelNumber} />
          <span className="sp-type-label-number-text">{panelNumber}</span>
        </div>
      )}
      <div className="sp-type-label-contact">
        {contactLines.map((line, index) => (
          <div key={`${index}-${line}`}>{line}</div>
        ))}
      </div>
    </div>
  );
}
