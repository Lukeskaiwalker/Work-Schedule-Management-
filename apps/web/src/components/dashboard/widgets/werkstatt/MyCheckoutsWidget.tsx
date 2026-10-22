import { useAppContext } from "../../../../context/AppContext";
import type { WerkstattTab } from "../../../../types";
import type { DashboardDevice } from "../../../../types/dashboard";
import { dueStatus, formatDueLabel, formatQuantity } from "../../../../utils/werkstattOverviewFormat";
import type { MyCheckout } from "../../../../utils/werkstattMobileApi";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { useMyCheckoutsResource } from "./werkstattResources";
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

/**
 * Where the full list lives. On a phone the Werkstatt tab „dashboard“ is the
 * mobile home with „Meine Entnahmen“ and its return buttons; on a tablet or a
 * desktop that tab is the stock dashboard, and the caller's items are on the
 * „Auf Baustelle“ list, by project and with their name on them.
 */
function listTabFor(device: DashboardDevice): WerkstattTab {
  return device === "mobile" ? "dashboard" : "on_site";
}

function checkoutRow(item: MyCheckout, now: Date, de: boolean, onOpen: (() => void) | null): WerkstattRow {
  const project = [item.project_number, item.project_name].filter(Boolean).join(" · ");
  const status = dueStatus(item.latest_expected_return_at, now);
  return {
    key: `${item.article_id}:${item.project_id ?? "none"}`,
    primary: item.article_name,
    details: [formatQuantity(item.quantity_out, item.unit), project || (de ? "ohne Projekt" : "no project")],
    // No date, no label: „Ohne Rückgabedatum“ on every row would be noise.
    meta: item.latest_expected_return_at ? formatDueLabel(item.latest_expected_return_at, now, de) : null,
    tone: status === "overdue" ? "danger" : status === "due_today" ? "warn" : null,
    onOpen,
  };
}

/**
 * „Meine Ausleihen“: what the signed-in user still has out, one row per
 * article and project (`/werkstatt/mobile/my-checkouts`, the phone home's
 * read). Overdue is the server's rule — the instant, not the calendar day —
 * through the same `dueStatus` the Werkstatt pages use.
 */
export default function MyCheckoutsWidget({ size, device }: DashboardWidgetProps) {
  const { language, now } = useAppContext();
  const de = language === "de";
  const resource = useMyCheckoutsResource();
  const openTab = useWerkstattTabOpener();

  const listTab = listTabFor(device);
  const openList = openTab ? () => openTab(listTab) : null;
  const items = resource.data ?? [];
  const shown = items.slice(0, rowLimit(size));

  return (
    <DashboardWidgetFrame
      title={widgetTitle("werkstatt_my_checkouts", de)}
      badge={items.length}
      action={openList ? { label: showAllLabel(de), onClick: openList } : null}
      state={frameState(resource)}
      isEmpty={shown.length === 0}
      emptyText={de ? "Du hast nichts ausgeliehen." : "You have nothing checked out."}
      more={moreLink(items.length - shown.length, openList)}
    >
      <WerkstattRowList rows={shown.map((item) => checkoutRow(item, now, de, openList))} />
    </DashboardWidgetFrame>
  );
}
