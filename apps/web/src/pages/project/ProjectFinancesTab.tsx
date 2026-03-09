import { useAppContext } from "../../context/AppContext";
import { formatServerDateTime } from "../../utils/dates";
import { financeLabel, projectFinanceToFormState, formatMoney } from "../../utils/finance";
import { PenIcon } from "../../components/icons";
import type { ProjectFinanceFormState } from "../../types";

export function ProjectFinancesTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    projectFinance,
    projectFinanceEditing,
    setProjectFinanceEditing,
    projectFinanceForm,
    setProjectFinanceForm,
    canManageFinance,
    updateProjectFinanceFormField,
    saveProjectFinance,
  } = useAppContext();

  if (mainView !== "project" || !activeProject || projectTab !== "finances") return null;

  return (
    <section className="grid">
      <div className="card project-finance-card">
        <div className="project-overview-card-head">
          <h3>{language === "de" ? "Finanzen" : "Finances"}</h3>
          {canManageFinance && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                if (!projectFinanceEditing) {
                  setProjectFinanceForm(projectFinanceToFormState(projectFinance));
                }
                setProjectFinanceEditing(!projectFinanceEditing);
              }}
              aria-label={language === "de" ? "Finanzen bearbeiten" : "Edit finances"}
              title={language === "de" ? "Finanzen bearbeiten" : "Edit finances"}
            >
              <PenIcon />
            </button>
          )}
        </div>
        {projectFinanceEditing && canManageFinance ? (
          <form
            className="project-finance-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveProjectFinance();
            }}
          >
            {(
              [
                "order_value_net",
                "down_payment_35",
                "main_components_50",
                "final_invoice_15",
                "planned_costs",
                "actual_costs",
                "contribution_margin",
              ] as (keyof ProjectFinanceFormState)[]
            ).map((field) => (
              <label key={`finance-field-${field}`}>
                {financeLabel(field, language)}
                <input
                  type="text"
                  inputMode="decimal"
                  value={projectFinanceForm[field]}
                  onChange={(event) => updateProjectFinanceFormField(field, event.target.value)}
                  placeholder="0.00"
                />
              </label>
            ))}
            <div className="row wrap">
              <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
              <button type="button" onClick={() => setProjectFinanceEditing(false)}>
                {language === "de" ? "Abbrechen" : "Cancel"}
              </button>
            </div>
          </form>
        ) : (
          <>
            <small className="project-finance-last-update">
              {language === "de" ? "Zuletzt aktualisiert" : "Last updated"}:{" "}
              <b>
                {projectFinance?.updated_at
                  ? formatServerDateTime(projectFinance.updated_at, language)
                  : "-"}
              </b>
            </small>
            <div className="project-finance-grid">
              <div className="project-finance-metric">
                <small className="project-finance-metric-label">
                  {language === "de" ? "Auftragswert netto" : "Order value (net)"}
                </small>
                <b className="project-finance-metric-value">{formatMoney(projectFinance?.order_value_net, language)}</b>
              </div>
              <div className="project-finance-metric">
                <small className="project-finance-metric-label">
                  {language === "de" ? "35% Anzahlung" : "35% down payment"}
                </small>
                <b className="project-finance-metric-value">{formatMoney(projectFinance?.down_payment_35, language)}</b>
              </div>
              <div className="project-finance-metric">
                <small className="project-finance-metric-label">
                  {language === "de" ? "50% Hauptkomponenten" : "50% main components"}
                </small>
                <b className="project-finance-metric-value">{formatMoney(projectFinance?.main_components_50, language)}</b>
              </div>
              <div className="project-finance-metric">
                <small className="project-finance-metric-label">
                  {language === "de" ? "15% Schlussrechnung" : "15% final invoice"}
                </small>
                <b className="project-finance-metric-value">{formatMoney(projectFinance?.final_invoice_15, language)}</b>
              </div>
              <div className="project-finance-metric">
                <small className="project-finance-metric-label">
                  {language === "de" ? "Geplante Kosten" : "Planned costs"}
                </small>
                <b className="project-finance-metric-value">{formatMoney(projectFinance?.planned_costs, language)}</b>
              </div>
              <div className="project-finance-metric">
                <small className="project-finance-metric-label">
                  {language === "de" ? "Tatsächliche Kosten" : "Actual costs"}
                </small>
                <b className="project-finance-metric-value">{formatMoney(projectFinance?.actual_costs, language)}</b>
              </div>
              <div className="project-finance-metric">
                <small className="project-finance-metric-label">
                  {language === "de" ? "Deckungsbeitrag" : "Contribution margin"}
                </small>
                <b className="project-finance-metric-value">
                  {formatMoney(projectFinance?.contribution_margin, language)}
                </b>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
