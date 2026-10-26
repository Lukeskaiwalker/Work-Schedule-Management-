/**
 * The §14a block as the §14a sheet draws it (docs/PANEL_ENCLOSURE_R4.md
 * §8.2): 249-116 | n × 2002-1671 | 2002-1692 | 249-116 at 5 px/mm, each
 * terminal's marker written at its print size and turned to read bottom →
 * top — as it sits on the rail — and a short wire stub in the wire's colour
 * under each terminal (weiß and rosa outlined so they read on white).
 * Positions come from `controlBlockDrawing`; nothing here computes one.
 */
import { useMemo } from "react";

import { controlBlockDrawing, type DrawnPart } from "./controlBlockLayout";
import { OUTLINED_WIRE_COLOURS, WIRE_COLOUR_STYLE, WIRE_OUTLINE_COLOUR } from "../../../utils/enclosureControlBlock";
import type { ControlTerminal } from "../../../types/panelEnclosure";
import "../../../styles/schaltplan-enclosure-control.css";

/** The stub's width across the terminal, as a share of the terminal. */
const STUB_SHARE = 0.55;

const PART_CLASS: Readonly<Record<DrawnPart["partId"], string>> = {
  "249-116": "sp-encl-control-part--endstop",
  "2002-1671": "sp-encl-control-part--terminal",
  "2002-1692": "sp-encl-control-part--plate",
};

function Marker({ part, band, fontPx }: { part: DrawnPart; band: { y: number; h: number }; fontPx: number }) {
  const cx = part.x + part.w / 2;
  const cy = band.y + band.h / 2;
  return (
    <>
      <rect className="sp-encl-control-marker" x={part.x + 0.5} y={band.y} width={Math.max(0, part.w - 1)} height={band.h} />
      {part.label ? (
        <text x={cx} y={cy} transform={`rotate(-90 ${cx} ${cy})`} textAnchor="middle" dominantBaseline="central" fontSize={fontPx}>
          {part.label}
        </text>
      ) : null}
    </>
  );
}

function Stub({ part, stub }: { part: DrawnPart; stub: { y: number; h: number } }) {
  if (!part.color) return null;
  const w = part.w * STUB_SHARE;
  const outlined = OUTLINED_WIRE_COLOURS.has(part.color);
  return (
    <rect
      className="sp-encl-control-stub"
      data-colour={part.color}
      x={part.x + (part.w - w) / 2}
      y={stub.y}
      width={w}
      height={stub.h}
      fill={WIRE_COLOUR_STYLE[part.color]}
      stroke={outlined ? WIRE_OUTLINE_COLOUR : "none"}
      strokeWidth={outlined ? 1 : 0}
    />
  );
}

export function ControlBlockSvg({ terminals }: { terminals: readonly ControlTerminal[] }) {
  const drawing = useMemo(() => controlBlockDrawing(terminals), [terminals]);
  return (
    <svg
      className="sp-term-svg sp-encl-control-svg"
      width={drawing.width}
      height={drawing.height}
      viewBox={`0 0 ${drawing.width} ${drawing.height}`}
      role="img"
      aria-label={drawing.ariaLabel}
    >
      {drawing.parts.map((part) => (
        <g key={part.key} data-part={part.partId}>
          {part.partId === "2002-1671" ? <Stub part={part} stub={drawing.stub} /> : null}
          <rect className={`sp-encl-control-part ${PART_CLASS[part.partId]}`} x={part.x} y={part.y} width={part.w} height={part.h} />
          {part.partId === "2002-1671" ? <Marker part={part} band={drawing.marker} fontPx={drawing.fontPx} /> : null}
        </g>
      ))}
    </svg>
  );
}
