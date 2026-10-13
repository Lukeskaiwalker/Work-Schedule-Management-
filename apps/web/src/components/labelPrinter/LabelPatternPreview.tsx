/**
 * "What to measure" on the printed measuring pattern
 * (docs/LABEL_PRINTER_CALIBRATION.md §4.11, §7.8): the label to scale with the
 * printed box, and dimension arrows A, B, L, R from the physical edges to the
 * box lines — the distances the operator measures with the caliper.
 *
 * Drawn from the `PatternGeometry` the server returned with the print, so the
 * picture always matches what came out of the printer. Feed runs right → left:
 * edge A leaves the printer first.
 */
import { useId } from "react";

import type { PatternGeometry } from "../../types/labelPrinter";
import { formatMmDe } from "../../utils/labelCalibration";
import { SENSOR_GEOMETRY } from "./sensorGeometry";
import "../../styles/label-calibration.css";

export interface PatternOffsets {
  lead?: number | null;
  trail?: number | null;
  left?: number | null;
  right?: number | null;
}

export interface LabelPatternPreviewProps {
  geometry: PatternGeometry;
  offsets?: PatternOffsets;
  de?: boolean;
}

function label(letter: string, value: number | null | undefined): string {
  return value === null || value === undefined ? letter : `${letter} ${formatMmDe(value)}`;
}

