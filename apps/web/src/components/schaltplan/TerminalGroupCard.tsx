/**
 * One terminal strip — a Leiste or a Block — as a card on the "Klemmen" tab.
 *
 * Two renderings of the same rows, like the legend: a four-column table on
 * a tablet, cards below 768 px. Every row is one WAGO part in mounting
 * order, what its marker says (the X numbering with the document's
 * overrides applied — "—" where the marker says nothing, never a fallback
 * the print would not produce) and what it is for — the FI with its type
 * for the feed terminal, the outgoing with its consumer for an
 * Etagenklemme or a Block cell, "—" for the end clamp that carries no
 * marker. Same columns as the PDF sheet
 * (`services/schaltplan_pdf_terminals.py`) — keep the twins alike.
 */
import { END_PART_IDS, FEED_PART_IDS, type TerminalVariant } from "../../utils/schaltplanTerminalRules";
import {
  STRIP_KIND_BLOCK,
  type TerminalEntry,
  type TerminalGroup,
  type TerminalStrip,
} from "../../utils/schaltplanTerminals";
import { findDevice } from "../../utils/schaltplanTopology";
import { formatMm } from "../../utils/schaltplanStrip";
import type { PanelDevice, PanelDocument } from "../../types/schaltplan";

export const VARIANT_LABELS: Record<TerminalVariant, string> = {
  standard: "Standard",
  no_rcd: "ohne FI",
};

/** "30 mA / Typ A" for an FI head, "" for anything else. */
function rcdDetail(head: PanelDevice | null): string {
  if (!head || head.kind !== "rcd") return "";
  const parts = [head.residual_current.trim(), head.rcd_type.trim()].filter(Boolean);
  if (parts.length === 2) return `${parts[0]} / Typ ${parts[1]}`;
  return parts[0] ?? "";
}

/** What the marker says — "—" where it says nothing, no fallback. */
function markerText(terminal: TerminalEntry): string {
  return terminal.label || "—";
}

/** The table's headings, in order — the PDF sheet's `column_titles()` twin. */
export const TERMINAL_COLUMN_TITLES: readonly string[] = ["Pos.", "Klemme", "Beschriftung", "für"];

function forText(terminal: TerminalEntry, group: TerminalGroup, document: PanelDocument): string {
  if (END_PART_IDS.has(terminal.partId)) return "—";
  if (FEED_PART_IDS.has(terminal.partId)) {
    const head = group.headDevice;
    return [head ? `FI ${head.designation.trim() || "?"}` : "", rcdDetail(head)].filter(Boolean).join(" · ") || "—";
  }
  const device = findDevice(document, terminal.deviceId);
  if (!device) return "—";
  const circuit = device.circuit.trim();
  return [device.designation.trim(), device.label.trim(), circuit ? `Nr. ${circuit}` : ""].filter(Boolean).join(" · ") || "—";
}

/** The width a Block takes on the rail: its five 12 mm terminals. */
function blockWidthMm(strip: TerminalStrip): number {
  return strip.terminals.reduce((total, terminal) => total + terminal.widthMm, 0);
}

type Props = {
  group: TerminalGroup;
  strip: TerminalStrip;
  document: PanelDocument;
};

export function TerminalStripCard({ group, strip, document }: Props) {
  const block = strip.kind === STRIP_KIND_BLOCK;
  const detail = block ? `Etikett: ${strip.name || "—"} · ${strip.xLabel || "—"}` : rcdDetail(group.headDevice);
  return (
    <section className="sp-terminal-group" aria-label={strip.title}>
      <header className="sp-terminal-group-head">
        <b>{strip.title}</b>
        {block ? (
          <span className="sp-terminal-variant sp-terminal-variant--block">{`Block · ${formatMm(blockWidthMm(strip))} mm`}</span>
        ) : (
          <span className={`sp-terminal-variant sp-terminal-variant--${group.variant}`}>{VARIANT_LABELS[group.variant]}</span>
        )}
        {detail ? <small>{detail}</small> : null}
      </header>

      <table className="sp-terminal-table">
        <thead>
          <tr>
            {TERMINAL_COLUMN_TITLES.map((title) => (
              <th key={title} scope="col">
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {strip.terminals.map((terminal) => (
            <tr key={terminal.position}>
              <td className="sp-terminal-pos">{terminal.position}</td>
              <td className="sp-terminal-part">{terminal.partNo}</td>
              <td className="sp-terminal-text">{markerText(terminal)}</td>
              <td>{forText(terminal, group, document)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="sp-terminal-rows">
        {strip.terminals.map((terminal) => (
          <li key={`card-${terminal.position}`} className="sp-terminal-row">
            <span className="sp-terminal-row-pos">{terminal.position}</span>
            <b>
              <span className="sp-terminal-text">{markerText(terminal)}</span>
              {` · ${terminal.partNo}`}
            </b>
            <small>{forText(terminal, group, document)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
