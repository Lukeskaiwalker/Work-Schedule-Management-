import { useAppContext } from "../../../../context/AppContext";
import type { WerkstattInspectionDue } from "../../../../types/werkstatt";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { useDueInspectionsResource } from "./werkstattResources";
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

/** Due within a week reads amber, like the return deadlines on the Werkstatt pages. */
const SOON_DAYS = 7;

/** The wording of the Werkstatt dashboard's „Prüfung & Reparatur“ card, so both say the same. */
function dueLabel(days: number | null, de: boolean): string {
  if (days === null) return de ? "Kein Termin" : "No date";
  if (days < 0) return de ? `${Math.abs(days)} T. überfällig` : `${Math.abs(days)} d overdue`;
  if (days === 0) return de ? "Heute fällig" : "Due today";
  return de ? `in ${days} T.` : `in ${days} d`;
}

function inspectionRow(entry: WerkstattInspectionDue, de: boolean, onOpen: (() => void) | null): WerkstattRow {
  const days = entry.days_until_due;
  // No date yet means the first inspection is still owed: as urgent as late.
  const late = days === null || days < 0;
  return {
    key: entry.article_id,
    primary: entry.article_name,
    details: [entry.article_number, entry.location_name],
    meta: dueLabel(days, de),
    tone: late ? "danger" : days <= SOON_DAYS ? "warn" : null,
    onOpen,
  };
}

/**
 * „Fällige Prüfungen“: BG-Prüfungen overdue, never done, or due within 30
 * days, in the server's order (no date first, then by due date).
 *
 * These are inspections of stock ARTICLES. The one Werkstatt screen that lists
 * them is the dashboard tab („Prüfung & Reparatur“), so rows open that tab;
 * „Maschinen“ tracks the inspections of individual machines, a different list.
 */
export default function InspectionsWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const de = language === "de";
  const resource = useDueInspectionsResource();
  const openTab = useWerkstattTabOpener();

  const openList = openTab ? () => openTab("dashboard") : null;
  const entries = resource.data ?? [];
  const shown = entries.slice(0, rowLimit(size));

  return (
    <DashboardWidgetFrame
      title={widgetTitle("werkstatt_inspections", de)}
      badge={entries.length}
      action={openList ? { label: showAllLabel(de), onClick: openList } : null}
      state={frameState(resource)}
      isEmpty={shown.length === 0}
      emptyText={de ? "Keine Prüfungen in den nächsten 30 Tagen." : "No inspections in the next 30 days."}
      more={moreLink(entries.length - shown.length, openList)}
    >
      <WerkstattRowList rows={shown.map((entry) => inspectionRow(entry, de, openList))} />
    </DashboardWidgetFrame>
  );
}
