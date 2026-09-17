import { WerkstattMaintenanceRow } from "../WerkstattMaintenanceRow";
import { WerkstattBlockState, type WerkstattBlockPhase } from "./WerkstattBlockState";
import type { WerkstattInspectionDue } from "../../../types/werkstatt";

/**
 * "Prüfung & Reparatur" — the next BG-Prüfung deadlines.
 *
 * The card used to be titled "In Reparatur / Prüfung" over a list of neither.
 * What `/werkstatt/dashboard` actually sends under `maintenance_entries` is
 * inspection-required articles ordered by due date — not the articles sitting
 * in the repair shop, which the payload only ever gives as a COUNT. So the
 * title names what the list is, and the count keeps its place in the subtitle
 * where it cannot be mistaken for the rows beneath it.
 */
export interface DashboardMaintenanceCardProps {
  entries: WerkstattInspectionDue[] | null;
  inRepairCount: number | null;
  phase: WerkstattBlockPhase | null;
  language: "de" | "en";
}

function badgeFor(entry: WerkstattInspectionDue): "repair" | "inspection" | "overdue" {
  return entry.urgency === "overdue" ? "overdue" : "inspection";
}

function badgeLabel(entry: WerkstattInspectionDue, de: boolean): string {
  if (entry.days_until_due == null) {
    return de ? "Kein Termin" : "No date";
  }
  if (entry.days_until_due < 0) {
    const late = Math.abs(entry.days_until_due);
    return de ? `${late} T. überfällig` : `${late} d overdue`;
  }
  if (entry.days_until_due === 0) return de ? "Heute fällig" : "Due today";
  return de ? `in ${entry.days_until_due} T.` : `in ${entry.days_until_due} d`;
}

export function DashboardMaintenanceCard({
  entries,
  inRepairCount,
  phase,
  language,
}: DashboardMaintenanceCardProps) {
  const de = language === "de";
  const rows = entries ?? [];

  const subtitle =
    inRepairCount == null
      ? de
        ? "nicht geladen"
        : "not loaded"
      : de
        ? `Nächste BG-Prüfungen · ${inRepairCount} Artikel in Reparatur`
        : `Next BG inspections · ${inRepairCount} items in repair`;

  return (
    <section className="werkstatt-card">
      <header className="werkstatt-card-head">
        <div className="werkstatt-card-title-block">
          <h3 className="werkstatt-card-title">
            {de ? "Prüfung & Reparatur" : "Inspection & repair"}
          </h3>
          <span className="werkstatt-card-subtitle">{subtitle}</span>
        </div>
      </header>

      {phase ? (
        <WerkstattBlockState
          phase={phase}
          language={language}
          emptyLabel={
            de ? "Keine prüfpflichtigen Werkzeuge." : "No tools require inspection."
          }
        />
      ) : (
        <ul className="werkstatt-maintenance-list">
          {rows.map((entry) => (
            <WerkstattMaintenanceRow
              key={entry.article_id}
              toolName={entry.article_name}
              context={[entry.article_number, entry.category_name, entry.location_name]
                .filter((part): part is string => Boolean(part))
                .join(" · ")}
              badge={badgeFor(entry)}
              badgeLabel={badgeLabel(entry, de)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