export function LabelPatternPreview({ geometry, offsets = {}, de = true }: LabelPatternPreviewProps) {
  const ids = useId();
  const p = SENSOR_GEOMETRY.patternPreview;
  const stroke = SENSOR_GEOMETRY.strokeMm.thin;
  const length = geometry.length_mm;
  const width = geometry.width_mm;
  const diecut = geometry.kind === "diecut";
  const inset = diecut ? geometry.inset_mm : geometry.side_line_inset_mm ?? geometry.inset_mm;
  const t = diecut ? geometry.line_mm : p.continuousLineMm;
  const text = Math.max(p.textSizeMm, Math.max(length, width) * p.textPerLength);
  const pad = text * p.paddingEm;
  const above = -text * p.arrowOffsetEm;
  const leftOf = -text * p.arrowOffsetEm;
  const ext = text * p.extensionEm;

  const hArrow = (x0: number, x1: number, key: string, name: string) => (
    <g key={key} className="lc-pattern-dimension">
      <path className="lc-pattern-dim" d={`M${x0} ${0}L${x0} ${above - ext}M${x1} ${inset}L${x1} ${above - ext}M${x0} ${above}L${x1} ${above}`} strokeWidth={stroke} />
      <text className="lc-pattern-dim-text lc-text" x={(x0 + x1) / 2} y={above - ext} fontSize={text} textAnchor="middle">
        {name}
      </text>
    </g>
  );
  const vArrow = (y0: number, y1: number, key: string, name: string) => (
    <g key={key} className="lc-pattern-dimension">
      <path className="lc-pattern-dim" d={`M${0} ${y0}L${leftOf - ext} ${y0}M${inset} ${y1}L${leftOf - ext} ${y1}M${leftOf} ${y0}L${leftOf} ${y1}`} strokeWidth={stroke} />
      <text className="lc-pattern-dim-text lc-text" x={leftOf - ext} y={(y0 + y1) / 2 + text / 3} fontSize={text} textAnchor="end">
        {name}
      </text>
    </g>
  );

  const bar = geometry.bar_inset_mm ?? inset;
  const rulerY = width - inset - t - p.rulerBaselineGapMm;
  const description = diecut
    ? de
      ? `Messmuster ${formatMmDe(length)} × ${formatMmDe(width)} mm: Rahmen ${formatMmDe(inset)} mm vom Rand. A = Abstand vorne, B = hinten, L = links, R = rechts.`
      : `Measuring pattern ${formatMmDe(length)} × ${formatMmDe(width)} mm: frame ${formatMmDe(inset)} mm from the edge. A = front, B = rear, L = left, R = right.`
    : de
      ? `Messmuster auf ${formatMmDe(width)} mm Endlosmaterial: Seitenlinien ${formatMmDe(inset)} mm vom Rand, L = links, R = rechts.`
      : `Measuring pattern on ${formatMmDe(width)} mm continuous stock: side lines ${formatMmDe(inset)} mm from the edge, L = left, R = right.`;

  return (
    <svg
      className="lc-diagram lc-pattern-preview"
      viewBox={`${-pad - text} ${-pad} ${length + 2 * pad + text} ${width + 2 * pad}`}
      role="img"
      aria-labelledby={`${ids}-t ${ids}-d`}
    >
      <title id={`${ids}-t`}>{de ? "Was gemessen wird" : "What to measure"}</title>
      <desc id={`${ids}-d`}>{description}</desc>
      <rect className="lc-pattern-label" x={0} y={0} width={length} height={width} strokeWidth={stroke} />
      {diecut ? (
        <g className="lc-pattern-box">
          <rect className="lc-pattern-line" x={inset} y={inset} width={t} height={width - 2 * inset} />
          <rect className="lc-pattern-line" x={length - inset - t} y={inset} width={t} height={width - 2 * inset} />
          <rect className="lc-pattern-line" x={inset} y={inset} width={length - 2 * inset} height={t} />
          <rect className="lc-pattern-line" x={inset} y={width - inset - t} width={length - 2 * inset} height={t} />
          <rect className="lc-pattern-line" x={length / 2 - p.crossArmMm} y={width / 2 - t / 2} width={2 * p.crossArmMm} height={t} />
          <rect className="lc-pattern-line" x={length / 2 - t / 2} y={width / 2 - p.crossArmMm} width={t} height={2 * p.crossArmMm} />
        </g>
      ) : (
        <g className="lc-pattern-box">
          <rect className="lc-pattern-line" x={bar} y={inset} width={length - 2 * bar} height={t} />
          <rect className="lc-pattern-line" x={bar} y={width - inset - t} width={length - 2 * bar} height={t} />
          <rect className="lc-pattern-line" x={bar} y={inset} width={t * 2} height={width - 2 * inset} />
          <rect className="lc-pattern-line" x={length - bar - t * 2} y={inset} width={t * 2} height={width - 2 * inset} />
        </g>
      )}
      {geometry.letters && diecut && (
        <g className="lc-pattern-letters">
          <text className="lc-text" x={inset + t + p.letterInsetMm} y={width / 2 + p.letterShiftMm} fontSize={text}>A</text>
          <text className="lc-text" x={length / 2 + p.letterShiftMm} y={inset + t + p.letterInsetMm + text} fontSize={text}>L</text>
        </g>
      )}
      {diecut && geometry.ruler_from_mm !== null && geometry.ruler_to_mm !== null && (
        <g className="lc-pattern-ruler">
          <path
            className="lc-pattern-dim"
            d={Array.from(
              { length: Math.floor((geometry.ruler_to_mm - geometry.ruler_from_mm) / p.rulerStepMm) + 1 },
              (_, k) => `M${geometry.ruler_from_mm! + k * p.rulerStepMm} ${rulerY}l0 ${-p.rulerTickMm}`,
            ).join("") + `M${geometry.ruler_from_mm} ${rulerY}L${geometry.ruler_to_mm} ${rulerY}`}
            strokeWidth={stroke}
          />
          <text className="lc-pattern-dim-text lc-text" x={(geometry.ruler_from_mm + geometry.ruler_to_mm) / 2} y={rulerY - p.rulerTickMm - ext} fontSize={text} textAnchor="middle">
            {`${geometry.ruler_from_mm} → ${geometry.ruler_to_mm}`}
          </text>
        </g>
      )}
      {diecut && hArrow(0, inset, "a", label("A", offsets.lead))}
      {diecut && hArrow(length, length - inset, "b", label("B", offsets.trail))}
      {vArrow(0, inset, "l", label("L", offsets.left))}
      {vArrow(width, width - inset, "r", label("R", offsets.right))}
    </svg>
  );
}
