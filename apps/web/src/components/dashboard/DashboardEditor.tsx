import { Suspense, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import type { Language } from "../../types";
import {
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_WIDGET_SIZES,
  type DashboardDevice,
  type DashboardWidgetId,
  type DashboardWidgetItem,
  type DashboardWidgetSettings,
  type DashboardWidgetSize,
} from "../../types/dashboard";
import { addWidget, columnSpan, moveWidget, moveWidgetBy, removeWidget, resizeWidget, setWidgetSettings } from "../../utils/dashboardLayout";
import { DashboardAddDialog } from "./DashboardAddDialog";
import { DashboardGrid } from "./DashboardGrid";
import { DashboardLoadBoundary } from "./DashboardLoadBoundary";
import { DASHBOARD_WIDGET_META } from "./widgetMeta";
import { getLazySettingsEditor } from "./widgetRegistry";

/**
 * The start-page editor, shared by the user's „Anpassen“ and the admin's
 * role defaults (docs/DASHBOARD.md D12, §8.2, §8.3, §11.2).
 *
 * Controlled: every control turns `widgets` into a new list through
 * `onChange`; saving belongs to the caller. Tiles are placeholders — title,
 * description, real span — so rearranging fetches nothing and cannot clock
 * anybody in by accident.
 *
 * Dragging (dnd-kit) starts from the handle only, so the page still scrolls
 * under a finger anywhere else on a tile. The move buttons are the other path
 * to the same order, for anyone who cannot or will not drag.
 *
 * `toolbar` (optional, beyond the §11.2 props) is placed after „Widget
 * hinzufügen“ in the editor's own sticky bar, so the user's „Abbrechen“ and
 * „Fertig“ sit with it — at the top on tablet and desktop, at the bottom on
 * phones, where the thumb is.
 */
export type DashboardEditorProps = {
  device: DashboardDevice;
  widgets: DashboardWidgetItem[];
  onChange: (next: DashboardWidgetItem[]) => void;
  availableIds: readonly DashboardWidgetId[];
  defaultSizes: Readonly<Record<DashboardWidgetId, DashboardWidgetSize>>;
  hiddenIds?: ReadonlySet<DashboardWidgetId>;
  language: Language;
  toolbar?: ReactNode;
};

const SIZE_LABEL: Record<DashboardWidgetSize, { de: string; en: string }> = {
  small: { de: "Klein", en: "Small" },
  medium: { de: "Mittel", en: "Medium" },
  large: { de: "Groß", en: "Large" },
};

function titleOf(id: DashboardWidgetId, de: boolean): string {
  const meta = DASHBOARD_WIDGET_META[id];
  if (!meta) return id;
  return de ? meta.title.de : meta.title.en;
}

function sizeHint(device: DashboardDevice, de: boolean): string | null {
  if (device === "mobile") {
    return de
      ? "Auf dem Handy sind alle Widgets gleich breit. Die Größe bestimmt, wie viel ein Widget zeigt."
      : "On a phone every widget is equally wide. The size decides how much a widget shows.";
  }
  if (device === "tablet") {
    return de
      ? "Auf dem Tablet sind Mittel und Groß gleich breit; Groß zeigt mehr."
      : "On a tablet, Medium and Large are equally wide; Large shows more.";
  }
  return null;
}

function positionText(title: string, position: number, total: number, de: boolean): string {
  return de ? `„${title}“ ist jetzt an Position ${position} von ${total}.` : `“${title}” is now at position ${position} of ${total}.`;
}

function useAnnouncements(ids: readonly DashboardWidgetId[], de: boolean): Announcements {
  return useMemo(() => {
    const title = (id: string | number) => titleOf(id as DashboardWidgetId, de);
    const position = (id: string | number) => ids.indexOf(id as DashboardWidgetId) + 1;
    const total = ids.length;
    return {
      onDragStart: ({ active }) =>
        de
          ? `„${title(active.id)}“ angehoben, Position ${position(active.id)} von ${total}.`
          : `Picked up “${title(active.id)}”, position ${position(active.id)} of ${total}.`,
      onDragOver: ({ active, over }) =>
        over
          ? de
            ? `„${title(active.id)}“ ist über Position ${position(over.id)} von ${total}.`
            : `“${title(active.id)}” is over position ${position(over.id)} of ${total}.`
          : undefined,
      onDragEnd: ({ active, over }) =>
        over ? positionText(title(active.id), position(over.id), total, de) : undefined,
      onDragCancel: ({ active }) =>
        de ? `Verschieben von „${title(active.id)}“ abgebrochen.` : `Moving “${title(active.id)}” was cancelled.`,
    };
  }, [ids, de]);
}

export function DashboardEditor({
  device,
  widgets,
  onChange,
  availableIds,
  defaultSizes,
  hiddenIds,
  language,
  toolbar,
}: DashboardEditorProps): JSX.Element {
  const de = language === "de";
  const [announcement, setAnnouncement] = useState("");
  const [adding, setAdding] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The tile a move button just moved, while the focus was in the editor.
  // React puts the focus back on a button whose tile it moved, but not on one
  // the move disabled: at either end the browser drops it to <body>. The
  // tile's other move button takes it then, so the next key press still
  // moves the same tile instead of starting over from the page header.
  const movedRef = useRef<{ id: DashboardWidgetId; delta: -1 | 1 } | null>(null);
  useLayoutEffect(() => {
    const moved = movedRef.current;
    movedRef.current = null;
    if (!moved || !rootRef.current) return;
    const tileNode = Array.from(rootRef.current.querySelectorAll<HTMLElement>("[data-widget-id]")).find(
      (node) => node.dataset.widgetId === moved.id,
    );
    const button = (direction: "back" | "forward") =>
      tileNode?.querySelector<HTMLButtonElement>(`button[data-move="${direction}"]`) ?? null;
    const pressed = button(moved.delta < 0 ? "back" : "forward");
    const target = pressed && !pressed.disabled ? pressed : button(moved.delta < 0 ? "forward" : "back");
    if (target && !target.disabled && document.activeElement !== target) target.focus();
  });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = useMemo(() => widgets.map((item) => item.id), [widgets]);
  const announcements = useAnnouncements(ids, de);

  const placed = new Set<string>(ids);
  const available = new Set<string>(availableIds);
  const candidates = DASHBOARD_WIDGET_IDS.filter((id) => available.has(id) && !placed.has(id));

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(active.id as DashboardWidgetId);
    const to = ids.indexOf(over.id as DashboardWidgetId);
    if (from >= 0 && to >= 0) onChange(moveWidget(widgets, from, to));
  };

  const move = (id: DashboardWidgetId, delta: -1 | 1) => {
    const next = moveWidgetBy(widgets, id, delta);
    const index = next.findIndex((item) => item.id === id);
    if (index === ids.indexOf(id)) return;
    if (rootRef.current?.contains(document.activeElement)) movedRef.current = { id, delta };
    onChange(next);
    setAnnouncement(positionText(titleOf(id, de), index + 1, next.length, de));
  };

  const remove = (id: DashboardWidgetId) => {
    onChange(removeWidget(widgets, id));
    setAnnouncement(de ? `„${titleOf(id, de)}“ entfernt.` : `“${titleOf(id, de)}” removed.`);
    // The removed tile held the focus; the add button is always there.
    addButtonRef.current?.focus();
  };

  const add = (id: DashboardWidgetId) => {
    onChange(addWidget(widgets, id, defaultSizes[id] ?? "medium"));
    setAnnouncement(de ? `„${titleOf(id, de)}“ hinzugefügt.` : `“${titleOf(id, de)}” added.`);
    setAdding(false);
    addButtonRef.current?.focus();
  };

  const closeDialog = () => {
    setAdding(false);
    addButtonRef.current?.focus();
  };

  const toolbarNode = (
    <div className="dashboard-editor__toolbar">
      <button ref={addButtonRef} type="button" className="dashboard-button" onClick={() => setAdding(true)}>
        {de ? "Widget hinzufügen" : "Add widget"}
      </button>
      {toolbar}
    </div>
  );

  const grid = (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: de
            ? "Drücke die Leertaste, um das Widget anzuheben. Mit den Pfeiltasten verschiebst du es, mit der Leertaste legst du es ab, mit Escape brichst du ab."
            : "Press space to pick the widget up. Move it with the arrow keys, drop it with space, cancel with Escape.",
        },
      }}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <DashboardGrid device={device}>
          {widgets.map((item, index) => (
            <EditorTile
              key={item.id}
              item={item}
              index={index}
              count={widgets.length}
              device={device}
              language={language}
              hidden={hiddenIds?.has(item.id) === true}
              onMove={move}
              onResize={(id, size) => onChange(resizeWidget(widgets, id, size))}
              onRemove={remove}
              onSettings={(id, settings) => onChange(setWidgetSettings(widgets, id, settings))}
            />
          ))}
        </DashboardGrid>
      </SortableContext>
    </DndContext>
  );

  return (
    <div ref={rootRef} className="dashboard-editor" data-device={device}>
      {device === "mobile" ? null : toolbarNode}
      {widgets.length === 0 ? (
        <p className="dashboard-editor__empty">
          {de ? "Noch keine Widgets. Über „Widget hinzufügen“ legst du welche an." : "No widgets yet. Use “Add widget” to place some."}
        </p>
      ) : (
        grid
      )}
      {/* On phones the bar follows the tiles, so its sticky bottom keeps it under the thumb. */}
      {device === "mobile" ? toolbarNode : null}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      {adding ? <DashboardAddDialog candidates={candidates} language={language} onAdd={add} onClose={closeDialog} /> : null}
    </div>
  );
}

