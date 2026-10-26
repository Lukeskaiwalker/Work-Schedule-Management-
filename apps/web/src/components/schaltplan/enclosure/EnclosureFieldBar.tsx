/**
 * The field bar above the cabinet drawing (docs/PANEL_ENCLOSURE.md §11):
 * the module entry point at every zoom. One button per module, "Feld {n} ·
 * {art}", and "+ Modul in Feld {n}" for each field with a free unit, all at
 * least 56 px high — the drawing's module backgrounds are a convenience,
 * this is the path a gloved finger can always hit. Scrolls sideways on a
 * five-field cabinet instead of wrapping, so the order stays left → right
 * like the fields themselves.
 *
 * Fields with terminal rails also get "Klemmen Feld {n}" (R2 §7.2), with
 * " · {k} ohne Platz" while strips fit neither rail: the close-up, also on
 * a board the viewer may only read.
 *
 * The first meter field from the left (the §14a block's carrier) gets
 * "§14a-Klemmen" with its state — "{n} Klemmen", "fehlt", "entfernt",
 * "passt nicht" (docs/PANEL_ENCLOSURE_R4.md §8.2) — read-only boards too.
 */
import { useMemo } from "react";

import { enclosureModules, FAMILY_LABELS, freeRuns, moduleArticle, type CatalogIndex } from "../../../utils/enclosureCatalog";
import type { EnclosureModule } from "../../../types/panelEnclosure";
import type { PanelDocument } from "../../../types/schaltplan";
import "../../../styles/schaltplan-enclosure.css";
import "../../../styles/schaltplan-enclosure-terminals.css";
import "../../../styles/schaltplan-enclosure-control.css";

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
  /** Fields with terminal rails (0-based) and how many strips there have no place. */
  terminals?: readonly { field: number; unplaced: number }[];
  /** "Klemmen Feld {n}": the field's close-up. */
  onOpenTerminals?: (field: number) => void;
  /** "§14a-Klemmen" on the carrier's field (0-based) with its state line; null without a meter field. */
  control?: { field: number; sub: string } | null;
  /** "§14a-Klemmen": the §14a sheet. */
  onOpenControl?: () => void;
}

function terminalsLabel(field: number, unplaced: number): string {
  return unplaced > 0 ? `Klemmen Feld ${field + 1} · ${unplaced} ohne Platz` : `Klemmen Feld ${field + 1}`;
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

export function EnclosureFieldBar(props: EnclosureFieldBarProps) {
  const { document, index, onOpenModule, onAddModule, readOnly, selectedModuleId = null, terminals = [], onOpenTerminals, control = null, onOpenControl } = props;
  const groups = useMemo(() => fieldGroups(document, index), [document, index]);
  const terminalFields = new Map(terminals.map((entry) => [entry.field, entry.unplaced] as const));
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
          {onOpenTerminals && terminalFields.has(group.field) ? (
            <button
              type="button"
              className="sp-encl-fieldbar-btn sp-encl-fieldbar-btn--terminals"
              onClick={() => onOpenTerminals(group.field)}
              aria-label={terminalsLabel(group.field, terminalFields.get(group.field) ?? 0)}
            >
              <span className="sp-encl-fieldbar-title">{`Klemmen Feld ${group.field + 1}`}</span>
              {(terminalFields.get(group.field) ?? 0) > 0 ? (
                <span className="sp-encl-fieldbar-sub">{`${terminalFields.get(group.field)} ohne Platz`}</span>
              ) : null}
            </button>
          ) : null}
          {control && onOpenControl && control.field === group.field ? (
            <button
              type="button"
              className="sp-encl-fieldbar-btn sp-encl-fieldbar-btn--control"
              onClick={onOpenControl}
              aria-label={`§14a-Klemmen · ${control.sub}`}
            >
              <span className="sp-encl-fieldbar-title">§14a-Klemmen</span>
              <span className="sp-encl-fieldbar-sub">{control.sub}</span>
            </button>
          ) : null}
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
