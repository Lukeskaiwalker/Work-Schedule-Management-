/**
 * Side view of the media path, schematic (docs/LABEL_PRINTER_CALIBRATION.md
 * §7.8): roll → rear slot → guide → sensor → platen under the head → tear edge,
 * feed from left to right.
 *
 * Not to scale and labelled so. It answers the questions the top view cannot:
 * where the external unwinder stands and which way it unrolls, and which side
 * of the media the sensor looks from. Every position is a constant in
 * `sensorGeometry.ts` (`sideView`).
 */
import { useId } from "react";

import type { LabelMaterial } from "../../types/labelPrinter";
import { SENSOR_GEOMETRY } from "./sensorGeometry";
import "../../styles/label-calibration.css";

export interface LabelPathSideViewProps {
  material: LabelMaterial;
  de?: boolean;
}

export function LabelPathSideView({ material, de = true }: LabelPathSideViewProps) {
  const ids = useId();
  const s = SENSOR_GEOMETRY.sideView;
  const stroke = SENSOR_GEOMETRY.strokeMm.line;
  const external = material.feed_path === "external";
  const roll = external ? s.rollExternal : s.rollInternal;
  const y = s.pathY;
  const [hx0, hx1] = s.housingX;
  const [hy0, hy1] = s.housingY;
  const unitX = s.sensorX - s.unitWidth / 2;
  const below = y + s.unitGap;
  const above = y - s.unitGap - s.unitHeight;
  const mode = material.sensor_mode;
  const rollerClass = material.roller === "258-5007" ? "lc-roller-5007" : "lc-roller-5006";
  const headY = y - s.ribbonDrop - s.headHeight;
  const labelY = hy1 + s.textSize + s.labelGap;
  const arc = roll.r + s.arrowGap;
  const description = de
    ? `Materialweg von links nach rechts: ${external ? "externer Abroller, Abrollrichtung links" : "interner Rollenhalter"}, hinterer Schlitz, Führung, Sensor, Andruckwalze unter dem Druckkopf, Abreißkante.`
    : `Media path left to right: ${external ? "external unwinder, unwinding to the left" : "internal roll holder"}, rear slot, guide, sensor, platen under the head, tear edge.`;

  return (
    <figure className="lc-figure">
      <svg
        className="lc-diagram lc-side-view"
        viewBox={`${s.viewBox.x} ${s.viewBox.y} ${s.viewBox.width} ${s.viewBox.height}`}
        role="img"
        aria-labelledby={`${ids}-t ${ids}-d`}
      >
        <title id={`${ids}-t`}>{de ? "Materialweg – Seitenansicht" : "Media path – side view"}</title>
        <desc id={`${ids}-d`}>{description}</desc>
        <rect className="lc-bg" x={s.viewBox.x} y={s.viewBox.y} width={s.viewBox.width} height={s.viewBox.height} />
        <rect className="lc-side-housing" x={hx0} y={hy0} width={hx1 - hx0} height={hy1 - hy0} strokeWidth={stroke} rx={s.cornerRadius} />

        {external && (
          <g className="lc-side-unwinder-group">
            <path className="lc-side-unwinder" d={`M${roll.cx} ${roll.cy}L${roll.cx} ${hy1}M${roll.cx - roll.r} ${hy1}L${roll.cx + roll.r} ${hy1}`} strokeWidth={stroke} />
            {/* counter-clockwise arc: the media leaves the roll at the top, toward the printer */}
            <path
              className="lc-side-arrow"
              d={`M${roll.cx + arc} ${roll.cy}A${arc} ${arc} 0 0 0 ${roll.cx} ${roll.cy - arc}l${s.arrowHead} ${-s.arrowHead}M${roll.cx} ${roll.cy - arc}l${s.arrowHead} ${s.arrowHead}`}
              strokeWidth={stroke}
            />
            <text className="lc-legend lc-text" x={roll.cx} y={labelY} fontSize={s.textSize} textAnchor="start">
              {de ? "Abrollrichtung links" : "Unwinding to the left"}
            </text>
          </g>
        )}
        <circle className="lc-side-roll" cx={roll.cx} cy={roll.cy} r={roll.r} strokeWidth={stroke} />
        <path className="lc-side-path" d={`M${roll.cx} ${roll.cy - roll.r}L${s.rearSlotX} ${y}L${s.tearX} ${y}`} strokeWidth={stroke} />

        <rect className="lc-side-part" x={s.rearSlotX - s.slotWidth / 2} y={y - s.unitHeight} width={s.slotWidth} height={s.unitHeight * 2} />
        <rect className="lc-side-guide" x={s.guideX - s.guideWidth / 2} y={y - s.unitHeight} width={s.guideWidth} height={s.unitHeight - s.ribbonDrop} strokeWidth={stroke / 2} />

        {mode === "none" ? (
          <rect className="lc-side-sensor lc-side-sensor--none" x={unitX} y={below} width={s.unitWidth} height={s.unitHeight} />
        ) : mode === "reflective" ? (
          <g className="lc-side-sensor-group">
            <rect className="lc-side-sensor" x={unitX} y={below} width={s.unitWidth} height={s.unitHeight} />
            <path className="lc-side-beam" d={`M${s.sensorX - s.beamSpread} ${below}L${s.sensorX} ${y}L${s.sensorX + s.beamSpread} ${below}`} strokeWidth={stroke} />
          </g>
        ) : (
          <g className="lc-side-sensor-group">
            <rect className="lc-side-sensor" x={unitX} y={below} width={s.unitWidth} height={s.unitHeight} />
            <rect className="lc-side-sensor" x={unitX} y={above} width={s.unitWidth} height={s.unitHeight} />
            <line className="lc-side-beam" x1={s.sensorX} x2={s.sensorX} y1={below} y2={above + s.unitHeight} strokeWidth={stroke} />
          </g>
        )}

        <line className="lc-side-housing" x1={s.ribbonRoll.cx - s.lidOverhang} x2={s.tearX} y1={s.lidY} y2={s.lidY} strokeWidth={stroke} />
        <circle className="lc-side-ribbon" cx={s.ribbonRoll.cx} cy={s.ribbonRoll.cy} r={s.ribbonRoll.r} strokeWidth={stroke} />
        <circle className="lc-side-ribbon" cx={s.ribbonTakeUp.cx} cy={s.ribbonTakeUp.cy} r={s.ribbonTakeUp.r} strokeWidth={stroke} />
        <path
          className="lc-side-ribbon"
          d={`M${s.ribbonRoll.cx} ${s.ribbonRoll.cy + s.ribbonRoll.r}L${s.platenCx - s.headWidth / 2} ${y - s.ribbonDrop}L${s.platenCx + s.headWidth / 2} ${y - s.ribbonDrop}L${s.ribbonTakeUp.cx} ${s.ribbonTakeUp.cy + s.ribbonTakeUp.r}`}
          strokeWidth={stroke}
        />
        <rect className="lc-side-part" x={s.platenCx - s.headWidth / 2} y={headY} width={s.headWidth} height={s.headHeight} />
        <circle className={rollerClass} cx={s.platenCx} cy={y + s.platenR} r={s.platenR} />
        <path className="lc-tear" d={`M${s.tearX} ${y - s.tearHalf}L${s.tearX} ${y + s.tearHalf}`} strokeWidth={stroke * 2} />

        <text className="lc-legend lc-text" x={s.sensorX} y={labelY} fontSize={s.textSize} textAnchor="middle">
          Sensor
        </text>
        <text className="lc-legend lc-text" x={s.platenCx} y={labelY} fontSize={s.textSize} textAnchor="middle">
          {material.roller}
        </text>
      </svg>
      <figcaption className="lc-small">{de ? "schematisch, nicht maßstäblich" : "schematic, not to scale"}</figcaption>
    </figure>
  );
}
