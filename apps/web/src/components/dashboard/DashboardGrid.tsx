import type { ReactNode } from "react";

import type { DashboardDevice, DashboardWidgetSize } from "../../types/dashboard";
import { columnSpan } from "../../utils/dashboardLayout";
import "../../styles/dashboard.css";

/**
 * The start-page grid (docs/DASHBOARD.md D10, §9.6).
 *
 * Columns come from `device` — mobile 1, tablet 2, desktop 3 — through
 * `data-device`, never from a viewport media query: the admin previews a
 * phone layout on a desktop, and edit mode keeps the device it started on
 * while the window changes. Items flow in order (`grid-auto-flow: row`, never
 * `dense`), so the grid shows exactly the order the user arranged.
 */
export function DashboardGrid({ device, children }: { device: DashboardDevice; children: ReactNode }): JSX.Element {
  return (
    <div className="dashboard-grid" data-device={device}>
      {children}
    </div>
  );
}

/** Class and span attribute of a grid cell; the editor's sortable tiles spread these on their own node. */
export function gridItemProps(size: DashboardWidgetSize, device: DashboardDevice): {
  className: string;
  "data-span": 1 | 2 | 3;
} {
  return { className: "dashboard-grid__item", "data-span": columnSpan(size, device) };
}

export function DashboardGridItem({
  size,
  device,
  children,
}: {
  size: DashboardWidgetSize;
  device: DashboardDevice;
  children: ReactNode;
}): JSX.Element {
  return <div {...gridItemProps(size, device)}>{children}</div>;
}
