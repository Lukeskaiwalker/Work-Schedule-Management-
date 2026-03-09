import { useAppContext } from "../../context/AppContext";
import { formatDayLabel, formatServerDateTime } from "../../utils/dates";
import { statusLabel, projectSiteAccessDisplay, activityEventLabel } from "../../utils/projects";
import { formatHours } from "../../utils/misc";
import { weatherDescriptionLabel } from "../../utils/weather";
import { PenIcon, CopyIcon } from "../../components/icons";

export function ProjectOverviewTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    projectOverviewOpenTasks,
    activeProjectAddress,
    activeProjectMapEmbedUrl,
    activeProjectMapOpenUrl,
    activeProjectLastUpdatedLabel,
    activeProjectLastState,
    activeProjectLastStatusAtLabel,
    activeProjectClassTemplates,
    projectReportedHoursTotal,
    projectPlannedHoursTotal,
    projectWeatherLoading,
    projectWeather,
    projectNoteEditing,
    setProjectNoteEditing,
    projectNoteDraft,
    setProjectNoteDraft,
    saveProjectInternalNote,
    projectOverviewDetails,
    workspaceMode,
    copyToClipboard,
    getTaskAssigneeLabel,
  } = useAppContext();

  if (mainView !== "project" || !activeProject || projectTab !== "overview") return null;

  return (
    <section className="grid project-overview-grid">
      <div className="card project-overview-glance">
        <h3 className="project-overview-title">{language === "de" ? "Projektüberblick" : "Project glance"}</h3>
        <small className="project-overview-subheading">
          {language === "de" ? "Offene Aufgaben" : "Open tasks"}
        </small>
        <div className="project-overview-open-task-list">
          <ul className="overview-list">
            {projectOverviewOpenTasks.map((task) => (
              <li key={`project-overview-open-task-${task.id}`}>
                <div className="overview-list-item">
                  <b>{task.title}</b>
                  <small>
                    {task.due_date
                      ? `${language === "de" ? "Fällig" : "Due"}: ${formatDayLabel(task.due_date, language)}`
                      : language === "de"
                        ? "Ohne Fälligkeitsdatum"
                        : "No due date"}
                  </small>
                  <small>
                    {language === "de" ? "Zugewiesen" : "Assigned"}: {getTaskAssigneeLabel(task)}
                  </small>
                </div>
              </li>
            ))}
            {projectOverviewOpenTasks.length === 0 && (
              <li className="muted">
                {language === "de" ? "Keine offenen Aufgaben." : "No open tasks."}
              </li>
            )}
          </ul>
        </div>
      </div>

      <aside className="card project-map-card project-map-card-full">
        <div className="project-overview-card-head">
          <h3 className="project-overview-title">{language === "de" ? "Baustellenkarte" : "Construction site map"}</h3>
          <button
            type="button"
            className="icon-btn task-edit-icon-btn project-map-copy-btn"
            onClick={() => void copyToClipboard(activeProjectAddress, "address")}
            disabled={!activeProjectAddress}
            aria-label={language === "de" ? "Adresse kopieren" : "Copy address"}
            title={language === "de" ? "Adresse kopieren" : "Copy address"}
          >
            <CopyIcon />
          </button>
        </div>
        {activeProjectMapEmbedUrl ? (
          <a
            className="project-map-link"
            target="_blank"
            rel="noreferrer"
            href={activeProjectMapOpenUrl}
            title={language === "de" ? "In Karten öffnen" : "Open in maps"}
          >
            <iframe
              title={language === "de" ? "Projektkarte" : "Project map"}
              className="project-map-frame"
              src={activeProjectMapEmbedUrl}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </a>
        ) : (
          <small className="muted">
            {language === "de"
              ? "Keine Baustellen- oder Kundenadresse hinterlegt."
              : "No construction site or customer address available."}
          </small>
        )}
      </aside>

      <div className="card project-overview-meta">
        <h3 className="project-overview-title">{language === "de" ? "Projektdaten" : "Project data"}</h3>
        <small>
          {language === "de" ? "Projekt-ID" : "Project ID"}: <b>{activeProject.project_number}</b>
        </small>
        <small>
          {language === "de" ? "Status" : "State"}: <b>{statusLabel(activeProject.status, language)}</b>
        </small>
        <small>
          {language === "de" ? "Letzte Änderung" : "Last update"}: <b>{activeProjectLastUpdatedLabel || "-"}</b>
        </small>
        <small>
          {language === "de" ? "Gemeldete Stunden (Berichte)" : "Reported hours (reports)"}:{" "}
          <b>{formatHours(projectReportedHoursTotal)}</b>
        </small>
        <small>
          {language === "de" ? "Geplante Projektstunden" : "Planned project hours"}:{" "}
          <b>{projectPlannedHoursTotal > 0 ? formatHours(projectPlannedHoursTotal) : "-"}</b>
        </small>
        <small>
          {language === "de" ? "Kunde" : "Customer"}: <b>{(activeProject.customer_name ?? "").trim() || "-"}</b>
        </small>
        <small>
          {language === "de" ? "Letzter Stand" : "Last state"}: <b>{activeProjectLastState || "-"}</b>
        </small>
        <small>
          {language === "de" ? "Projektklassen" : "Project classes"}:{" "}
          <b>
            {activeProjectClassTemplates.length > 0
              ? activeProjectClassTemplates.map((entry) => entry.name).join(", ")
              : "-"}
          </b>
        </small>
        <small>
          {language === "de" ? "Letztes Status-Datum" : "Last status update"}: <b>{activeProjectLastStatusAtLabel || "-"}</b>
        </small>
      </div>

      <div className="card project-overview-contact">
        <h3 className="project-overview-title">{language === "de" ? "Kontakt" : "Contact"}</h3>
        <small>
          {language === "de" ? "Kontaktperson" : "Contact person"}: <b>{(activeProject.customer_contact ?? "").trim() || "-"}</b>
        </small>
        <small>
          {language === "de" ? "E-Mail" : "E-mail"}: <b>{(activeProject.customer_email ?? "").trim() || "-"}</b>
        </small>
        <small>
          {language === "de" ? "Telefon" : "Phone"}: <b>{(activeProject.customer_phone ?? "").trim() || "-"}</b>
        </small>
        <small>
          {language === "de" ? "Kundenadresse" : "Customer address"}:{" "}
          <b>{(activeProject.customer_address ?? "").trim() || "-"}</b>
        </small>
        <small>
          {language === "de" ? "Baustellenadresse" : "Construction site address"}:{" "}
          <b>{(activeProject.construction_site_address ?? "").trim() || "-"}</b>
        </small>
        <small>
          {language === "de" ? "Zugang Baustelle" : "Site access"}:{" "}
          <b>{projectSiteAccessDisplay(activeProject.site_access_type, activeProject.site_access_note, language)}</b>
        </small>
      </div>

      <div className="card project-overview-weather">
        <h3 className="project-overview-title">{language === "de" ? "Wetter" : "Weather"}</h3>
        {projectWeatherLoading && (
          <small className="muted">{language === "de" ? "Lade Wetterdaten..." : "Loading weather..."}</small>
        )}
        {!projectWeatherLoading && projectWeather?.days?.length ? (
          <>
            <small className="muted">
              {(language === "de" ? "Adresse" : "Address")}: {projectWeather.query_address}
            </small>
            <small className="muted">
              {(language === "de" ? "Aktualisiert" : "Updated")}:{" "}
              {projectWeather.fetched_at
                ? formatServerDateTime(projectWeather.fetched_at, language)
                : "-"}
              {projectWeather.stale
                ? ` • ${language === "de" ? "Zwischenspeicher (offline)" : "Cached (offline)"}`
                : ""}
            </small>
            <div className="project-weather-grid">
              {projectWeather.days.map((day, index) => {
                const dayDate = new Date(day.date);
                const dayDescription = weatherDescriptionLabel(day.description, language);
                const dayLabel = Number.isNaN(dayDate.getTime())
                  ? day.date
                  : dayDate.toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
                      weekday: "short",
                      day: "2-digit",
                      month: "2-digit",
                    });
                const iconUrl = day.icon
                  ? `https://openweathermap.org/img/wn/${encodeURIComponent(day.icon)}@2x.png`
                  : "";
                return (
                  <div key={`project-weather-day-${index}-${day.date}`} className="project-weather-day-card">
                    <small>{dayLabel}</small>
                    {iconUrl ? (
                      <img
                        src={iconUrl}
                        alt={dayDescription || (language === "de" ? "Wetter" : "Weather")}
                        loading="lazy"
                      />
                    ) : null}
                    <b>
                      {day.temp_min != null && day.temp_max != null
                        ? `${Math.round(day.temp_min)}° / ${Math.round(day.temp_max)}°`
                        : "-"}
                    </b>
                    <small>{dayDescription || "-"}</small>
                    <small>
                      {language === "de" ? "Regen" : "Rain"}:{" "}
                      {day.precipitation_probability != null ? `${Math.round(day.precipitation_probability)}%` : "-"}
                    </small>
                  </div>
                );
              })}
            </div>
            {projectWeather.message && <small className="muted">{projectWeather.message}</small>}
          </>
        ) : null}
        {!projectWeatherLoading && (!projectWeather || projectWeather.days.length === 0) && (
          <small className="muted">
            {projectWeather?.message ||
              (language === "de"
                ? "Noch keine Wetterdaten verfügbar."
                : "No weather data available yet.")}
          </small>
        )}
      </div>

      <div className="card project-overview-note">
        <div className="project-overview-card-head">
          <h3 className="project-overview-title">{language === "de" ? "Interne Notiz" : "Internal note"}</h3>
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              setProjectNoteDraft(activeProject.description ?? "");
              setProjectNoteEditing(!projectNoteEditing);
            }}
            aria-label={language === "de" ? "Notiz bearbeiten" : "Edit note"}
            title={language === "de" ? "Notiz bearbeiten" : "Edit note"}
          >
            <PenIcon />
          </button>
        </div>
        {projectNoteEditing ? (
          <div className="project-note-edit">
            <textarea
              value={projectNoteDraft}
              onChange={(event) => setProjectNoteDraft(event.target.value)}
              placeholder={language === "de" ? "Interne Notiz" : "Internal note"}
            />
            <div className="row wrap">
              <button type="button" onClick={() => void saveProjectInternalNote()}>
                {language === "de" ? "Speichern" : "Save"}
              </button>
              <button type="button" onClick={() => setProjectNoteEditing(false)}>
                {language === "de" ? "Abbrechen" : "Cancel"}
              </button>
            </div>
          </div>
        ) : (
          <small>{(activeProject.description ?? "").trim() || "-"}</small>
        )}
      </div>

      {workspaceMode === "office" && (
        <div className="card project-overview-office-notes">
          <h3 className="project-overview-title">
            {language === "de" ? "Büro-Nacharbeit aus Berichten" : "Office follow-up from reports"}
          </h3>
          <ul className="overview-list">
            {(projectOverviewDetails?.office_notes ?? []).map((entry) => {
              const reportLabel =
                entry.report_number != null ? `#${entry.report_number}` : `#${entry.report_id}`;
              return (
                <li key={`project-office-note-${entry.report_id}`}>
                  <div className="project-office-note-row">
                    <b>
                      {language === "de" ? "Bericht" : "Report"} {reportLabel} (
                      {formatDayLabel(entry.report_date, language)})
                    </b>
                    <small>{formatServerDateTime(entry.created_at, language)}</small>
                    {entry.office_rework && (
                      <small className="project-office-note-text">
                        {language === "de" ? "Nacharbeit" : "Rework"}: {entry.office_rework}
                      </small>
                    )}
                    {entry.office_next_steps && (
                      <small className="project-office-note-text">
                        {language === "de" ? "Nächste Schritte" : "Next steps"}: {entry.office_next_steps}
                      </small>
                    )}
                  </div>
                </li>
              );
            })}
            {(projectOverviewDetails?.office_notes ?? []).length === 0 && (
              <li className="muted">
                {language === "de"
                  ? "Noch keine Büro-Nacharbeit oder nächste Schritte aus Berichten."
                  : "No office rework or next-step notes from reports yet."}
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="card project-overview-changes">
        <h3 className="project-overview-title">{language === "de" ? "Letzte Änderungen" : "Recent changes"}</h3>
        <ul className="overview-list">
          {(projectOverviewDetails?.recent_changes ?? []).map((change) => (
            <li key={`project-change-${change.id}`}>
              <div className="project-change-row">
                <b>{activityEventLabel(change.event_type, language)}</b>
                <small>
                  {formatServerDateTime(change.created_at, language)}
                  {change.actor_name ? ` • ${change.actor_name}` : ""}
                </small>
                <small>{change.message}</small>
              </div>
            </li>
          ))}
          {(projectOverviewDetails?.recent_changes ?? []).length === 0 && (
            <li className="muted">{language === "de" ? "Keine Änderungen vorhanden." : "No changes yet."}</li>
          )}
        </ul>
      </div>
    </section>
  );
}
