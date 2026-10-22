/**
 * What a start-page widget module looks like to the host.
 *
 * Widgets are lazy per id (docs/DASHBOARD.md D24): each group's `index.ts`
 * exports a map of loaders, never components, so a phone with four widgets
 * downloads four. `widgetRegistry.ts` joins the five maps.
 */
import type { ComponentType } from "react";

import type { Language } from "../../types";
import type {
  DashboardDevice,
  DashboardWidgetId,
  DashboardWidgetSettings,
  DashboardWidgetSize,
} from "../../types/dashboard";

/**
 * `device` is the device the layout belongs to, which is not always the
 * viewport: the admin previews a phone layout on a desktop, and edit mode
 * freezes the device it started on. Widget internals size themselves with
 * container queries, never with width-based media queries.
 */
export type DashboardWidgetProps = {
  size: DashboardWidgetSize;
  settings: DashboardWidgetSettings | null;
  device: DashboardDevice;
};

export type DashboardWidgetModule = { default: ComponentType<DashboardWidgetProps> };
export type DashboardWidgetLoader = () => Promise<DashboardWidgetModule>;
export type DashboardWidgetLoaders = Partial<Record<DashboardWidgetId, DashboardWidgetLoader>>;

/** The per-widget settings editor; only `shortcuts` has one („Kacheln wählen“). */
export type DashboardSettingsEditorProps = {
  settings: DashboardWidgetSettings | null;
  onChange: (next: DashboardWidgetSettings) => void;
  device: DashboardDevice;
  language: Language;
};

export type DashboardSettingsEditorLoader = () => Promise<{ default: ComponentType<DashboardSettingsEditorProps> }>;
