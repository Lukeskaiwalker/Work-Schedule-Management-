/**
 * A marking strip as the printer will cut it, scaled for the screen.
 *
 * Shared by the BMK preview (one strip per rail) and the Reihenklemmen
 * preview (one strip per Leiste): both are a band with a lead at either
 * end, a cut line on every segment boundary, heavier lines at the start and
 * the end, and every text centred on its segment at ONE font size. Only the
 * segment list differs — device widths for BMK, part widths for terminals —
 * so the geometry lives here once and takes `segments` rather than a rail.
 *
 * `BlockSvg` is the second shape the 2009-110 comes in: the 60 mm label of
 * a 16 mm² terminal Block, three rows on the same band — the name, the X
 * number, one cell per terminal — with short dividers in the bottom row
 * only (`werkstatt_labels._render_block_label`).
 */
import { DOTS_PER_MM, STRIP_HEIGHT_MM, STRIP_LEAD_MM, formatMm } from "../../utils/schaltplanStrip";
import { blockCellSizeDots, blockRowSizeDots } from "../../utils/schaltplanTerminals";

/** Preview scale. 2.4 px/mm puts a 12-module rail at ~520 px — scrollable on a phone, whole on a tablet. */
export const PX_PER_MM = 2.4;
/** The same scale in printer dots, so the board font size lands on screen at its true proportion. */
export const PX_PER_DOT = PX_PER_MM / DOTS_PER_MM;
/** Room above and below the band so the thick end lines are not clipped. */
const BAND_PAD_PX = 6;

/** Font size for the preview, in px, rounded so SVG attributes do not carry float noise. */
export function previewFontPx(sizeDots: number): number {
  return Math.round(sizeDots * PX_PER_DOT * 100) / 100;
}

export interface PreviewSegment {
  key: string;
  text: string;
  widthMm: number;
  /** Running offset in mm from the first segment. */
  start: number;
}

/** Lay `segments` end to end: the running offsets the SVG draws from. */
export function layoutSegments(segments: readonly { key: string; text: string; widthMm: number }[]): PreviewSegment[] {
  return segments.reduce<PreviewSegment[]>((laid, segment) => {
    const previous = laid[laid.length - 1];
    const start = previous ? previous.start + previous.widthMm : 0;
    return [...laid, { ...segment, start }];
  }, []);
}

type Props = {
  /** Named in the accessible label: "Streifen Reihe 1" / "Streifen X1 · FI F1 · Reihe 1". */
  label: string;
  segments: readonly PreviewSegment[];
  /** Printed length between the start and end lines, in mm. */
  lengthMm: number;
  fontPx: number;
};

export function StripSvg({ label, segments, lengthMm, fontPx }: Props) {
  const total = STRIP_LEAD_MM + lengthMm + STRIP_LEAD_MM;
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
      aria-label={`Streifen ${label}, ${formatMm(total)} mm`}
    >
      <rect className="sp-strip-band" x={0} y={top} width={width} height={band} />
      <rect className="sp-strip-lead" x={0} y={top} width={leadPx} height={band} />
      <rect className="sp-strip-lead" x={x(lengthMm)} y={top} width={leadPx} height={band} />
      {segments.map((segment, index) => (
        <g key={segment.key}>
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
      <line className="sp-strip-end" x1={x(lengthMm)} x2={x(lengthMm)} y1={top - 3} y2={bottom + 3} />
    </svg>
  );
}

type BlockProps = {
  /** Named in the accessible label: "Block X2 · Block F1.4 Wallbox Garage". */
  label: string;
  /** The top row — the consumer's name; "" leaves the row empty. */
  name: string;
  /** The middle row — "X2"; "" leaves the row empty. */
  xLabel: string;
  /** The bottom row, one cell per terminal, laid end to end. */
  cells: readonly PreviewSegment[];
  /** Width of the block between the end lines, in mm (five 12 mm terminals = 60). */
  lengthMm: number;
};

/** Three rows on one 60 mm piece: name, X number, and the cells N L1 L2 L3 PE with short dividers. */
export function BlockSvg({ label, name, xLabel, cells, lengthMm }: BlockProps) {
  const total = STRIP_LEAD_MM + lengthMm + STRIP_LEAD_MM;
  const width = total * PX_PER_MM;
  const band = STRIP_HEIGHT_MM * PX_PER_MM;
  const rowHeight = band / 3;
  const height = band + BAND_PAD_PX * 2;
  const top = BAND_PAD_PX;
  const bottom = top + band;
  const leadPx = STRIP_LEAD_MM * PX_PER_MM;
  const x = (mm: number) => leadPx + mm * PX_PER_MM;
  const centre = x(lengthMm / 2);
  const rows: { key: string; text: string }[] = [
    { key: "name", text: name },
    { key: "x", text: xLabel },
  ];

  return (
    <svg
      className="sp-strip-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Block ${label}, ${formatMm(total)} mm`}
    >
      <rect className="sp-strip-band" x={0} y={top} width={width} height={band} />
      <rect className="sp-strip-lead" x={0} y={top} width={leadPx} height={band} />
      <rect className="sp-strip-lead" x={x(lengthMm)} y={top} width={leadPx} height={band} />
      {rows.map((row, index) =>
        row.text === "" ? null : (
          <text
            key={row.key}
            className="sp-strip-text sp-block-row"
            x={centre}
            y={top + rowHeight * (index + 0.5)}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={previewFontPx(blockRowSizeDots(row.text, lengthMm))}
          >
            {row.text}
          </text>
        ),
      )}
      {/* Two rules between the three rows, the width of the block — as printed. */}
      {[1, 2].map((row) => (
        <line
          key={`rule-${row}`}
          className="sp-strip-cut sp-block-rule"
          x1={x(0)}
          x2={x(lengthMm)}
          y1={top + rowHeight * row}
          y2={top + rowHeight * row}
        />
      ))}
      {cells.map((cell, index) => (
        <g key={cell.key}>
          {index > 0 && (
            <line
              className="sp-strip-cut sp-block-cell-cut"
              x1={x(cell.start)}
              x2={x(cell.start)}
              y1={top + rowHeight * 2}
              y2={bottom}
            />
          )}
          {cell.text !== "" && (
            <text
              className="sp-strip-text sp-block-cell"
              x={x(cell.start + cell.widthMm / 2)}
              y={top + rowHeight * 2.5}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={previewFontPx(blockCellSizeDots(cell.text, cell.widthMm))}
            >
              {cell.text}
            </text>
          )}
        </g>
      ))}
      <line className="sp-strip-end" x1={x(0)} x2={x(0)} y1={top - 3} y2={bottom + 3} />
      <line className="sp-strip-end" x1={x(lengthMm)} x2={x(lengthMm)} y1={top - 3} y2={bottom + 3} />
    </svg>
  );
}
