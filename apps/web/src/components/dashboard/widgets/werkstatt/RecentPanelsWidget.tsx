import { useAppContext } from "../../../../context/AppContext";
import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import type { PanelPlanSummary } from "../../../../types/schaltplan";
import { formatRelativeTime } from "../../../../utils/werkstattOverviewFormat";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { useRecentPanelsResource } from "./werkstattResources";
import {
  WerkstattRowList,
  frameState,
  moreLink,
  rowLimit,
  showAllLabel,
  widgetTitle,
  type WerkstattRow,
} from "./werkstattWidgetParts";

function panelRow(
  panel: PanelPlanSummary,
  now: Date,
  de: boolean,
  inOffice: boolean,
  onOpen: ((panel: PanelPlanSummary) => void) | null,
): WerkstattRow {
  const primary = `${panel.panel_number} · ${panel.designation} ${panel.name}`.trim();
  return {
    key: panel.id,
    primary,
    details: [panel.customer_name, panel.project_number],
    meta: formatRelativeTime(panel.updated_at, now, de),
    onOpen: onOpen ? () => onOpen(panel) : null,
    // In Büro mode the row does not open the plan the title suggests but the
    // panel's picking list, so its name says so.
    ariaLabel: inOffice
      ? de
        ? `${primary} – In der Kommissionierung öffnen`
        : `${primary} – Open in picking`
      : undefined,
  };
}

/**
 * „Zuletzt bearbeitete Verteiler“: the panels the user may see, newest change
 * first (`/schaltplan/panels/recent`, the editor's own „Zuletzt bearbeitet“).
 *
 * The editor is a Baustelle tool, hidden in Büro mode, so a row goes where the
 * mode allows (docs/DASHBOARD.md §9.5): in Baustelle mode the editor opens with
 * that panel (utils/schaltplanHandoff.ts), in Büro mode the Werkstatt
 * Kommissionierung, where the office works a panel.
 */
export default function RecentPanelsWidget({ size }: DashboardWidgetProps) {
  const { language, now, workspaceMode } = useAppContext();
  const de = language === "de";
  const resource = useRecentPanelsResource();
  const { open, resolveView } = useDashboardNavigation();

  const inOffice = workspaceMode === "office";
  const reachable = resolveView(inOffice ? "werkstatt" : "schaltplan") !== null;
  const openPanel = reachable ? (panel: PanelPlanSummary) => open({ kind: "panel", panel }) : null;
  const openList = reachable
    ? () => open(inOffice ? { kind: "werkstatt", tab: "verteiler" } : { kind: "view", view: "schaltplan" })
    : null;
  const panels = resource.data ?? [];
  const shown = panels.slice(0, rowLimit(size));

  return (
    <DashboardWidgetFrame
      title={widgetTitle("recent_panels", de)}
      action={openList ? { label: showAllLabel(de), onClick: openList } : null}
      state={frameState(resource)}
      isEmpty={shown.length === 0}
      emptyText={de ? "Noch keine Verteilerpläne." : "No panel plans yet."}
      more={moreLink(panels.length - shown.length, openList)}
    >
      <WerkstattRowList rows={shown.map((panel) => panelRow(panel, now, de, inOffice, openPanel))} />
    </DashboardWidgetFrame>
  );
}
