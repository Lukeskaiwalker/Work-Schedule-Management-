/**
 * The field bar above the cabinet drawing (docs/PANEL_ENCLOSURE.md §11):
 * the module entry point at every zoom. One button per module, "Feld {n} ·
 * {art}", and "+ Modul in Feld {n}" for each field with a free unit, all at
 * least 56 px high — the drawing's module backgrounds are a convenience,
 * this is the path a gloved finger can always hit. Scrolls sideways on a
 * five-field cabinet instead of wrapping, so the order stays left → right
 * like the fields themselves.
 */
import { useMemo } from "react";

import { enclosureModules, FAMILY_LABELS, freeRuns, moduleArticle, type CatalogIndex } from "../../../utils/enclosureCatalog";
import type { EnclosureModule } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";
import "../../../styles/schaltplan-enclosure.css";

export interface EnclosureFieldBarProps {
  document: PanelDocument;
  index: CatalogIndex;
  onOpenModule: (id: string) => void;
  /** 0-based field; the picker places at the top of its free run. */
  onAddModule: (field: number) => void;
  /** Modules still open (to look at); nothing can be added. */
  readOnly: boolean;
  /** The module whose sheet is open (`aria-current`). */
  selectedModuleId?: string | null;
}

interface FieldGroup {
  field: number;
  modules: EnclosureModule[];
  /** Free height in the field, mm; 0 when full or the cabinet does not resolve. */
  freeMm: number;
}

/** A hand-edited document can carry any field value; such a module still gets a button, in field 1. */
function safeField(module: EnclosureModule): number {
  return Number.isInteger(module.field) && module.field >= 0 ? module.field : 0;
}

function fieldGroups(document: PanelDocument, index: CatalogIndex): FieldGroup[] {
  const cabinet = document.enclosure ? index.enclosure(document.enclosure.code) : null;
  const modules = enclosureModules(document);
  const count = Math.max(cabinet?.fields ?? 0, ...modules.map((module) => safeField(module) + 1));
  return Array.from({ length: count }, (_, field) => ({
    field,
    modules: modules
      .filter((module) => safeField(module) === field)
      .sort((a, b) => a.unit - b.unit || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    freeMm: cabinet ? freeRuns(document, index, field).reduce((total, run) => total + run.units, 0) * cabinet.unit_mm : 0,
  }));
}

function moduleSubline(module: EnclosureModule, index: CatalogIndex): string {
  const label = typeof module.label === "string" ? module.label.trim() : "";
  if (label) return label;
  const spec = index.module(module.code);
  return spec ? FAMILY_LABELS[spec.family] ?? spec.name : "Code unbekannt";
}

export function EnclosureFieldBar({ document, index, onOpenModule, onAddModule, readOnly, selectedModuleId = null }: EnclosureFieldBarProps) {
  const groups = useMemo(() => fieldGroups(document, index), [document, index]);
  const visible = groups.filter((group) => group.modules.length > 0 || (!readOnly && group.freeMm > 0));
  if (!document.enclosure || visible.length === 0) return null;

  return (
    <nav className="sp-encl-fieldbar" aria-label="Module im Schrank">
      {visible.map((group) => (
        <div key={group.field} className="sp-encl-fieldbar-group" role="group" aria-label={`Feld ${group.field + 1}`}>
          {group.modules.map((module) => {
            const current = module.id === selectedModuleId;
            const unknown = !index.module(module.code);
            return (
              <button
                key={module.id}
                type="button"
                className={`sp-encl-fieldbar-btn${current ? " is-current" : ""}${unknown ? " sp-encl-fieldbar-btn--unknown" : ""}`}
                aria-current={current ? "true" : undefined}
                onClick={() => onOpenModule(module.id)}
              >
                <span className="sp-encl-fieldbar-title">{`Feld ${safeField(module) + 1} · ${moduleArticle(module, index)}`}</span>
                <span className="sp-encl-fieldbar-sub">{moduleSubline(module, index)}</span>
              </button>
            );
          })}
          {!readOnly && group.freeMm > 0 && (
            <button type="button" className="sp-encl-fieldbar-btn sp-encl-fieldbar-btn--add" onClick={() => onAddModule(group.field)}>
              <span className="sp-encl-fieldbar-title">{`+ Modul in Feld ${group.field + 1}`}</span>
              <span className="sp-encl-fieldbar-sub">{`${group.freeMm} mm frei`}</span>
            </button>
          )}
        </div>
      ))}
    </nav>
  );
}
