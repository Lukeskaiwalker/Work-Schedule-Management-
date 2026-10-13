/**
 * Top view of the sensor area: where the ▲▼ pointer of the sensor carriage
 * must stand on the housing's printed scale for this material
 * (docs/LABEL_PRINTER_CALIBRATION.md §7.8).
 *
 * Looking down into the open printer from the front: rear at the top, feed
 * direction downward. SVG user units are millimetres, so scale, slot, carriage
 * and media are to scale; only the stretch between sensor and print line is
 * shortened (the break mark says so).
 *
 * Every number comes from `sensorGeometry.ts`, read at render time — the owner
 * corrects the drawing from a photo by editing that module, never this one.
 * The media is drawn only in the "loaded" state and after the carriage, so the
 * first thing a person sees is where the pointer goes (critique M10: the sensor
 * is set before the media hides the scale).
 */
import { useId, type ReactElement } from "react";

import type { LabelMaterial } from "../../types/labelPrinter";
import {
  diagramDescription,
  formatScaleDe,
  laneSpans,
  targetOffsetMm,
  webWidthMm,
} from "../../utils/labelCalibration";
import { SENSOR_GEOMETRY, scaleToX } from "./sensorGeometry";
import "../../styles/label-calibration.css";

export interface LabelSensorDiagramProps {
  material: LabelMaterial;
  state: "sensor" | "loaded";
  zoom?: boolean;
  /** The reading typed into "Zeiger steht jetzt auf …"; null/absent = none. */
  actualScale?: number | null;
  de?: boolean;
}

type G = typeof SENSOR_GEOMETRY;
const mid = (band: readonly number[]) => (band[0] + band[1]) / 2;

/** Readings of the printed ticks, 0,6 … 5,4 in steps of 0,1 (one decimal, no float drift). */
function tickReadings(g: G): number[] {
  const count = Math.round((g.scaleTickTo - g.scaleTickFrom) / g.scaleTickStep) + 1;
  return Array.from({ length: count }, (_, i) => Math.round((g.scaleTickFrom + i * g.scaleTickStep) * 10) / 10);
}

function tickKind(reading: number, g: G): "long" | "medium" | "short" {
  if ((g.scaleNumbers as readonly number[]).includes(reading)) return "long";
  return Math.round(reading * 10) % 10 === 5 ? "medium" : "short";
}

function Scale({ g, target, textScale }: { g: G; target: number; textScale: number }) {
  const readings = tickReadings(g);
  const base = g.bands.tickBaseline;
  const targetPrinted = readings.includes(target);
  return (
    <g className="lc-scale">
      {readings.map((reading) => {
        const kind = tickKind(reading, g);
        const x = scaleToX(reading);
        const hit = reading === target;
        return (
          <line
            key={reading}
            className={`lc-tick${hit ? " lc-target-tick" : ""}`}
            data-kind={kind}
            x1={x}
            x2={x}
            y1={base}
            y2={base - g.tickLengthMm[kind]}
            strokeWidth={hit ? g.strokeMm.tick * 2 : g.strokeMm.tick}
          />
        );
      })}
      {!targetPrinted && (
        <line
          className="lc-target-tick"
          x1={scaleToX(target)}
          x2={scaleToX(target)}
          y1={base}
          y2={base - g.tickLengthMm.long}
          strokeWidth={g.strokeMm.tick * 2}
        />
      )}
      {g.scaleNumbers.map((n) => (
        <text key={n} className="lc-scale-number lc-text" x={scaleToX(n)} y={g.bands.scaleNumbers[1]} fontSize={g.scaleNumberSizeMm * textScale} textAnchor="middle">
          {n}
        </text>
      ))}
      {!g.measured && (
        <text
          className="lc-scale-approx lc-text"
          x={scaleToX(g.scaleNumbers[g.scaleNumbers.length - 1]) + g.approxGapMm}
          y={g.bands.scaleNumbers[1]}
          fontSize={g.scaleNumberSizeMm * textScale}
        >
          ≈
        </text>
      )}
    </g>
  );
}

/** ▲ above the optical window, ▼ below it; the ▲ apex marks the reading. */
function pointerPaths(g: G, x: number): { up: string; down: string } {
  const half = g.pointerWidthMm / 2;
  const top = g.bands.sensingY - g.pointerWindowMm / 2;
  const bottom = g.bands.sensingY + g.pointerWindowMm / 2;
  return {
    up: `M${x - half} ${top}L${x + half} ${top}L${x} ${top - g.pointerHeightMm}Z`,
    down: `M${x - half} ${bottom}L${x + half} ${bottom}L${x} ${bottom + g.pointerHeightMm}Z`,
  };
}

