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

  const orderValue = projectFinance?.order_value_net ?? 0;
  const actualCosts = projectFinance?.actual_costs ?? 0;
  const plannedCosts = projectFinance?.planned_costs ?? 0;
  const contributionMargin = projectFinance?.contribution_margin ?? 0;
  const marginPercent = orderValue > 0 ? (contributionMargin / orderValue) * 100 : 0;
  const actualCostDelta = actualCosts - plannedCosts;
  const actualCostDeltaPercent = plannedCosts > 0 ? (actualCostDelta / plannedCosts) * 100 : 0;
  const financeMilestones = [
    {
      key: "down_payment_35",
      share: "35%",
      title: language === "de" ? "Anzahlung" : "Down payment",
      subtitle: language === "de" ? "Bei Vertragsabschluss" : "Invoice on contract signing",
      value: projectFinance?.down_payment_35,
    },
    {
      key: "main_components_50",
      share: "50%",
      title: language === "de" ? "Hauptkomponenten" : "Main components",
      subtitle: language === "de" ? "Bei Lieferung des Hauptmaterials" : "On delivery of main materials",
      value: projectFinance?.main_components_50,
    },
    {
      key: "final_invoice_15",
      share: "15%",
      title: language === "de" ? "Schlussrechnung" : "Final invoice",
      subtitle: language === "de" ? "Bei Projektabschluss" : "On project completion",
      value: projectFinance?.final_invoice_15,
    },
  ];

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
            <div className="project-finance-hero-grid">
              <div className="project-finance-hero-card project-finance-hero-card-primary">
                <small className="project-finance-metric-label">
                  {language === "de" ? "Auftragswert netto" : "Order value (net)"}
                </small>
                <b className="project-finance-hero-value">{formatMoney(projectFinance?.order_value_net, language)}</b>
                <span className="project-finance-hero-note">
                  {language === "de" ? "Gesamter Auftragswert" : "Total contract value"}
                </span>
              </div>
              <div className="project-finance-hero-card project-finance-hero-card-success">
                <small className="project-finance-metric-label">
                  {language === "de" ? "Deckungsbeitrag" : "Contribution margin"}
                </small>
                <b className="project-finance-hero-value">{formatMoney(projectFinance?.contribution_margin, language)}</b>
                <span className="project-finance-hero-note">
                  {orderValue > 0 ? `${marginPercent.toFixed(1)}% ${language === "de" ? "vom Auftragswert" : "of order value"}` : "-"}
                </span>
              </div>
              <div className="project-finance-hero-card project-finance-hero-card-warning">
                <small className="project-finance-metric-label">
                  {language === "de" ? "Tatsächliche Kosten" : "Actual costs"}
                </small>
                <b className="project-finance-hero-value">{formatMoney(projectFinance?.actual_costs, language)}</b>
                <span className="project-finance-hero-note">
                  {plannedCosts > 0
                    ? `${language === "de" ? "vs." : "vs"} ${formatMoney(plannedCosts, language)} ${language === "de" ? "geplant" : "planned"}`
                    : language === "de" ? "Keine Plankosten" : "No planned costs"}
                </span>
              </div>
            </div>

            <div className="project-finance-paper-layout">
              <div className="project-finance-milestones-card">
                <h4>{language === "de" ? "Zahlungsmeilensteine" : "Payment Milestones"}</h4>
                <div className="project-finance-milestones-list">
                  {financeMilestones.map((milestone) => (
                    <div key={milestone.key} className="project-finance-milestone-row">
                      <span className="project-finance-milestone-share">{milestone.share}</span>
                      <div className="project-finance-milestone-copy">
                        <b>{milestone.title}</b>
                        <small>{milestone.subtitle}</small>
                      </div>
                      <b className="project-finance-milestone-value">{formatMoney(milestone.value, language)}</b>
                    </div>
                  ))}
                </div>
              </div>
              <div className="project-finance-breakdown-card">
                <h4>{language === "de" ? "Kostenübersicht" : "Cost Breakdown"}</h4>
                <div className="project-finance-breakdown-list">
                  <div className="project-finance-breakdown-row">
                    <small>{language === "de" ? "Geplante Kosten" : "Planned costs"}</small>
                    <b>{formatMoney(projectFinance?.planned_costs, language)}</b>
                  </div>
                  <div className="project-finance-breakdown-row">
                    <small>{language === "de" ? "Tatsächliche Kosten" : "Actual costs"}</small>
                    <b>{formatMoney(projectFinance?.actual_costs, language)}</b>
                  </div>
                  <div className="project-finance-breakdown-row">
                    <small>{language === "de" ? "Deckungsbeitrag" : "Contribution margin"}</small>
                    <b>{formatMoney(projectFinance?.contribution_margin, language)}</b>
                  </div>
                </div>
                <div className="project-finance-warning-box">
                  {plannedCosts > 0
                    ? actualCostDelta > 0
                      ? `${language === "de" ? "Tatsächliche Kosten überschreiten den Plan um" : "Actual costs exceed planned by"} ${formatMoney(actualCostDelta, language)} (${actualCostDeltaPercent.toFixed(1)}%)`
                      : `${language === "de" ? "Kosten liegen unter Plan um" : "Costs are under plan by"} ${formatMoney(Math.abs(actualCostDelta), language)} (${Math.abs(actualCostDeltaPercent).toFixed(1)}%)`
                    : language === "de"
                      ? "Für dieses Projekt sind noch keine Plankosten gesetzt."
                      : "No planned costs are set for this project yet."}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
