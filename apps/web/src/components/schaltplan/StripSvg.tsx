/**
 * A marking strip as the printer will cut it, scaled for the screen.
 *
 * Shared by the BMK preview (one strip per rail) and the Reihenklemmen
 * preview (one strip per FI group): both are a band with a lead at either
 * end, a cut line on every segment boundary, heavier lines at the start and
 * the end, and every text centred on its segment at ONE font size. Only the
 * segment list differs — device widths for BMK, part widths for terminals —
 * so the geometry lives here once and takes `segments` rather than a rail.
 */
import { DOTS_PER_MM, STRIP_HEIGHT_MM, STRIP_LEAD_MM, formatMm } from "../../utils/schaltplanStrip";

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
  /** Named in the accessible label: "Streifen Reihe 1" / "Streifen FI F1 · Reihe 1". */
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