function Carriage({ g, x }: { g: G; x: number }) {
  const { up, down } = pointerPaths(g, x);
  const y = g.bands.sensingY - g.carriageDepthMm / 2;
  return (
    <g className="lc-carriage-group">
      <rect className="lc-carriage" x={x - g.carriageWidthMm / 2} y={y} width={g.carriageWidthMm} height={g.carriageDepthMm} rx={g.strokeMm.line} />
      <rect className="lc-carriage-core" x={x - g.carriageCoreWidthMm / 2} y={y} width={g.carriageCoreWidthMm} height={g.carriageDepthMm} />
      <g className="lc-pointer" data-x={x}>
        <path d={up} strokeWidth={g.strokeMm.thin} />
        <rect className="lc-pointer-window" x={x - g.pointerWidthMm / 2} y={g.bands.sensingY - g.pointerWindowMm / 2} width={g.pointerWidthMm} height={g.pointerWindowMm} />
        <path d={down} strokeWidth={g.strokeMm.thin} />
      </g>
    </g>
  );
}

function Callout({ g, x, y, text, size, className }: { g: G; x: number; y: number; text: string; size: number; className: string }) {
  const width = text.length * size * g.charWidthEm + 2 * g.calloutPadMm * (size / g.textSizeMm);
  return (
    <g className={className}>
      <rect
        className="lc-callout-box"
        x={x - width / 2}
        y={y - size * g.calloutBoxEm.top}
        width={width}
        height={size * g.calloutBoxEm.height}
        rx={(g.calloutPadMm / 2) * (size / g.textSizeMm)}
      />
      <text className="lc-callout-text lc-text" x={x} y={y} fontSize={size} textAnchor="middle">
        {text}
      </text>
    </g>
  );
}

function Actual({ g, x, target }: { g: G; x: number; target: number }) {
  const half = g.pointerWidthMm / 2;
  const base = g.bands.tickBaseline;
  const y = g.bands.sensingY - g.carriageDepthMm / 2;
  const arrowY = g.bands.shiftArrowY;
  const dir = Math.sign(target - x);
  const head = g.arrowHeadMm;
  return (
    <g className="lc-actual" data-x={x}>
      <path className="lc-actual-pointer" d={`M${x} ${base}L${x + half} ${base + g.pointerHeightMm}L${x - half} ${base + g.pointerHeightMm}Z`} strokeWidth={g.strokeMm.line} />
      <rect className="lc-actual-carriage" x={x - g.carriageWidthMm / 2} y={y} width={g.carriageWidthMm} height={g.carriageDepthMm} strokeWidth={g.strokeMm.line} />
      {dir !== 0 && (
        <path
          className="lc-shift-arrow"
          d={`M${x} ${arrowY}L${target} ${arrowY}M${target - dir * head} ${arrowY - head}L${target} ${arrowY}L${target - dir * head} ${arrowY + head}`}
          strokeWidth={g.strokeMm.line}
        />
      )}
    </g>
  );
}

