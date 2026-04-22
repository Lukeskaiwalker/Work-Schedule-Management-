import { useAppContext } from "../../context/AppContext";
import { formatHours } from "../../utils/misc";

export function ProjectHoursTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    projectReportedHoursTotal,
    projectPlannedHoursTotal,
    projectHoursUsagePercent,
    projectHoursPlannedInput,
    setProjectHoursPlannedInput,
    canManageFinance,
    saveProjectHours,
  } = useAppContext();

  if (mainView !== "project" || !activeProject || projectTab !== "hours") return null;

  const de = language === "de";
  const planned = projectPlannedHoursTotal > 0 ? projectPlannedHoursTotal : 0;
  const worked = Math.max(projectReportedHoursTotal, 0);
  const remaining = planned > 0 ? Math.max(planned - worked, 0) : 0;
  const usagePercent = planned > 0 ? projectHoursUsagePercent : 0;
  const usageDisplay = planned > 0 ? `${usagePercent.toFixed(1)}%` : "—";
  const barFillPercent = Math.min(Math.max(usagePercent, 0), 100);

  // SVG donut geometry: 220×220 viewbox, stroke-width 28, radius 86
  const size = 220;
  const stroke = 28;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - barFillPercent / 100);

  return (
    <div className="project-hours-page">
      <section className="project-hours-main-card">
        <h2 className="project-hours-card-title">
          {de ? "Projektstunden" : "Project Hours"}
        </h2>

        <div className="project-hours-donut-wrap">
          <svg
            className="project-hours-donut"
            viewBox={`0 0 ${size} ${size}`}
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usagePercent}
            aria-valuetext={usageDisplay}
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              className="project-hours-donut-track"
              fill="none"
              strokeWidth={stroke}
            />
            {planned > 0 && (
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                className="project-hours-donut-fill"
                fill="none"
                strokeWidth={stroke}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            )}
          </svg>
          <div className="project-hours-donut-center">
            <span className="project-hours-donut-percent">{usageDisplay}</span>
            <span className="project-hours-donut-label">
              {de ? "Planverbrauch" : "plan usage"}
            </span>
          </div>
        </div>

        <div className="project-hours-legend">
          <span className="project-hours-legend-item">
            <span className="project-hours-legend-dot project-hours-legend-dot--reported" />
            {de ? "Berichtet" : "Reported"}: {formatHours(worked)}
          </span>
          <span className="project-hours-legend-item">
            <span className="project-hours-legend-dot project-hours-legend-dot--planned" />
            {de ? "Geplant" : "Planned"}: {planned > 0 ? formatHours(planned) : "—"}
          </span>
        </div>

        <div className="project-hours-budget-bar">
          <div className="project-hours-budget-labels">
            <span>0h</span>
            <span>{planned > 0 ? formatHours(planned) : "—"}</span>
          </div>
          <div className="project-hours-budget-track">
            <div
              className="project-hours-budget-fill"
              style={{ width: `${barFillPercent}%` }}
            />
          </div>
          <div className="project-hours-budget-remaining">
            {planned > 0
              ? de
                ? `${remaining.toFixed(1)} Stunden verbleibend im Budget`
                : `${remaining.toFixed(1)} hours remaining in budget`
              : de
                ? "Keine geplanten Stunden gesetzt"
                : "No planned hours set"}
          </div>
        </div>
      </section>

      <aside className="project-hours-aside">
        <section className="project-hours-summary-card">
          <h3 className="project-hours-card-subtitle">
            {de ? "Zusammenfassung" : "Summary"}
          </h3>
          <dl className="project-hours-summary-list">
            <div className="project-hours-summary-row">
              <dt>
                {de
                  ? "Berichtete Stunden (aus Berichten)"
                  : "Reported hours (from reports)"}
              </dt>
              <dd>{formatHours(worked)}</dd>
            </div>
            <div className="project-hours-summary-row">
              <dt>{de ? "Geplante Stunden" : "Planned hours"}</dt>
              <dd>{planned > 0 ? formatHours(planned) : "—"}</dd>
            </div>
            <div className="project-hours-summary-row">
              <dt>{de ? "Planverbrauch" : "Plan usage"}</dt>
              <dd className="project-hours-summary-accent">{usageDisplay}</dd>
            </div>
            <div className="project-hours-summary-row">
              <dt>{de ? "Verbleibend" : "Remaining"}</dt>
              <dd>{planned > 0 ? formatHours(remaining) : "—"}</dd>
            </div>
          </dl>
        </section>

        <section className="project-hours-edit-card">
          <h3 className="project-hours-card-subtitle">
            {de ? "Planstunden setzen" : "Set Planned Hours"}
          </h3>
          {canManageFinance ? (
            <form
              className="project-hours-edit-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveProjectHours();
              }}
            >
              <label className="project-hours-edit-field">
                <span className="project-hours-edit-field-label">
                  {de ? "Geplante Stunden" : "Planned hours"}
                </span>
                <div className="project-hours-edit-input-wrap">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={projectHoursPlannedInput}
                    onChange={(event) => setProjectHoursPlannedInput(event.target.value)}
                    placeholder="0.00"
                    className="project-hours-edit-input"
                  />
                  <span className="project-hours-edit-unit">h</span>
                </div>
              </label>
              <div className="project-hours-edit-actions">
                <button type="submit" className="project-hours-edit-save">
                  {de ? "Speichern" : "Save"}
                </button>
                <button
                  type="button"
                  className="project-hours-edit-clear"
                  onClick={() => setProjectHoursPlannedInput("")}
                >
                  {de ? "Leeren" : "Clear"}
                </button>
              </div>
            </form>
          ) : (
            <p className="project-hours-edit-hint">
              {de
                ? "Nur mit Finanzrechten bearbeitbar."
                : "Editable only with finance permissions."}
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
