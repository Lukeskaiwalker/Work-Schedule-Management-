/**
 * Schematic glyphs for panel devices.
 *
 * Drawn on a 24×24 viewBox and coloured via `currentColor`, so one component
 * serves the diagram, the rail editor and the palette at three different
 * sizes. The shapes match `_draw_symbol` in
 * `apps/api/app/services/schaltplan_pdf.py` — a worker who learns the glyph
 * on the tablet reads the same glyph on the printed sheet.
 *
 * Deliberately schematic rather than EN 60617-exact: at 18 px a strict symbol
 * is a smudge, and the device name is always spelled out next to it.
 */
import type { DeviceSymbol as SymbolName } from "../../types/schaltplan";
import { catalogEntry } from "../../utils/schaltplanDevices";

type Props = {
  kind: string;
  size?: number;
  className?: string;
};

function Glyph({ symbol }: { symbol: SymbolName }) {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const };

  switch (symbol) {
    case "mcb":
    case "sls":
    case "fuse":
    case "rcbo":
      return (
        <>
          <path d="M12 3v5M12 21v-5" {...stroke} />
          <path d="M12 16l6-8" {...stroke} />
          {symbol === "fuse" && <rect x="8.5" y="9" width="7" height="6" rx="1" {...stroke} />}
          {symbol === "sls" && <path d="M5 11l4 4" {...stroke} />}
          {symbol === "rcbo" && <circle cx="6.5" cy="12" r="3" {...stroke} />}
        </>
      );
    case "rcd":
      return (
        <>
          <circle cx="12" cy="12" r="6" {...stroke} />
          <path d="M4 20L20 4" {...stroke} />
        </>
      );
    case "switch":
      return (
        <>
          <path d="M12 3v5M12 21v-5" {...stroke} />
          <path d="M11.5 16L18 9" {...stroke} />
        </>
      );
    case "spd":
      return (
        <>
          <path d="M12 3v4M12 21v-4" {...stroke} />
          <rect x="8" y="9" width="8" height="6" rx="1" {...stroke} />
          <path d="M9.5 6.5h5" {...stroke} />
        </>
      );
    case "meter":
      return (
        <>
          <circle cx="12" cy="12" r="7" {...stroke} />
          <text x="12" y="14.5" textAnchor="middle" fontSize="6.5" fill="currentColor" stroke="none">
            kWh
          </text>
        </>
      );
    case "contactor":
      return (
        <>
          <path d="M12 3v5M12 21v-5" {...stroke} />
          <rect x="7" y="9" width="10" height="6" rx="1" {...stroke} />
        </>
      );
    case "relay":
      return (
        <>
          <rect x="5.5" y="6.5" width="13" height="11" rx="1.5" {...stroke} />
          <path d="M5.5 6.5L18.5 17.5" {...stroke} />
        </>
      );
    case "transformer":
      return (
        <>
          <circle cx="9.5" cy="12" r="5" {...stroke} />
          <circle cx="14.5" cy="12" r="5" {...stroke} />
        </>
      );
    case "bus":
      return (
        <>
          <rect x="4" y="7" width="16" height="10" rx="1.5" {...stroke} />
          <path d="M4 12h16" {...stroke} />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
        </>
      );
    case "wallbox":
      return (
        <>
          <rect x="6.5" y="4" width="11" height="16" rx="2" {...stroke} />
          <path d="M10 11h4M12 11v5" {...stroke} />
        </>
      );
    case "pv":
      return (
        <>
          <rect x="4" y="7" width="16" height="10" rx="1" {...stroke} />
          <path d="M12 7v10M4 12h16" {...stroke} />
        </>
      );
    case "subfeed":
      return (
        <>
          <path d="M3 12h11M14 12l-3.5 3.5M14 12l-3.5-3.5" {...stroke} />
          <rect x="16" y="5.5" width="4.5" height="13" rx="1" {...stroke} />
        </>
      );
    case "terminal":
      return (
        <>
          <circle cx="8" cy="12" r="2.6" {...stroke} />
          <circle cx="16" cy="12" r="2.6" {...stroke} />
          <path d="M10.6 12h2.8" {...stroke} />
        </>
      );
    default:
      return <rect x="5" y="5" width="14" height="14" rx="2" {...stroke} strokeDasharray="3 2" />;
  }
}

export function DeviceSymbol({ kind, size = 22, className }: Props) {
  const entry = catalogEntry(kind);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={entry.label}
      focusable="false"
    >
      <Glyph symbol={entry.symbol} />
    </svg>
  );
}