type TileProps = {
  item: DashboardWidgetItem;
  index: number;
  count: number;
  device: DashboardDevice;
  language: Language;
  hidden: boolean;
  onMove: (id: DashboardWidgetId, delta: -1 | 1) => void;
  onResize: (id: DashboardWidgetId, size: DashboardWidgetSize) => void;
  onRemove: (id: DashboardWidgetId) => void;
  onSettings: (id: DashboardWidgetId, settings: DashboardWidgetSettings) => void;
};

function EditorTile({ item, index, count, device, language, hidden, onMove, onResize, onRemove, onSettings }: TileProps) {
  const de = language === "de";
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    attributes: { roleDescription: de ? "verschiebbares Widget" : "movable widget" },
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped by „Erneut versuchen“: remounts the boundary, and this render asks
  // the registry again, which has dropped a lazy editor whose download failed.
  const [settingsAttempt, setSettingsAttempt] = useState(0);
  const sizeLabelId = useId();
  const settingsId = useId();
  const title = titleOf(item.id, de);
  const meta = DASHBOARD_WIDGET_META[item.id];
  const description = meta ? (de ? meta.description.de : meta.description.en) : "";
  const SettingsEditor = getLazySettingsEditor(item.id);
  const vertical = device === "mobile";
  const hint = sizeHint(device, de);
  // Translate, not Transform: a scale would squash tiles of different spans.
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  const backLabel = vertical ? (de ? "Nach oben" : "Move up") : de ? "Nach vorne" : "Move forward";
  const forwardLabel = vertical ? (de ? "Nach unten" : "Move down") : de ? "Nach hinten" : "Move back";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`dashboard-grid__item dashboard-edit-tile${isDragging ? " dashboard-edit-tile--dragging" : ""}`}
      data-span={columnSpan(item.size, device)}
      data-widget-id={item.id}
      role="group"
      aria-label={title}
    >
      <div className="dashboard-edit-tile__head">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="dashboard-edit-tile__handle"
          {...attributes}
          {...listeners}
          aria-label={de ? `„${title}“ verschieben` : `Move “${title}”`}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <circle cx="5.5" cy="3.5" r="1.4" /><circle cx="10.5" cy="3.5" r="1.4" />
            <circle cx="5.5" cy="8" r="1.4" /><circle cx="10.5" cy="8" r="1.4" />
            <circle cx="5.5" cy="12.5" r="1.4" /><circle cx="10.5" cy="12.5" r="1.4" />
          </svg>
        </button>
        <div className="dashboard-edit-tile__text">
          <h3 className="dashboard-edit-tile__title">{title}</h3>
          {description ? <p className="dashboard-edit-tile__desc">{description}</p> : null}
        </div>
      </div>

      {hidden ? (
        <p className="dashboard-edit-tile__hidden">
          {de ? "Für diese Rolle unsichtbar (fehlende Berechtigung)" : "Invisible for this role (missing permission)"}
        </p>
      ) : null}

      <div className="dashboard-edit-tile__controls">
        <div className="dashboard-edit-tile__move">
          <button
            type="button"
            className="dashboard-button"
            data-move="back"
            disabled={index === 0}
            onClick={() => onMove(item.id, -1)}
            aria-label={de ? `„${title}“ ${backLabel.toLowerCase()} verschieben` : `${backLabel}: “${title}”`}
          >
            {backLabel}
          </button>
          <button
            type="button"
            className="dashboard-button"
            data-move="forward"
            disabled={index === count - 1}
            onClick={() => onMove(item.id, 1)}
            aria-label={de ? `„${title}“ ${forwardLabel.toLowerCase()} verschieben` : `${forwardLabel}: “${title}”`}
          >
            {forwardLabel}
          </button>
        </div>
        <button
          type="button"
          className="dashboard-button dashboard-button--danger dashboard-edit-tile__remove"
          onClick={() => onRemove(item.id)}
          aria-label={de ? `„${title}“ entfernen` : `Remove “${title}”`}
        >
          {de ? "Entfernen" : "Remove"}
        </button>
      </div>
      <div className="dashboard-edit-tile__sizes" role="radiogroup" aria-labelledby={sizeLabelId}>
        <span id={sizeLabelId} className="dashboard-edit-tile__label">
          {de ? "Größe" : "Size"}
        </span>
        {DASHBOARD_WIDGET_SIZES.map((size) => (
          <label key={size} className="dashboard-size-option">
            <input
              type="radio"
              name={`${sizeLabelId}-size`}
              value={size}
              checked={item.size === size}
              onChange={() => onResize(item.id, size)}
            />
            <span>{de ? SIZE_LABEL[size].de : SIZE_LABEL[size].en}</span>
          </label>
        ))}
      </div>
      {hint ? <p className="dashboard-edit-tile__hint">{hint}</p> : null}

      {SettingsEditor ? (
        <div className="dashboard-edit-tile__settings">
          <button
            type="button"
            className="dashboard-button"
            aria-expanded={settingsOpen}
            aria-controls={settingsId}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            {de ? "Kacheln wählen" : "Choose tiles"}
          </button>
          {settingsOpen ? (
            <div id={settingsId} className="dashboard-edit-tile__settings-body">
              <DashboardLoadBoundary
                key={settingsAttempt}
                name={`settings:${item.id}`}
                fallback={
                  <div className="dashboard-edit-tile__load-error" role="alert">
                    <p className="dashboard-edit-tile__hint">{de ? "Konnte nicht geladen werden." : "Could not be loaded."}</p>
                    <button type="button" className="dashboard-button" onClick={() => setSettingsAttempt((count) => count + 1)}>
                      {de ? "Erneut versuchen" : "Try again"}
                    </button>
                  </div>
                }
              >
                <Suspense fallback={<p className="dashboard-edit-tile__hint">{de ? "Wird geladen …" : "Loading …"}</p>}>
                  <SettingsEditor
                    settings={item.settings ?? null}
                    onChange={(next) => onSettings(item.id, next)}
                    device={device}
                    language={language}
                  />
                </Suspense>
              </DashboardLoadBoundary>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
