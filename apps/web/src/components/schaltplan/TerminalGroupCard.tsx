/**
 * One FI group's terminal sequence — a card on the "Klemmen" tab.
 *
 * Two renderings of the same rows, like the legend: a five-column table on
 * a tablet, cards below 768 px. Every row is one WAGO part in mounting
 * order, what its marker says in each print mode (Stromkreis-Nr. | BMK —
 * "—" where that mode prints nothing, never one filled in from the other,
 * so the list promises no marker the default print leaves blank) and what
 * it is for — the FI with its type for the feed terminal, the outgoing
 * with its consumer for an Etagenklemme, "—" for an end element that
 * carries no marker. Same columns as the PDF sheet
 * (`services/schaltplan_pdf_terminals.py`) — keep the twins alike.
 */
import { END_PART_IDS, FEED_PART_IDS, type TerminalVariant } from "../../utils/schaltplanTerminalRules";
import {
  terminalGroupTitle,
  terminalText,
  type TerminalEntry,
  type TerminalGroup,
  type TerminalTextMode,
} from "../../utils/schaltplanTerminals";
import { findDevice } from "../../utils/schaltplanTopology";
import type { PanelDevice, PanelDocument } from "../../types/schaltplan";

export const VARIANT_LABELS: Record<TerminalVariant, string> = {
  standard: "Standard",
  single3p: "Einzel-Drehstromabgang",
  no_rcd: "ohne FI",
};

/** "30 mA / Typ A" for an FI head, "" for anything else. */
function rcdDetail(head: PanelDevice | null): string {
  if (!head || head.kind !== "rcd") return "";
  const parts = [head.residual_current.trim(), head.rcd_type.trim()].filter(Boolean);
  if (parts.length === 2) return `${parts[0]} / Typ ${parts[1]}`;
  return parts[0] ?? "";
}

/** What the marker says in that print mode — "—" where the mode prints nothing, no fallback. */
function modeText(terminal: TerminalEntry, mode: TerminalTextMode): string {
  return terminalText(terminal, mode) || "—";
}

/** The table's headings, in order — the PDF sheet's `column_titles()` twin. */
export const TERMINAL_COLUMN_TITLES: readonly string[] = ["Pos.", "Klemme", "Stromkreis-Nr.", "BMK", "für"];

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

type Props = {
  group: TerminalGroup;
  document: PanelDocument;
};

export function TerminalGroupCard({ group, document }: Props) {
  const title = terminalGroupTitle(group);
  const detail = rcdDetail(group.headDevice);
  return (
    <section className="sp-terminal-group" aria-label={title}>
      <header className="sp-terminal-group-head">
        <b>{title}</b>
        <span className={`sp-terminal-variant sp-terminal-variant--${group.variant}`}>{VARIANT_LABELS[group.variant]}</span>
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
          {group.terminals.map((terminal) => (
            <tr key={terminal.position}>
              <td className="sp-terminal-pos">{terminal.position}</td>
              <td className="sp-terminal-part">{terminal.partNo}</td>
              <td className="sp-terminal-text">{modeText(terminal, "circuit")}</td>
              <td className="sp-terminal-text">{modeText(terminal, "bmk")}</td>
              <td>{forText(terminal, group, document)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="sp-terminal-rows">
        {group.terminals.map((terminal) => (
          <li key={`card-${terminal.position}`} className="sp-terminal-row">
            <span className="sp-terminal-row-pos">{terminal.position}</span>
            <b>
              {"Nr. "}
              <span className="sp-terminal-text">{modeText(terminal, "circuit")}</span>
              {" · BMK "}
              <span className="sp-terminal-text">{modeText(terminal, "bmk")}</span>
              {` · ${terminal.partNo}`}
            </b>
            <small>{forText(terminal, group, document)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