function Media({ g, material, target, de }: { g: G; material: LabelMaterial; target: number; de: boolean }) {
  const top = g.viewBox.y;
  const bottom = g.bands.tearEdge;
  const sensing = g.bands.sensingY;
  const web = webWidthMm(material);
  const legends: string[] = [];
  const pieces: ReactElement[] = [];

  if (material.continuous) {
    pieces.push(<rect key="band" className="lc-band lc-label--white" x={-material.width_mm / 2} y={top} width={material.width_mm} height={bottom - top} />);
  } else {
    if (material.web.liner_width_mm !== null) {
      const liner = material.web.liner_width_mm;
      pieces.push(<rect key="liner" className="lc-liner" x={-liner / 2} y={top} width={liner} height={bottom - top} />);
    } else {
      pieces.push(<rect key="liner" className="lc-liner lc-liner--unknown" x={-web / 2} y={top} width={web} height={bottom - top} />);
      legends.push(de ? "Trägerbreite nicht hinterlegt" : "Liner width not on file");
    }
    const along = material.web.label_along_mm ?? material.length_mm ?? 0;
    const gap = material.gap_mm;
    const pitch = along + gap;
    const mark = material.mark_width_mm;
    const fill = mark !== null ? "lc-label--mark" : (g.silverMaterialIds as readonly string[]).includes(material.id) ? "lc-label--silver" : "lc-label--white";
    // Phase the labels so a gap (or the mark) is centred on the sensing point.
    const first = Math.floor((top - sensing) / pitch) - 1;
    const last = Math.ceil((bottom - sensing) / pitch) + 1;
    laneSpans(material).forEach(([left, right], lane) => {
      const labels: ReactElement[] = [];
      for (let k = first; k <= last && pitch > 0; k++) {
        const y0 = Math.max(top, sensing + gap / 2 + k * pitch);
        const y1 = Math.min(bottom, sensing + gap / 2 + k * pitch + along);
        if (y1 > y0) labels.push(<rect key={k} className={`lc-label ${fill}`} x={left} y={y0} width={right - left} height={y1 - y0} />);
      }
      pieces.push(<g key={`lane-${lane}`} className="lc-lane" data-lane={lane}>{labels}</g>);
    });
    if (mark !== null) {
      for (let k = first; k <= last && pitch > 0; k++) {
        const y = sensing - mark / 2 + k * pitch;
        if (y + mark > top && y < bottom) {
          pieces.push(<rect key={`mark-${k}`} className="lc-mark" x={target - g.markBarWidthMm / 2} y={y} width={g.markBarWidthMm} height={mark} />);
        }
      }
    }
  }
  if (material.guide === "max") {
    pieces.push(<rect key="outline" className="lc-media-outline" x={-web / 2} y={top} width={web} height={bottom - top} strokeWidth={g.strokeMm.line} />);
    legends.push(de ? "Lage bei offener Führung nicht festgelegt" : "Position not fixed with open guides");
  }
  return (
    <g className="lc-media">
      {pieces}
      {legends.map((text, i) => (
        <text key={text} className="lc-legend lc-text" x={0} y={g.legendY[i]} fontSize={g.breakLabelSizeMm} textAnchor="middle">
          {text}
        </text>
      ))}
    </g>
  );
}

function Beam({ g, material, x }: { g: G; material: LabelMaterial; x: number }) {
  const y = g.bands.sensingY;
  const r = g.beamSpotRadiusMm;
  const mode = material.sensor_mode;
  if (mode === "see_through") {
    return (
      <g className="lc-beam lc-beam--see_through">
        <circle cx={x} cy={y} r={r} strokeWidth={g.strokeMm.thin} />
        <circle cx={x} cy={y} r={r / 2} strokeWidth={g.strokeMm.thin} />
      </g>
    );
  }
  if (mode === "reflective") {
    return <path className="lc-beam lc-beam--reflective" d={`M${x - r} ${y - r}L${x} ${y + r}L${x + r} ${y - r}`} strokeWidth={g.strokeMm.line} />;
  }
  if (mode === "auto") return <circle className="lc-beam lc-beam--auto" cx={x} cy={y} r={r} strokeWidth={g.strokeMm.thin} />;
  return <circle className="lc-beam lc-beam--none" cx={x} cy={y} r={r / 2} />;
}

function Platen({ g, material, de }: { g: G; material: LabelMaterial; de: boolean }) {
  const half = g.platenHalfWidthMm;
  const [p0, p1] = g.bands.platen;
  const zig = g.breakZigzagMm;
  const tooth = g.tearToothMm;
  const steps = Math.round((2 * half) / tooth);
  const zigzag = Array.from({ length: steps + 1 }, (_, i) => `${i === 0 ? "M" : "L"}${-half + i * tooth} ${g.bands.breakMark + (i % 2 ? zig / 2 : -zig / 2)}`).join("");
  const teeth = Array.from({ length: steps + 1 }, (_, i) => `${i === 0 ? "M" : "L"}${-half + i * tooth} ${g.bands.tearEdge + (i % 2 ? tooth / 2 : 0)}`).join("");
  const green = material.roller === "258-5007";
  return (
    <g className="lc-platen">
      <path className="lc-break" d={zigzag} strokeWidth={g.strokeMm.line} />
      <text className="lc-legend lc-text" x={g.viewBox.x + g.viewBox.width - g.calloutPadMm} y={g.bands.platen[0] - g.calloutPadMm / 2} fontSize={g.breakLabelSizeMm} textAnchor="end">
        {de ? "nicht maßstäblich" : "not to scale"}
      </text>
      <rect className={green ? "lc-roller-5007" : "lc-roller-5006"} x={-half} y={p0} width={2 * half} height={p1 - p0} rx={(p1 - p0) / 2} />
      {green && <line className="lc-roller-groove" x1={0} x2={0} y1={p0} y2={p1} strokeWidth={g.strokeMm.line} />}
      <line className="lc-print-line" x1={-half} x2={half} y1={g.bands.printLine} y2={g.bands.printLine} strokeWidth={g.strokeMm.line} />
      <path className="lc-tear" d={teeth} strokeWidth={g.strokeMm.line} />
    </g>
  );
}

