import { useAppContext } from "../../../../context/AppContext";
import type { DashboardResourceState } from "../../../../hooks/useDashboardResource";
import { boxStatusLabel } from "../../../../utils/boxes";
import { pluralize } from "../../../../utils/werkstattOverviewFormat";
import { DashboardWidgetFrame, type DashboardWidgetFrameState } from "../../DashboardWidgetFrame";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { useAssignedBoxesResource, usePackedBoxesResource, type DashboardBox } from "./werkstattResources";
import {
  WerkstattRowList,
  moreLink,
  rowLimit,
  showAllLabel,
  useWerkstattTabOpener,
  widgetTitle,
  type WerkstattRow,
} from "./werkstattWidgetParts";

type BoxesResource = DashboardResourceState<DashboardBox[]>;

/**
 * One frame state for the two reads. Half a list is worse than none: a
 * missing „Beim Kunden“ half reads as „nothing is out“. So the card shows
 * rows only when both answered, the error while either has none, and „Nicht
 * aktuell“ only when both are on screen and one of them failed to refresh.
 */
function combinedState(packed: BoxesResource, assigned: BoxesResource): DashboardWidgetFrameState {
  const error = (packed.data === null ? packed.error : null) ?? (assigned.data === null ? assigned.error : null);
  return {
    loading: packed.loading || assigned.loading,
    error,
    stale: error === null && (packed.stale || assigned.stale),
    forbidden: packed.forbidden || assigned.forbidden,
    onRetry: () => {
      if (packed.error) packed.reload();
      if (assigned.error) assigned.reload();
    },
  };
}

function boxRow(box: DashboardBox, de: boolean, onOpen: (() => void) | null): WerkstattRow {
  return {
    key: box.id,
    primary: `${box.box_number} — ${box.label}`,
    details: [
      box.customer_name,
      box.project_name,
      de ? pluralize(box.item_count, "Position", "Positionen") : pluralize(box.item_count, "line", "lines"),
    ],
    meta: boxStatusLabel(box.status, de),
    onOpen,
  };
}

/**
 * „Baustellenkisten“: crates packed and waiting to go out, then crates out
 * with a customer. Packed ones come first because they are the ones somebody
 * still has to carry to a site.
 */
export default function BoxesWidget({ size }: DashboardWidgetProps) {
  const { language } = useAppContext();
  const de = language === "de";
  const packed = usePackedBoxesResource();
  const assigned = useAssignedBoxesResource();
  const openTab = useWerkstattTabOpener();

  const openKisten = openTab ? () => openTab("kisten") : null;
  const boxes = packed.data !== null && assigned.data !== null ? [...packed.data, ...assigned.data] : [];
  const shown = boxes.slice(0, rowLimit(size));

  return (
    <DashboardWidgetFrame
      title={widgetTitle("werkstatt_boxes", de)}
      badge={boxes.length}
      action={openKisten ? { label: showAllLabel(de), onClick: openKisten } : null}
      state={combinedState(packed, assigned)}
      isEmpty={shown.length === 0}
      emptyText={de ? "Keine gepackten oder zugewiesenen Kisten." : "No packed or assigned boxes."}
      more={moreLink(boxes.length - shown.length, openKisten)}
    >
      <WerkstattRowList rows={shown.map((box) => boxRow(box, de, openKisten))} />
    </DashboardWidgetFrame>
  );
}
