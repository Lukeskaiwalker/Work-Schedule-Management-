/**
 * The "Klemmen" tab: which WAGO Reihenklemmen the board needs, per FI group.
 *
 * Derived, never entered — every terminal follows from a device's
 * `terminal_block` flag and its poles, so the list cannot drift from the
 * rail. The tab carries the two bulk switches (a 40-breaker board is a
 * two-tap job), the print button (opens the label sheet in Reihenklemmen
 * mode), the PDF link, and the Stückliste summed over the board.
 *
 * The rules and every number here come from `utils/schaltplanTerminals.ts`,
 * whose Python twin prints the strip and the PDF; a part whose width could
 * not be confirmed is said out loud above the list, because a wrong pitch
 * shifts every following marker on the strip.
 */
import { useMemo } from "react";

import { TerminalGroupCard } from "./TerminalGroupCard";
import { formatMm } from "../../utils/schaltplanStrip";
import { isTerminalEligible, terminalFindings } from "../../utils/schaltplanTerminalRules";
import {
  deriveTerminals,
  terminalBom,
  terminalCounts,
  unverifiedTerminalParts,
  type TerminalBomRow,
  type TerminalCounts,
} from "../../utils/schaltplanTerminals";
import { allDevices, buildTopology } from "../../utils/schaltplanTopology";
import type { PanelDocument } from "../../types/schaltplan";

type Props = {
  document: PanelDocument;
  readOnly: boolean;
  /** Flag (true) or clear (false) `terminal_block` on every eligible outgoing. Absent = no bulk switches. */
  onSetAllTerminals?: (flag: boolean) => void;
  /** Open the label sheet in Reihenklemmen mode. */
  onPrint: () => void;
  pdfHref: string;
  printing?: boolean;
};

function summaryText(counts: TerminalCounts, eligible: number): string {
  if (counts.terminals === 0) return "Keine Reihenklemmen abgeleitet.";
  const groups = counts.groups === 1 ? "1 FI-Gruppe" : `${counts.groups} FI-Gruppen`;
  return `${counts.terminals} Klemmen in ${groups} · ${counts.devices} von ${eligible} Abgängen`;
}

function TerminalBom({ bom, counts }: { bom: TerminalBomRow[]; counts: TerminalCounts }) {
  return (
    <section className="sp-terminal-bom" aria-label="Stückliste Reihenklemmen">
      <div className="sp-terminal-bom-head">Stückliste Reihenklemmen</div>
      <table className="sp-terminal-table">
        <thead>
          <tr>
            <th scope="col">Artikel</th>
            <th scope="col">Bezeichnung</th>
            <th scope="col" className="sp-terminal-count">
              Anzahl
            </th>
            <th scope="col">Breite</th>
          </tr>
        </thead>
        <tbody>
          {bom.map((row) => (
            <tr key={row.partId}>
              <td className="sp-terminal-part">{row.partNo}</td>
              <td>{row.name}</td>
              <td className="sp-terminal-count">{row.count}</td>
              <td>
                {row.verified ? (
                  `${formatMm(row.widthMm)} mm`
                ) : (
                  <span className="sp-terminal-unverified">nicht bestätigt</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sp-terminal-bom-foot">{`${counts.terminals} Klemmen · ${bom.length} Artikel`}</div>
    </section>
  );
}

export function TerminalList({ document, readOnly, onSetAllTerminals, onPrint, pdfHref, printing = false }: Props) {
  const groups = useMemo(() => deriveTerminals(document), [document]);
  const bom = useMemo(() => terminalBom(groups), [groups]);
  // The same info findings `validateDocument` reports. Shown here because
  // the page's Prüfen block lists warnings only, and "no FI in this group"
  // is exactly what someone reading the terminal list needs to see.
  const hints = useMemo(() => terminalFindings(buildTopology(document)), [document]);
  const counts = terminalCounts(groups);
  const unverified = unverifiedTerminalParts(groups);
  const eligible = allDevices(document).filter(isTerminalEligible);
  const flagged = eligible.filter((device) => device.terminal_block === true);
  const hasTerminals = groups.length > 0;

  return (
    <div className="sp-terminal-list">
      <header className="sp-terminal-head">
        <div>
          <h4>Reihenklemmen</h4>
          <p className="sp-terminal-summary">{summaryText(counts, eligible.length)}</p>
        </div>
        <div className="sp-terminal-actions">
          {!readOnly && onSetAllTerminals && (
            <>
              <button
                type="button"
                className="sp-btn"
                disabled={eligible.length === 0 || flagged.length === eligible.length}
                onClick={() => onSetAllTerminals(true)}
                title="Setzt „Reihenklemme am Abgang“ auf jedem LS, Wallbox-, UV- und PV-Abgang"
              >
                Alle Abgänge mit Reihenklemme
              </button>
              <button
                type="button"
                className="sp-btn"
                disabled={flagged.length === 0}
                onClick={() => onSetAllTerminals(false)}
              >
                Alle ohne
              </button>
            </>
          )}
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            disabled={!hasTerminals || printing}
            onClick={onPrint}
            title="Ein 2009-110-Streifen je FI-Gruppe — Gruppen und Text in der Vorschau wählen"
          >
            {printing ? "Drucke…" : "Klemmen-Etiketten drucken"}
          </button>
          {hasTerminals && (
            <a className="sp-btn" href={pdfHref} target="_blank" rel="noreferrer">
              Klemmenliste als PDF
            </a>
          )}
        </div>
      </header>

      {unverified.length > 0 && (
        <p className="sp-terminal-warn" role="status">
          {`Breite nicht bestätigt: ${unverified.map((part) => part.partNo).join(", ")} — vor dem ersten Druck am Träger messen.`}
        </p>
      )}

      {hints.length > 0 && (
        <ul className="sp-terminal-hints" aria-label="Hinweise">
          {hints.map((finding, index) => (
            <li key={`${finding.scope}-${index}`}>{finding.message}</li>
          ))}
        </ul>
      )}

      {!hasTerminals ? (
        <p className="sp-terminal-empty">
          Noch keine Reihenklemmen. Markiere einen Abgang im Gerätedialog mit „Reihenklemme am Abgang“ — oder
          alle auf einmal.
        </p>
      ) : (
        <>
          {groups.map((group) => (
            <TerminalGroupCard key={group.groupId} group={group} document={document} />
          ))}
          <TerminalBom bom={bom} counts={counts} />
        </>
      )}
    </div>
  );
}