export function LabelSensorDiagram({ material, state, zoom = false, actualScale = null, de = true }: LabelSensorDiagramProps) {
  const ids = useId();
  const g = SENSOR_GEOMETRY;
  const target = targetOffsetMm(material);
  const vb = g.viewBox;
  const viewBox = zoom
    ? `${target - g.zoomHalfWidthMm} ${g.zoomBand[0]} ${2 * g.zoomHalfWidthMm} ${g.zoomBand[1] - g.zoomBand[0]}`
    : `${vb.x} ${vb.y} ${vb.width} ${vb.height}`;
  const textScale = zoom ? g.zoomTextScale : 1;
  const textSize = g.textSizeMm * textScale;
  const guideInner = material.guide === "fit" ? webWidthMm(material) / 2 + g.guideFitClearanceMm : g.guideMaxHalfOpeningMm;
  const [g0, g1] = g.bands.guide;
  const [h0, h1] = g.bands.housing;
  const [s0, s1] = g.bands.slot;
  const slotLeft = scaleToX(g.slotReadings[0]);
  const slotRight = scaleToX(g.slotReadings[1]);
  const title = zoom
    ? de ? "Sensorposition – Lupe" : "Sensor position – magnified"
    : de ? "Sensorposition – Draufsicht" : "Sensor position – top view";

  return (
    <svg
      className={`lc-diagram lc-sensor-diagram${zoom ? " lc-sensor-diagram--zoom" : ""}`}
      viewBox={viewBox}
      role="img"
      aria-labelledby={`${ids}-t ${ids}-d`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={`${ids}-t`}>{title}</title>
      <desc id={`${ids}-d`}>{diagramDescription(material, state, actualScale, de)}</desc>
      <rect className="lc-bg" x={vb.x} y={vb.y} width={vb.width} height={vb.height} />
      <g className="lc-guides">
        <rect className="lc-guide" x={-guideInner - g.guideJawWidthMm} y={g0} width={g.guideJawWidthMm} height={g1 - g0} />
        <rect className="lc-guide" x={guideInner} y={g0} width={g.guideJawWidthMm} height={g1 - g0} />
        {material.guide === "max" && (
          <text className="lc-legend lc-text" x={0} y={mid(g.bands.guide)} fontSize={g.textSizeMm} textAnchor="middle">
            {de ? "ganz offen" : "fully open"}
          </text>
        )}
      </g>
      <rect className="lc-housing" x={vb.x} y={h0} width={vb.width} height={h1 - h0} />
      <Scale g={g} target={material.sensor_scale} textScale={textScale} />
      <rect className="lc-slot" x={slotLeft} y={s0} width={slotRight - slotLeft} height={s1 - s0} />
      <Carriage g={g} x={target} />
      {state === "loaded" && <Media g={g} material={material} target={target} de={de} />}
      <Beam g={g} material={material} x={target} />
      {/* Callouts and the Ist marks above the media: at 60 % opacity it would wash them out. */}
      {actualScale !== null && <Actual g={g} x={scaleToX(actualScale)} target={target} />}
      <Callout g={g} x={target} y={g.bands.calloutTarget} size={textSize} text={`${de ? "Ziel" : "Target"}: ${formatScaleDe(material.sensor_scale)}`} className="lc-callout" />
      {actualScale !== null && (
        <Callout g={g} x={scaleToX(actualScale)} y={g.bands.calloutActual} size={textSize} text={`${de ? "Ist" : "Now"}: ${formatScaleDe(actualScale)}`} className="lc-actual-callout" />
      )}
      <Platen g={g} material={material} de={de} />
    </svg>
  );
}
