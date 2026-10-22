/**
 * Loaders of the „Werkstatt“ widgets: werkstatt_kpis, werkstatt_reorder,
 * werkstatt_on_site, werkstatt_my_checkouts, werkstatt_boxes,
 * werkstatt_inspections, recent_panels (docs/DASHBOARD.md §1; part W4).
 *
 * Loaders only, never components or CSS: this file is imported by the
 * registry on every visit, the widgets are not (D24). Each widget imports
 * `./werkstatt.css` itself so the styles ride in its lazy chunk.
 */
import type { DashboardWidgetLoaders } from "../../widgetTypes";

export const WERKSTATT_WIDGET_LOADERS: DashboardWidgetLoaders = {
  werkstatt_kpis: () => import("./WerkstattKpisWidget"),
  werkstatt_reorder: () => import("./WerkstattReorderWidget"),
  werkstatt_on_site: () => import("./WerkstattOnSiteWidget"),
  werkstatt_my_checkouts: () => import("./MyCheckoutsWidget"),
  werkstatt_boxes: () => import("./BoxesWidget"),
  werkstatt_inspections: () => import("./InspectionsWidget"),
  recent_panels: () => import("./RecentPanelsWidget"),
};
