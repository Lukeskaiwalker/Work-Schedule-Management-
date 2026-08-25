/**
 * Choose whose board this is: customer first, then optionally the project,
 * then the board itself.
 *
 * Customer-first, project-optional, deliberately. A Verteiler belongs to the
 * *building*, which belongs to the customer, and it outlives any single job —
 * so a service call with no project must still be able to file one. When a
 * project is picked it scopes the list, so a fitter on site sees the two
 * boards of that job rather than the customer's fourteen.
 *
 * The board list is cards, not a `<select>`: on site the decisive information
 * is "how many circuits, is it a main or a sub, when was it last touched",
 * and a native picker shows none of that.
 */
import { CustomerCombobox } from "../customers/CustomerCombobox";
import { PANEL_TYPE_LABELS } from "../../utils/schaltplanDevices";
import type { CustomerListItem, Project } from "../../types";
import type { PanelPlanSummary } from "../../types/schaltplan";

type Props = {
  language: "de" | "en";
  customers: CustomerListItem[];
  projects: Project[];
  customerId: number | null;
  projectId: number | null;
  onCustomerChange: (customerId: number | null) => void;
  onProjectChange: (projectId: number | null) => void;
  onRequestCreateCustomer: (prefillName: string) => void;
  panels: PanelPlanSummary[];
  activePanelId: number | null;
  onSelectPanel: (panelId: number) => void;
  onNewPanel: () => void;
  canEdit: boolean;
  loading: boolean;
};

function relativeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function PanelScopePicker({
  language,
  customers,
  projects,
  customerId,
  projectId,
  onCustomerChange,
  onProjectChange,
  onRequestCreateCustomer,
  panels,
  activePanelId,
  onSelectPanel,
  onNewPanel,
  canEdit,
  loading,
}: Props) {
  // Legacy projects carry only the free-text customer_name; match those by
  // name so a customer's older jobs stay reachable until every project is
  // linked. Same rule the Baustellenbericht form uses.
  const picked = customers.find((customer) => customer.id === customerId) ?? null;
  const pickedName = (picked?.name ?? "").trim().toLowerCase();
  const scopedProjects = projects.filter(
    (project) =>
      project.customer_id === customerId ||
      (project.customer_id == null &&
        pickedName.length > 0 &&
        (project.customer_name ?? "").trim().toLowerCase() === pickedName),
  );

  return (
    <div className="sp-scope">
      <div className="sp-scope-fields">
        <div className="sp-field">
          <span className="sp-field-label">Kunde *</span>
          <CustomerCombobox
            language={language}
            customers={customers}
            value={{ customerId, customerName: picked?.name ?? "" }}
            onChange={(next) => onCustomerChange(next.customerId)}
            onRequestCreate={onRequestCreateCustomer}
            placeholder="Kunde suchen…"
          />
        </div>

        <label className="sp-field">
          <span className="sp-field-label">Projekt (optional)</span>
          <select
            value={projectId ?? ""}
            disabled={customerId == null}
            onChange={(event) => onProjectChange(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">Ohne Projekt (Gebäudedokumentation)</option>
            {scopedProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.project_number} · {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {customerId == null ? (
        <p className="sp-scope-hint">
          Wähle zuerst einen Kunden. Verteilerpläne gehören zum Gebäude des Kunden — ein Projekt
          kannst du zusätzlich angeben, musst du aber nicht.
        </p>
      ) : (
        <div className="sp-panel-list">
          <div className="sp-panel-list-head">
            <h3>
              Verteiler
              <span className="sp-count">{panels.length}</span>
            </h3>
            {canEdit && (
              <button type="button" className="sp-btn sp-btn--primary" onClick={onNewPanel}>
                + Neuer Verteiler
              </button>
            )}
          </div>

          {loading && <p className="sp-scope-hint">Wird geladen…</p>}

          {!loading && panels.length === 0 && (
            <p className="sp-scope-hint">
              Für diesen Kunden ist noch kein Verteiler erfasst.
              {canEdit ? " Lege den Hauptverteiler an und arbeite dich zu den Unterverteilern vor." : ""}
            </p>
          )}

          <div className="sp-panel-cards">
            {panels.map((panel) => (
              <button
                key={panel.id}
                type="button"
                className={
                  panel.id === activePanelId ? "sp-panel-card sp-panel-card--active" : "sp-panel-card"
                }
                onClick={() => onSelectPanel(panel.id)}
              >
                <span className="sp-panel-card-top">
                  <span className={`sp-panel-badge sp-panel-badge--${panel.panel_type}`}>
                    {panel.designation}
                  </span>
                  <span className="sp-panel-card-title">{panel.name}</span>
                </span>
                <span className="sp-panel-card-meta">
                  {PANEL_TYPE_LABELS[panel.panel_type]}
                  {panel.location ? ` · ${panel.location}` : ""}
                  {panel.fed_from_designation ? ` · von ${panel.fed_from_designation}` : ""}
                </span>
                <span className="sp-panel-card-stats">
                  <span>{panel.circuit_count} Stromkreise</span>
                  <span>{panel.rcd_count} FI</span>
                  <span>
                    {panel.used_slots}/{panel.total_slots} TE
                  </span>
                  <span className={panel.status === "final" ? "sp-status sp-status--final" : "sp-status"}>
                    {panel.status === "final" ? "Bestand" : "Entwurf"} · Rev. {panel.revision}
                  </span>
                </span>
                <span className="sp-panel-card-foot">
                  Zuletzt {relativeDate(panel.updated_at)}
                  {panel.updated_by_name ? ` · ${panel.updated_by_name}` : ""}
                  {panel.project_number ? ` · ${panel.project_number}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
