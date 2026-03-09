import { useAppContext } from "../../context/AppContext";
import { formatHours } from "../../utils/misc";
import { ProjectHoursGauge } from "../../components/gauges";

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

  return (
    <section className="grid">
      <div className="card project-hours-card">
        <div className="project-overview-card-head">
          <h3>{language === "de" ? "Projektstunden" : "Project Hours"}</h3>
        </div>
        <div className="project-hours-layout">
          <ProjectHoursGauge
            language={language}
            plannedHours={projectPlannedHoursTotal}
            workedHours={projectReportedHoursTotal}
          />
          <div className="project-hours-side">
            <div className="project-hours-metrics">
              <small>
                {language === "de" ? "Gemeldete Stunden (aus Berichten)" : "Reported hours (from reports)"}:{" "}
                <b>{formatHours(projectReportedHoursTotal)}</b>
              </small>
              <small>
                {language === "de" ? "Geplante Stunden" : "Planned hours"}:{" "}
                <b>{projectPlannedHoursTotal > 0 ? formatHours(projectPlannedHoursTotal) : "-"}</b>
              </small>
              <small>
                {language === "de" ? "Planverbrauch" : "Plan usage"}:{" "}
                <b>{projectPlannedHoursTotal > 0 ? `${projectHoursUsagePercent.toFixed(1)}%` : "-"}</b>
              </small>
            </div>
            {canManageFinance ? (
              <form
                className="project-hours-edit"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveProjectHours();
                }}
              >
                <label>
                  {language === "de" ? "Geplante Stunden" : "Planned hours"}
                  <input
                    type="text"
                    inputMode="decimal"
                    value={projectHoursPlannedInput}
                    onChange={(event) => setProjectHoursPlannedInput(event.target.value)}
                    placeholder="0.00"
                  />
                </label>
                <div className="row wrap">
                  <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
                  <button type="button" onClick={() => setProjectHoursPlannedInput("")}>
                    {language === "de" ? "Leeren" : "Clear"}
                  </button>
                </div>
              </form>
            ) : (
              <small className="muted">
                {language === "de"
                  ? "Nur mit Finanzrechten bearbeitbar."
                  : "Editable only with finance permissions."}
              </small>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
