import { WerkstattKpiChip } from "../WerkstattKpiChip";
import { pluralize } from "../../../utils/werkstattOverviewFormat";
import type { WerkstattDashboardKpis } from "../../../types/werkstatt";

/**
 * The four headline numbers.
 *
 * `kpis` is null until a response lands — while loading, and for good after a
 * failed load. Every tile then reads "–" rather than 0, which is the whole
 * point: this strip used to print 412 / 14 / 27 / 3 as literals, and a zero
 * shown in their place would have been the same class of lie, just quieter.
 */
export interface DashboardKpiStripProps {
  kpis: WerkstattDashboardKpis | null;
  language: "de" | "en";
}

const UNKNOWN = "–";

function count(value: number | undefined, known: boolean): string {
  return known && value != null ? String(value) : UNKNOWN;
}

export function DashboardKpiStrip({ kpis, language }: DashboardKpiStripProps) {
  const de = language === "de";
  const known = kpis != null;
  const unknownSubtitle = de ? "nicht geladen" : "not loaded";

  return (
    <div className="werkstatt-kpi-strip">
      <WerkstattKpiChip
        label={de ? "ARTIKEL IM BESTAND" : "ITEMS IN STOCK"}
        value={count(kpis?.total_articles, known)}
        subtitle={
          known
            ? de
              ? `über ${pluralize(kpis?.total_categories ?? 0, "Kategorie", "Kategorien")}`
              : `across ${pluralize(kpis?.total_categories ?? 0, "category", "categories")}`
            : unknownSubtitle
        }
        tone="neutral"
      />
      <WerkstattKpiChip
        label={de ? "MINDESTBESTAND UNTERSCHRITTEN" : "BELOW MINIMUM STOCK"}
        value={count(kpis?.below_min_count, known)}
        subtitle={
          known
            ? de
              ? "Artikel nachbestellen"
              : "items to reorder"
            : unknownSubtitle
        }
        tone="warning"
      />
      {/* No project count beside this one. `kpis.on_site_project_count` counts
          every project that has EVER had a checkout — it never shrinks when
          things come back — so "bei 9 Projekten" would be a number that only
          grows. The honest figure is on the "Auf Baustelle" page, which counts
          sites that still have something out. See the handoff note. */}
      <WerkstattKpiChip
        label={de ? "AUSGEGEBEN AUF BAUSTELLE" : "CHECKED OUT ON SITE"}
        value={count(kpis?.on_site_count, known)}
        subtitle={
          known
            ? de
              ? "Artikel außer Haus"
              : "items out of the workshop"
            : unknownSubtitle
        }
        tone="info"
      />
      {/* No "davon N in Reparatur" here. `unavailable_count` counts articles
          with `stock_available <= 0` and `in_repair_count` counts those with
          `stock_repair > 0` — two independent predicates, so the repair figure
          is not a subset and could be printed larger than the tile above it.
          The repair count has a home without a subset claim: the subtitle of
          the "Prüfung & Reparatur" card. */}
      <WerkstattKpiChip
        label={de ? "NICHT VERFÜGBAR" : "UNAVAILABLE"}
        value={count(kpis?.unavailable_count, known)}
        subtitle={
          known
            ? de
              ? "kein Bestand verfügbar"
              : "no stock available"
            : unknownSubtitle
        }
        tone="danger"
      />
    </div>
  );
}
