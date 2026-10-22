import { useAppContext } from "../../../../context/AppContext";
import type { ReorderSuggestionLine } from "../../../../types/werkstatt";
import { formatQuantity } from "../../../../utils/werkstattOverviewFormat";
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

function reorderRow(line: ReorderSuggestionLine, de: boolean, onOpen: (() => void) | null): WerkstattRow {
  const empty = line.stock_available <= 0;
  return {
    key: line.article_id,
    primary: line.article_name,
    details: [line.article_number],
    // "2 / 10 m": what is on the shelf against the minimum, in the article's unit.
    meta: empty
      ? de
        ? `leer / ${formatQuantity(line.stock_min, line.unit)}`
        : `empty / ${formatQuantity(line.stock_min, line.unit)}`
      : `${line.stock_available} / ${formatQuantity(line.stock_min, line.unit)}`,
    tone: empty ? "danger" : "warn",
    onOpen,
  };
}

/**
 * „Nachbestellen“: the articles furthest below their minimum.
 *
 * Rows are the dashboard's own reorder preview (`preview_limit=10`), which
 * selects on stock the same way `kpis.below_min_count` counts — so „+n
 * weitere“ is that count minus the rows shown, and the badge, the rows and
 * the footer all describe one set. The preview does not skip articles without
 * a supplier link, which the Nachbestellen page does; that is why a row opens
 * the page rather than offering an order button of its own.
 */
export default function WerkstattReorderWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const de = language === "de";
  const resource = useWerkstattDashboardResource();
  const openTab = useWerkstattTabOpener();

  const openReorder = openTab ? () => openTab("nachbestellen") : null;
  const lines = resource.data?.reorder_preview ?? [];
  const shown = lines.slice(0, rowLimit(size));
  const total = resource.data?.kpis.below_min_count ?? null;

  return (
    <DashboardWidgetFrame
      title={widgetTitle("werkstatt_reorder", de)}
      badge={total}
      action={openReorder ? { label: showAllLabel(de), onClick: openReorder } : null}
      state={frameState(resource)}
      isEmpty={shown.length === 0}
      emptyText={de ? "Nichts nachzubestellen." : "Nothing to reorder."}
      more={moreLink(Math.max(0, (total ?? 0) - shown.length), openReorder)}
    >
      <WerkstattRowList rows={shown.map((line) => reorderRow(line, de, openReorder))} />
    </DashboardWidgetFrame>
  );
}
