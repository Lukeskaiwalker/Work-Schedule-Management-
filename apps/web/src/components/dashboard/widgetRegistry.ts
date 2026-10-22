/**
 * The one place that knows which code draws which widget (docs/DASHBOARD.md
 * D24, §9.7).
 *
 * Each group's `index.ts` exports loaders, never components, so importing
 * this file downloads no widget code: a phone with four widgets fetches four
 * chunks, on first render. The editor's placeholder tiles need none of this
 * (they render from widgetMeta.ts).
 *
 * The lazy component per id is cached: a new `React.lazy` on every render
 * would be a new component type, and React would remount the widget — and
 * re-subscribe its data — each time. A failed import is NOT cached, because
 * React.lazy remembers a rejection for good: one dropped request on a weak
 * building-site connection would otherwise break that widget until a reload.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

import type { DashboardWidgetId } from "../../types/dashboard";
import type {
  DashboardSettingsEditorLoader,
  DashboardSettingsEditorProps,
  DashboardWidgetLoader,
  DashboardWidgetLoaders,
  DashboardWidgetProps,
} from "./widgetTypes";
import { OFFICE_WIDGET_LOADERS } from "./widgets/office";
import { PERSONAL_WIDGET_LOADERS } from "./widgets/personal";
import { PLANNING_WIDGET_LOADERS } from "./widgets/planning";
import { SHORTCUT_WIDGET_LOADERS, SHORTCUTS_SETTINGS_EDITOR_LOADER } from "./widgets/shortcuts";
import { WERKSTATT_WIDGET_LOADERS } from "./widgets/werkstatt";

type LazyWidget = LazyExoticComponent<ComponentType<DashboardWidgetProps>>;
type LazySettingsEditor = LazyExoticComponent<ComponentType<DashboardSettingsEditorProps>>;

function loaderMap(groups: readonly DashboardWidgetLoaders[]): ReadonlyMap<string, DashboardWidgetLoader> {
  // A Map, not an object lookup: ids reach here from the server and from
  // localStorage, and `loaders["constructor"]` would find Object's.
  const map = new Map<string, DashboardWidgetLoader>();
  for (const group of groups) {
    for (const [id, loader] of Object.entries(group)) {
      if (typeof loader === "function") map.set(id, loader);
    }
  }
  return map;
}

const LOADERS = loaderMap([
  SHORTCUT_WIDGET_LOADERS,
  PERSONAL_WIDGET_LOADERS,
  PLANNING_WIDGET_LOADERS,
  WERKSTATT_WIDGET_LOADERS,
  OFFICE_WIDGET_LOADERS,
]);

const SETTINGS_EDITOR_LOADERS = new Map<string, DashboardSettingsEditorLoader>(
  SHORTCUTS_SETTINGS_EDITOR_LOADER ? [["shortcuts", SHORTCUTS_SETTINGS_EDITOR_LOADER]] : [],
);

const lazyWidgets = new Map<string, LazyWidget>();
const lazyEditors = new Map<string, LazySettingsEditor>();

/** A lazy component whose import forgets itself in `cache` when it fails, so the next ask retries. */
function cachedLazy<P>(
  cache: Map<string, LazyExoticComponent<ComponentType<P>>>,
  id: string,
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> {
  const cached = cache.get(id);
  if (cached) return cached;
  const component = lazy(() =>
    load().catch((error: unknown) => {
      if (cache.get(id) === component) cache.delete(id);
      throw error;
    }),
  );
  cache.set(id, component);
  return component;
}

/** Null when this build has no code for the id (an unknown id or version skew); the host skips it. */
export function getLazyWidget(id: DashboardWidgetId): LazyWidget | null {
  const loader = LOADERS.get(id);
  return loader ? cachedLazy(lazyWidgets, id, loader) : null;
}

/** Only „Schnellzugriff“ has settings („Kacheln wählen“); null for every other id. */
export function getLazySettingsEditor(id: DashboardWidgetId): LazySettingsEditor | null {
  const loader = SETTINGS_EDITOR_LOADERS.get(id);
  return loader ? cachedLazy(lazyEditors, id, loader) : null;
}
