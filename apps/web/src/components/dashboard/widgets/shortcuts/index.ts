/**
 * Loaders of „Schnellzugriff“ and of its settings editor („Kacheln wählen“)
 * (docs/DASHBOARD.md §1, §8.2; part W5).
 *
 * Loaders only, never components or CSS: this file is imported by the
 * registry on every visit, the widget and the editor are not (D24). Each
 * imports `./shortcuts.css` itself so the styles ride in its lazy chunk.
 */
import type { DashboardSettingsEditorLoader, DashboardWidgetLoaders } from "../../widgetTypes";

export const SHORTCUT_WIDGET_LOADERS: DashboardWidgetLoaders = {
  shortcuts: () => import("./ShortcutsWidget"),
};

/** „Kacheln wählen“, mounted inside the editor's placeholder tile. */
export const SHORTCUTS_SETTINGS_EDITOR_LOADER: DashboardSettingsEditorLoader | null = () =>
  import("./ShortcutsSettingsEditor");
