import type { Language, MaterialNeedStatus, Project } from "../../../types";
import type { SupplierFilter } from "../../../types/materialNeeds";
import { SUPPLIER_WITHOUT_CATALOG } from "../../../types/materialNeeds";
import type { WerkstattSupplier } from "../../../types/werkstatt";
import { materialNeedStatusLabel } from "../../../utils/materials";

/**
 * The sticky filter bar.
 *
 * Every control here answers a question the old page could not: "what is
 * still to be ordered for Halle 2", "what can I actually buy from Unielektro
 * today". Without them the screen was one flat list that grew until the only
 * usable action was Ctrl+F.
 *
 * Status chips are multi-select and additive; "Erledigte anzeigen" is a
 * separate toggle rather than a sixth chip, because showing finished rows
 * changes what the list IS, not which slice of it you see. The two combine
 * rather than override: a ticked box next to an active chip adds the finished
 * rows to that chip's, which is what both controls being visible promises.
 */
export interface BedarfToolbarProps {
  language: Language;
  query: string;
  onQueryChange: (value: string) => void;
  statuses: readonly MaterialNeedStatus[];
  onToggleStatus: (status: MaterialNeedStatus) => void;
  includeCompleted: boolean;
  onToggleIncludeCompleted: (value: boolean) => void;
  orderableOnly: boolean;
  onToggleOrderableOnly: (value: boolean) => void;
  projectId: number | null;
  onProjectChange: (value: number | null) => void;
  projects: readonly Project[];
  supplierId: SupplierFilter;
  onSupplierChange: (value: SupplierFilter) => void;
  suppliers: readonly WerkstattSupplier[];
  onResetFilters: () => void;
  hasActiveFilters: boolean;
}

const FILTER_CHIPS: readonly MaterialNeedStatus[] = [
  "order",
  "ordered",
  "on_the_way",
  "available",
];

export function BedarfToolbar({
  language,
  query,
  onQueryChange,
  statuses,
  onToggleStatus,
  includeCompleted,
  onToggleIncludeCompleted,
  orderableOnly,
  onToggleOrderableOnly,
  projectId,
  onProjectChange,
  projects,
  supplierId,
  onSupplierChange,
  suppliers,
  onResetFilters,
  hasActiveFilters,
}: BedarfToolbarProps) {
  const de = language === "de";

  return (
    <div className="bedarfe-toolbar">
      <input
        type="search"
        className="bedarfe-input bedarfe-toolbar-search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={
          de ? "Artikel, Artikelnr., Projekt suchen…" : "Search article, number, project…"
        }
        aria-label={de ? "Bedarfe durchsuchen" : "Search needs"}
      />

      <div className="bedarfe-chips" role="group" aria-label={de ? "Status" : "Status"}>
        {FILTER_CHIPS.map((status) => {
          const active = statuses.includes(status);
          return (
            <button
              key={`chip-${status}`}
              type="button"
              className={`bedarfe-chip${active ? " bedarfe-chip--on" : ""}`}
              aria-pressed={active}
              onClick={() => onToggleStatus(status)}
            >
              {materialNeedStatusLabel(status, language)}
            </button>
          );
        })}
      </div>

      <label className="bedarfe-select">
        <span className="bedarfe-select-label">{de ? "Projekt" : "Project"}</span>
        <select
          value={projectId == null ? "" : String(projectId)}
          onChange={(event) =>
            onProjectChange(event.target.value ? Number(event.target.value) : null)
          }
        >
          <option value="">{de ? "alle" : "all"}</option>
          {projects.map((project) => (
            <option key={`bedarfe-project-${project.id}`} value={project.id}>
              {project.project_number} · {project.name}
            </option>
          ))}
        </select>
      </label>

      <label className="bedarfe-select">
        <span className="bedarfe-select-label">{de ? "Lieferant" : "Supplier"}</span>
        <select
          value={supplierId == null ? "" : String(supplierId)}
          onChange={(event) => {
            const picked = event.target.value;
            if (!picked) onSupplierChange(null);
            else if (picked === SUPPLIER_WITHOUT_CATALOG) {
              onSupplierChange(SUPPLIER_WITHOUT_CATALOG);
            } else onSupplierChange(Number(picked));
          }}
        >
          <option value="">{de ? "alle" : "all"}</option>
          {/* The rows that BLOCK the hand-off, as their own list: without
              this the only way to work through them was to untick "Nur
              bestellbar" and hunt for the amber badge by eye. */}
          <option value={SUPPLIER_WITHOUT_CATALOG}>
            {de ? "ohne Katalog" : "without a catalogue article"}
          </option>
          {suppliers.map((supplier) => (
            <option key={`bedarfe-supplier-${supplier.id}`} value={supplier.id}>
              {supplier.name}
            </option>
          ))}
        </select>
      </label>

      <label className="bedarfe-toggle">
        <input
          type="checkbox"
          checked={orderableOnly}
          onChange={(event) => onToggleOrderableOnly(event.target.checked)}
        />
        <span>{de ? "Nur bestellbar" : "Orderable only"}</span>
      </label>

      <label className="bedarfe-toggle">
        <input
          type="checkbox"
          checked={includeCompleted}
          onChange={(event) => onToggleIncludeCompleted(event.target.checked)}
        />
        <span>{de ? "Erledigte anzeigen" : "Show completed"}</span>
      </label>

      {hasActiveFilters && (
        <button type="button" className="bedarfe-link-btn" onClick={onResetFilters}>
          {de ? "Filter zurücksetzen" : "Reset filters"}
        </button>
      )}
    </div>
  );
}
