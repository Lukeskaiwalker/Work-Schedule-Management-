import { useMemo, useState } from "react";
import { WerkstattMovementRow } from "../WerkstattMovementRow";
import { WerkstattBlockState, type WerkstattBlockPhase } from "./WerkstattBlockState";
import {
  formatRelativeTime,
  movementPipKind,
  movementTypeLabel,
} from "../../../utils/werkstattOverviewFormat";
import type { WerkstattMovement } from "../../../types/werkstatt";

/**
 * "Letzte Bewegungen" — the last five ledger rows, filterable.
 *
 * The chips partition all eight movement types between them, so switching to
 * one of them never hides a row that "Alle" showed without naming where it
 * went. They filter the five rows already fetched — the endpoint sends a fixed
 * five and takes no filter argument — which is why the subtitle counts what is
 * on screen rather than claiming a figure for the day.
 *
 * `intake` has its own chip rather than sitting under "Rückgaben": a delivery
 * from a supplier is stock ARRIVING, not a tool coming back from a site, and
 * somebody checking what came back today should not be handed the morning's
 * Datanorm delivery under that label.
 */
type MovementFilterKey = "all" | "out" | "in" | "intake" | "adjust";

interface MovementFilter {
  key: MovementFilterKey;
  label_de: string;
  label_en: string;
  types: ReadonlyArray<string>;
}

const FILTERS: ReadonlyArray<MovementFilter> = [
  { key: "all", label_de: "Alle", label_en: "All", types: [] },
  {
    key: "out",
    label_de: "Entnahmen",
    label_en: "Out",
    types: ["checkout", "repair_out"],
  },
  {
    key: "in",
    label_de: "Rückgaben",
    label_en: "Returns",
    types: ["return", "repair_back"],
  },
  {
    key: "intake",
    label_de: "Wareneingang",
    label_en: "Goods in",
    types: ["intake"],
  },
  {
    key: "adjust",
    label_de: "Korrekturen",
    label_en: "Adjustments",
    types: ["correction", "inventory_plus", "inventory_minus"],
  },
];

export interface DashboardMovementsCardProps {
  movements: WerkstattMovement[] | null;
  phase: WerkstattBlockPhase | null;
  language: "de" | "en";
  now: Date;
}

export function DashboardMovementsCard({
  movements,
  phase,
  language,
  now,
}: DashboardMovementsCardProps) {
  const de = language === "de";
  const [activeFilter, setActiveFilter] = useState<MovementFilterKey>("all");
  const rows = useMemo(() => {
    const all = movements ?? [];
    const filter = FILTERS.find((entry) => entry.key === activeFilter);
    if (!filter || filter.types.length === 0) return all;
    return all.filter((row) => filter.types.includes(row.movement_type));
  }, [movements, activeFilter]);

  const subtitle = (() => {
    if (movements == null) return de ? "nicht geladen" : "not loaded";
    if (movements.length === 0) return de ? "keine Bewegungen" : "no movements";
    return de
      ? `Die letzten ${movements.length} Buchungen`
      : `The last ${movements.length} entries`;
  })();

  return (
    <section className="werkstatt-card">
      <header className="werkstatt-card-head">
        <div className="werkstatt-card-title-block">
          <h3 className="werkstatt-card-title">
            {de ? "Letzte Bewegungen" : "Recent movements"}
          </h3>
          <span className="werkstatt-card-subtitle">{subtitle}</span>
        </div>
        <div
          className="werkstatt-segmented wsov-segmented-wrap"
          role="tablist"
          aria-label={de ? "Bewegungstyp" : "Movement type"}
        >
          {FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              role="tab"
              aria-selected={activeFilter === filter.key}
              className={`werkstatt-segmented-btn${activeFilter === filter.key ? " werkstatt-segmented-btn--active" : ""}`}
              onClick={() => setActiveFilter(filter.key)}
            >
              {de ? filter.label_de : filter.label_en}
            </button>
          ))}
        </div>
      </header>

      {phase || rows.length === 0 ? (
        <WerkstattBlockState
          phase={phase ?? "empty"}
          language={language}
          emptyLabel={
            activeFilter === "all"
              ? de
                ? "Noch keine Buchungen."
                : "No entries yet."
              : de
                ? "Keine Buchungen dieser Art unter den letzten."
                : "None of this kind among the most recent."
          }
        />
      ) : (
        <ul className="werkstatt-movement-list">
          {rows.map((movement) => (
            <WerkstattMovementRow
              key={movement.id}
              kind={movementPipKind(movement.movement_type)}
              title={`${movement.quantity}× ${movement.article_name}`}
              subtitle={[
                movementTypeLabel(movement.movement_type, de),
                movement.user_display_name,
                movement.project_number,
              ]
                .filter((part): part is string => Boolean(part))
                .join(" · ")}
              timestamp={formatRelativeTime(movement.created_at, now, de)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
