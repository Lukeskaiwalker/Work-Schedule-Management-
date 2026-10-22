import { useAppContext } from "../../../../context/AppContext";
import type { WerkstattCheckoutGroupPreview } from "../../../../types/werkstatt";
import { pluralize } from "../../../../utils/werkstattOverviewFormat";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { useWerkstattDashboardResource } from "./werkstattResources";
import {
  WerkstattRowList,
  frameState,
  moreLink,
  rowLimit,
  showAllLabel,
  useWerkstattTabOpener,
  widgetTitle,
  type WerkstattRow,
} from "./werkstattWidgetParts";

function siteRow(group: WerkstattCheckoutGroupPreview, de: boolean, onOpen: (() => void) | null): WerkstattRow {
  // The server sends at most five items per site, so this can only say THAT
  // something is late there, not how much.
  const late = group.items.some((item) => item.is_overdue);
  return {
    key: group.project_id,
    primary: [group.project_number, group.project_title].filter(Boolean).join(" · "),
    details: [de ? pluralize(group.item_count, "Artikel", "Artikel") : pluralize(group.item_count, "item", "items")],
    meta: late ? (de ? "Überfällig" : "Overdue") : null,
    tone: late ? "danger" : null,
    onOpen,
  };
}

/**
 * „Auf Baustelle“: what is still out, one row per project.
 *
 * The groups come from the dashboard's on-site preview, which replays the
 * ledger (returns subtracted) and leaves out stock booked without a project.
 * `kpis.on_site_project_count` counts exactly those projects, so it is the
 * badge and the base of „+n weitere“. Rows open the „Auf Baustelle“ list, not
 * the project: that read is open to every signed-in user, a project is not.
 */
export default function WerkstattOnSiteWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const de = language === "de";
  const resource = useWerkstattDashboardResource();
  const openTab = useWerkstattTabOpener();

  const openOnSite = openTab ? () => openTab("on_site") : null;
  const groups = resource.data?.on_site_groups ?? [];
  const shown = groups.slice(0, rowLimit(size));
  const total = resource.data?.kpis.on_site_project_count ?? null;

  return (
    <DashboardWidgetFrame
      title={widgetTitle("werkstatt_on_site", de)}
      badge={total}
      action={openOnSite ? { label: showAllLabel(de), onClick: openOnSite } : null}
      state={frameState(resource)}
      isEmpty={shown.length === 0}
      emptyText={de ? "Nichts auf Baustelle." : "Nothing out on site."}
      more={moreLink(Math.max(0, (total ?? 0) - shown.length), openOnSite)}
    >
      <WerkstattRowList rows={shown.map((group) => siteRow(group, de, openOnSite))} />
    </DashboardWidgetFrame>
  );
}
