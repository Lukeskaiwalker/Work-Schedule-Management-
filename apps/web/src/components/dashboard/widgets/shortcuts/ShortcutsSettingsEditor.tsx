import { useMemo } from "react";

import { useAppContext } from "../../../../context/AppContext";
import {
  DASHBOARD_MAX_SHORTCUT_VIEWS,
  DASHBOARD_SHORTCUT_VIEWS,
  type DashboardShortcutView,
} from "../../../../types/dashboard";
import type { DashboardSettingsEditorProps } from "../../widgetTypes";
import { SHORTCUT_TILES, chosenShortcutViews, toggleShortcutView, type ShortcutTileMode } from "./shortcutTiles";
import "./shortcuts.css";

const MODE_HINT: Record<Exclude<ShortcutTileMode, "both">, { de: string; en: string }> = {
  construction: { de: "nur Baustelle", en: "construction mode only" },
  office: { de: "nur Büro", en: "office mode only" },
};

/**
 * „Kacheln wählen“: the tile checklist of „Schnellzugriff“ in the start-page
 * editor and the admin tab (docs/DASHBOARD.md §8.2).
 *
 * The checklist only: the editor's placeholder tile owns the „Kacheln wählen“
 * button that reveals it, so it does not fold itself a second time. A widget
 * without a choice starts from the preset it shows, so the first tick saves
 * exactly what the user saw plus that tick. Ticking appends (the order is the
 * user's); the last tile cannot be unticked and a thirteenth cannot be
 * ticked, matching what the server accepts (1–12 views).
 */
export default function ShortcutsSettingsEditor({ settings, onChange, device, language }: DashboardSettingsEditorProps) {
  const { workspaceMode } = useAppContext();
  const views = useMemo(
    () => chosenShortcutViews(settings, workspaceMode, device),
    [settings, workspaceMode, device],
  );

  const de = language === "de";
  const atLimit = views.length >= DASHBOARD_MAX_SHORTCUT_VIEWS;

  function toggle(view: DashboardShortcutView) {
    const next = toggleShortcutView(views, view);
    if (next.length === views.length && next.every((entry, index) => entry === views[index])) return;
    onChange({ views: next });
  }

  return (
    <fieldset className="dashboard-shortcuts-editor">
      <legend className="visually-hidden">{de ? "Kacheln wählen" : "Choose tiles"}</legend>
      <p className="dashboard-shortcuts-editor__status">
        <span className={`dashboard-shortcuts-editor__hint${atLimit ? " dashboard-shortcuts-editor__hint--limit" : ""}`}>
          {de ? "Höchstens 12 Kacheln." : "At most 12 tiles."}
        </span>
        <span className="dashboard-shortcuts-editor__count">
          {de ? `${views.length} von ${DASHBOARD_MAX_SHORTCUT_VIEWS}` : `${views.length} of ${DASHBOARD_MAX_SHORTCUT_VIEWS}`}
        </span>
      </p>
      <ul className="dashboard-shortcuts-editor__list">
        {DASHBOARD_SHORTCUT_VIEWS.map((view) => {
          const tile = SHORTCUT_TILES[view];
          const checked = views.includes(view);
          const locked = checked ? views.length <= 1 : atLimit;
          return (
            <li key={view}>
              <label className={`dashboard-shortcuts-editor__option${locked ? " is-locked" : ""}`}>
                <input type="checkbox" checked={checked} disabled={locked} onChange={() => toggle(view)} />
                <span className="dashboard-shortcuts-editor__name">{tile.label[language]}</span>
                {tile.mode !== "both" ? (
                  <span className="dashboard-shortcuts-editor__mode">{MODE_HINT[tile.mode][language]}</span>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
