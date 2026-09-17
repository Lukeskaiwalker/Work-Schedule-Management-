import { useMemo } from "react";
import { useAppContext } from "../../context/AppContext";
import { DashboardKpiStrip } from "../../components/werkstatt/dashboard/DashboardKpiStrip";
import { DashboardMaintenanceCard } from "../../components/werkstatt/dashboard/DashboardMaintenanceCard";
import { DashboardMovementsCard } from "../../components/werkstatt/dashboard/DashboardMovementsCard";
import { DashboardOnSiteCard } from "../../components/werkstatt/dashboard/DashboardOnSiteCard";
import { DashboardReorderCard } from "../../components/werkstatt/dashboard/DashboardReorderCard";
import { WerkstattLoadError } from "../../components/werkstatt/dashboard/WerkstattLoadError";
import { blockPhaseFor } from "../../components/werkstatt/dashboard/WerkstattBlockState";
import { useWerkstattOverview } from "../../hooks/useWerkstattOverview";
import {
  fetchWerkstattDashboard,
  listOnSiteGroups,
} from "../../utils/werkstattDashboardApi";
import { listReorderSuggestions } from "../../utils/werkstattReorderApi";
import {
  onSitePreviewFrom,
  reorderPreviewFrom,
} from "../../utils/werkstattDashboardPreview";
import "../../styles/werkstatt-overview.css";

/**
 * WerkstattDashboardPage — the landing screen of the Werkstatt area.
 *
 * Every number here used to be a literal in the JSX: 412 articles, 14 below
 * minimum, 27 out on site, 3 unavailable, over four lists of fixtures that had
 * since been emptied. A workshop reads this screen to decide whether to order
 * cable and whether a tool is missing, so invented figures are worse than no
 * screen at all.
 *
 * Three requests, not one. `/werkstatt/dashboard` carries the KPIs, the recent
 * movements and the inspection list, and its own preview blocks for the other
 * two cards — but those previews are built by different queries than the pages
 * their buttons open, so they contradicted the destination. Both cards now read
 * the destination's own endpoint and slice it here
 * (`utils/werkstattDashboardPreview.ts`), which makes each card a genuine
 * sample of the screen behind it and lets the footers say exactly what is left
 * out.
 *
 * Each block owns its load state. A card whose request failed says so on the
 * card; nothing on this page ever renders a zero, or an "everything is fine",
 * that it did not receive.
 *
 * Self-gates on `mainView === "werkstatt" && werkstattTab === "dashboard"`.
 */
export function WerkstattDashboardPage() {
  const { mainView, language, werkstattTab, setWerkstattTab, token, now } = useAppContext();

  const de = language === "de";
  const active = mainView === "werkstatt" && werkstattTab === "dashboard";

  const overview = useWerkstattOverview(
    active,
    token,
    fetchWerkstattDashboard,
    de ? "Werkstatt-Übersicht nicht geladen." : "Workshop overview not loaded.",
  );
  const onSite = useWerkstattOverview(
    active,
    token,
    listOnSiteGroups,
    de ? "Ausgegebene Artikel nicht geladen." : "Checked-out items not loaded.",
  );
  const reorder = useWerkstattOverview(
    active,
    token,
    listReorderSuggestions,
    de ? "Bestellvorschläge nicht geladen." : "Reorder suggestions not loaded.",
  );

  const onSitePreview = useMemo(
    () => (onSite.data ? onSitePreviewFrom(onSite.data) : null),
    [onSite.data],
  );
  const reorderPreview = useMemo(
    () => (reorder.data ? reorderPreviewFrom(reorder.data) : null),
    [reorder.data],
  );

  if (!active) return null;

  const kpis = overview.data?.kpis ?? null;

  const failures = [overview.error, onSite.error, reorder.error].filter(
    (message): message is string => Boolean(message),
  );
  const allFailed = failures.length === 3;
  const retryFailed = () => {
    if (overview.error) overview.reload();
    if (onSite.error) onSite.reload();
    if (reorder.error) reorder.reload();
  };

  return (
    <section className="werkstatt-tab-page">
      {failures.length > 0 && (
        <WerkstattLoadError
          headline={
            allFailed
              ? de
                ? "Die Zahlen konnten nicht geladen werden — hier steht nichts Aktuelles."
                : "These figures could not be loaded — nothing here is current."
              : de
                ? "Ein Teil der Zahlen konnte nicht geladen werden — die betroffenen Karten sagen es."
                : "Some figures could not be loaded — the affected cards say so."
          }
          detail={failures.join(" · ")}
          retryLabel={de ? "Erneut versuchen" : "Try again"}
          onRetry={retryFailed}
        />
      )}

      <DashboardKpiStrip kpis={kpis} language={de ? "de" : "en"} />

      <div className="werkstatt-content-grid">
        <div className="werkstatt-column werkstatt-column--left">
          <DashboardReorderCard
            lines={reorderPreview?.lines ?? null}
            orderableCount={reorderPreview?.total ?? null}
            belowMinCount={kpis?.below_min_count ?? null}
            phase={blockPhaseFor(reorder, reorderPreview?.lines.length)}
            language={de ? "de" : "en"}
            onOpenReorder={() => setWerkstattTab("nachbestellen")}
          />

          <DashboardMovementsCard
            movements={overview.data?.recent_movements ?? null}
            phase={blockPhaseFor(overview, overview.data?.recent_movements?.length)}
            language={de ? "de" : "en"}
            now={now}
          />
        </div>

        <div className="werkstatt-column werkstatt-column--right">
          <DashboardOnSiteCard
            groups={onSitePreview?.groups ?? null}
            hiddenGroups={onSitePreview?.hiddenGroups ?? 0}
            hiddenItems={onSitePreview?.hiddenItems ?? 0}
            onSiteCount={kpis?.on_site_count ?? null}
            phase={blockPhaseFor(onSite, onSitePreview?.groups.length)}
            language={de ? "de" : "en"}
            now={now}
            onOpenAll={() => setWerkstattTab("on_site")}
          />

          <DashboardMaintenanceCard
            entries={overview.data?.maintenance_entries ?? null}
            inRepairCount={kpis?.in_repair_count ?? null}
            phase={blockPhaseFor(overview, overview.data?.maintenance_entries?.length)}
            language={de ? "de" : "en"}
          />
        </div>
      </div>
    </section>
  );
}
