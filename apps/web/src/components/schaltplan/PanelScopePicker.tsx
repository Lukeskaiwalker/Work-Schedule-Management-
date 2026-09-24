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
 *
 * Before anything is typed, the customer search offers the panels touched
 * most recently ("Zuletzt bearbeitet"): the board somebody left an hour ago
 * is the one they come back to, and it should be one tap away, not a
 * customer, a project and a card.
 */
import { CustomerCombobox, type CustomerComboboxLeadingItems } from "../customers/CustomerCombobox";
import { PANEL_TYPE_LABELS } from "../../utils/schaltplanDevices";
import { parseServerDateTime } from "../../utils/dates";
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
  /** Newest first — shown at the top of the customer search while it is empty. */
  recentPanels?: PanelPlanSummary[];
  onPickRecent?: (panel: PanelPlanSummary) => void;
};

const RECENT_TITLE = "Zuletzt bearbeitet";

function relativeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/**
 * When a panel was last touched, as the search box's chip says it: minutes,
 * then hours within the same day, "gestern", then the short date. Naive
 * server timestamps are UTC (`parseServerDateTime`).
 */
export function recentPanelHint(iso: string, now: Date): string {
  const at = parseServerDateTime(iso);
  if (!at) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  if (minutes < 1) return "gerade eben";
  if (minutes < 60) return `vor ${minutes} Min.`;
  if (at.toDateString() === now.toDateString()) return `vor ${Math.floor(minutes / 60)} Std.`;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60_000);
  if (at.toDateString() === yesterday.toDateString()) return "gestern";
  return at.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

/** The combobox rows for the recent panels: number and name, customer · project, and the age. */
export function recentPanelItems(panels: PanelPlanSummary[], now: Date): CustomerComboboxLeadingItems["items"] {
  return panels.map((panel) => {
    const secondary = [panel.customer_name, panel.project_number].filter(Boolean).join(" · ");
    return {
      id: String(panel.id),
      primary: `${panel.panel_number} · ${panel.designation} ${panel.name}`.trim(),
      secondary: secondary || undefined,
      hint: recentPanelHint(panel.updated_at, now) || undefined,
    };
  });
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
  recentPanels,
  onPickRecent,
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

  const leadingItems: CustomerComboboxLeadingItems | undefined =
    recentPanels && recentPanels.length > 0 && onPickRecent
      ? {
          title: RECENT_TITLE,
          items: recentPanelItems(recentPanels, new Date()),
          onPick: (id) => {
            const hit = recentPanels.find((panel) => String(panel.id) === id);
            if (hit) onPickRecent(hit);
          },
        }
      : undefined;

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
            leadingItems={leadingItems}
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
