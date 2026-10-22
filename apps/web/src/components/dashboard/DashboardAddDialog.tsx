import { useEffect, useId, useRef } from "react";

import type { Language } from "../../types";
import type { DashboardWidgetGroup, DashboardWidgetId } from "../../types/dashboard";
import { DASHBOARD_WIDGET_META } from "./widgetMeta";

/**
 * „Widget hinzufügen“ (docs/DASHBOARD.md §8.2): the widgets the user may add
 * and has not placed, grouped as in the catalog. Renders from metadata alone,
 * so opening it downloads no widget code and fires no request.
 *
 * The parent decides what is offered (`candidates`, in catalog order) and
 * what adding means; this is only the list. Escape, the backdrop and
 * „Schließen“ close it; focus starts in the dialog and the parent returns it.
 */
type Props = {
  candidates: readonly DashboardWidgetId[];
  language: Language;
  onAdd: (id: DashboardWidgetId) => void;
  onClose: () => void;
};

const GROUP_ORDER: readonly DashboardWidgetGroup[] = ["shortcuts", "personal", "planning", "werkstatt", "office"];

const GROUP_TITLE: Record<DashboardWidgetGroup, { de: string; en: string }> = {
  shortcuts: { de: "Schnellzugriff", en: "Shortcuts" },
  personal: { de: "Persönlich", en: "Personal" },
  planning: { de: "Planung & Projekte", en: "Planning & projects" },
  werkstatt: { de: "Werkstatt", en: "Workshop" },
  office: { de: "Büro", en: "Office" },
};

export function DashboardAddDialog({ candidates, language, onAdd, onClose }: Props): JSX.Element {
  const de = language === "de";
  const titleId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const groups = GROUP_ORDER.map((group) => ({
    group,
    ids: candidates.filter((id) => DASHBOARD_WIDGET_META[id]?.group === group),
  })).filter(({ ids }) => ids.length > 0);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialogRef}
        className="card modal-card modal-card-sm dashboard-add-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="dashboard-add-dialog__head">
          <h3 id={titleId}>{de ? "Widget hinzufügen" : "Add widget"}</h3>
          <button type="button" className="dashboard-button" onClick={onClose}>
            {de ? "Schließen" : "Close"}
          </button>
        </header>
        {groups.length === 0 ? (
          <p className="dashboard-add-dialog__empty">
            {de
              ? "Alle verfügbaren Widgets sind schon auf deiner Startseite."
              : "Every widget available to you is already on your start page."}
          </p>
        ) : (
          groups.map(({ group, ids }) => (
            <section key={group} className="dashboard-add-dialog__group">
              <h4>{de ? GROUP_TITLE[group].de : GROUP_TITLE[group].en}</h4>
              <ul className="dashboard-add-dialog__list">
                {ids.map((id) => {
                  const meta = DASHBOARD_WIDGET_META[id];
                  const title = de ? meta.title.de : meta.title.en;
                  return (
                    <li key={id} className="dashboard-add-dialog__row">
                      <div className="dashboard-add-dialog__text">
                        <strong>{title}</strong>
                        <span>{de ? meta.description.de : meta.description.en}</span>
                      </div>
                      <button
                        type="button"
                        className="dashboard-button"
                        aria-label={de ? `„${title}“ hinzufügen` : `Add “${title}”`}
                        onClick={() => onAdd(id)}
                      >
                        {de ? "Hinzufügen" : "Add"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </section>
    </div>
  );
}
