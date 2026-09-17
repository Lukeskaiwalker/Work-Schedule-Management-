import { useEffect, useRef } from "react";
import type { Language, MaterialNeedStatus } from "../../../types";
import type { MaterialNeedPatch, MaterialNeedRow } from "../../../types/materialNeeds";
import {
  materialNeedStatusClass,
  materialNeedStatusLabel,
  normalizeMaterialNeedStatus,
} from "../../../utils/materials";
import { BedarfRow } from "./BedarfRow";

/**
 * One building site's needs, foldable.
 *
 * The header is the part that earns its keep: a tri-state checkbox for the
 * whole site, the counts per status, and the suppliers involved — so a buyer
 * can decide whether to open the group at all. Collapsed state is remembered
 * per project by the page.
 */
export interface BedarfProjectGroupProps {
  projectId: number;
  projectNumber: string;
  projectTitle: string;
  rows: readonly MaterialNeedRow[];
  language: Language;
  collapsed: boolean;
  onToggleCollapsed: (projectId: number) => void;
  onOpenProject: (projectId: number) => void;
  selected: ReadonlySet<number>;
  busyIds: ReadonlySet<number>;
  onToggleSelect: (id: number, groupIds: readonly number[], extend: boolean) => void;
  onSetGroupSelected: (groupIds: readonly number[], checked: boolean) => void;
  onPatch: (id: number, patch: MaterialNeedPatch) => void;
  onDelete: (row: MaterialNeedRow) => void;
  onLinkCatalog: (row: MaterialNeedRow) => void;
  onOpenOrder: (row: MaterialNeedRow) => void;
}

export function BedarfProjectGroup({
  projectId,
  projectNumber,
  projectTitle,
  rows,
  language,
  collapsed,
  onToggleCollapsed,
  onOpenProject,
  selected,
  busyIds,
  onToggleSelect,
  onSetGroupSelected,
  onPatch,
  onDelete,
  onLinkCatalog,
  onOpenOrder,
}: BedarfProjectGroupProps) {
  const de = language === "de";
  const groupIds = rows.map((row) => row.id);
  const selectedCount = groupIds.filter((id) => selected.has(id)).length;
  const allSelected = selectedCount > 0 && selectedCount === groupIds.length;
  const checkboxRef = useRef<HTMLInputElement | null>(null);

  // "Some of this site is selected" has no HTML attribute — only a DOM
  // property — so it has to be written after render.
  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = selectedCount > 0 && !allSelected;
    }
  }, [selectedCount, allSelected]);

  const statusCounts = new Map<MaterialNeedStatus, number>();
  for (const row of rows) {
    const status = normalizeMaterialNeedStatus(row.status);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const suppliers = Array.from(
    new Set(rows.map((row) => row.supplier_name).filter((name): name is string => Boolean(name))),
  );

  return (
    <section className="bedarfe-group">
      <header className="bedarfe-group-head">
        <input
          ref={checkboxRef}
          type="checkbox"
          className="bedarfe-row-check"
          checked={allSelected}
          aria-label={de ? `Alle Bedarfe von ${projectNumber}` : `All needs of ${projectNumber}`}
          onChange={(event) => onSetGroupSelected(groupIds, event.target.checked)}
        />
        <button
          type="button"
          className="bedarfe-group-toggle"
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapsed(projectId)}
        >
          <span aria-hidden="true">{collapsed ? "▸" : "▾"}</span>
        </button>
        <button
          type="button"
          className="bedarfe-group-title"
          onClick={() => onOpenProject(projectId)}
          title={de ? "Projekt öffnen" : "Open project"}
        >
          <span className="bedarfe-group-number">{projectNumber}</span>
          <span className="bedarfe-group-name">{projectTitle}</span>
        </button>
        <span className="bedarfe-group-pills">
          {Array.from(statusCounts.entries()).map(([status, count]) => (
            <span
              key={`group-${projectId}-${status}`}
              className={`bedarfe-pill bedarfe-pill--${materialNeedStatusClass(status)}`}
            >
              {materialNeedStatusLabel(status, language)} {count}
            </span>
          ))}
        </span>
        {suppliers.length > 0 && (
          <span className="bedarfe-group-suppliers muted">{suppliers.join(" · ")}</span>
        )}
        <span className="bedarfe-group-count muted">
          {rows.length}{" "}
          {de
            ? rows.length === 1
              ? "Eintrag"
              : "Einträge"
            : rows.length === 1
              ? "item"
              : "items"}
        </span>
      </header>

      {!collapsed && (
        <ul className="bedarfe-rows">
          {rows.map((row) => (
            <BedarfRow
              key={`bedarf-${row.id}`}
              row={row}
              language={language}
              selected={selected.has(row.id)}
              busy={busyIds.has(row.id)}
              onToggleSelect={(id, extend) => onToggleSelect(id, groupIds, extend)}
              onPatch={onPatch}
              onDelete={onDelete}
              onLinkCatalog={onLinkCatalog}
              onOpenOrder={onOpenOrder}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
