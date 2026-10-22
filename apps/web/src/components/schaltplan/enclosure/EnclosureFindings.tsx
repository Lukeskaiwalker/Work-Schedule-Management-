/**
 * The cabinet's findings under the drawing (docs/PANEL_ENCLOSURE.md §5,
 * §11, D6): warnings first, then notes — never a block, a board captured
 * half-built must save. The disclaimer says what this is (a checking aid
 * against VDE-AR-N 4100, not the grid operator's TAB), and the closing line
 * lists what no rule here can see, so a clean list is not read as "passed".
 */
import { useId } from "react";

import type { PanelFinding } from "../../../types/schaltplan";

export const FINDINGS_DISCLAIMER = "Prüfhilfe nach VDE-AR-N 4100:2026-04 — ersetzt nicht die TAB des Netzbetreibers.";
export const NOT_CHECKED =
  "Nicht automatisch geprüft: Spannungsabgriff für SMGW/APZ vor dem SLS · RJ45 im RfZ · Einführung des Hauptkabels nicht von oben · Montagehöhe und Arbeitsraum · TAB des Netzbetreibers.";

const LEVEL_TEXT: Readonly<Record<string, string>> = { warn: "Prüfen", info: "Hinweis" };

export function EnclosureFindings({ findings }: { findings: readonly PanelFinding[] }) {
  const headingId = useId();
  // Stable: warnings keep their rule order among themselves, notes theirs.
  const sorted = [...findings.filter((finding) => finding.level === "warn"), ...findings.filter((finding) => finding.level !== "warn")];
  return (
    <section className="sp-encl-findings" aria-labelledby={headingId}>
      <h4 id={headingId}>Hinweise zum Schrank</h4>
      <p className="sp-encl-findings-disclaimer">{FINDINGS_DISCLAIMER}</p>
      {sorted.length === 0 ? (
        <p className="sp-encl-findings-none">Keine Hinweise zum Schrank.</p>
      ) : (
        <ul className="sp-encl-findings-list">
          {sorted.map((finding, position) => (
            <li key={`${finding.rule ?? ""}-${finding.scope}-${position}`} className={`sp-encl-finding sp-encl-finding--${finding.level}`}>
              <span className="sp-encl-finding-level">{LEVEL_TEXT[finding.level] ?? "Hinweis"}</span>
              <span className="sp-encl-finding-text">{finding.message}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="sp-encl-findings-unchecked">{NOT_CHECKED}</p>
    </section>
  );
}
