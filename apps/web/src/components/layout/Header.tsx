import { useAppContext } from "../../context/AppContext";
import { PenIcon, BackIcon } from "../icons";
import { statusLabel } from "../../utils/projects";

export function Header() {
  const {
    language,
    mainView,
    setMainView,
    mainLabels,
    showOverviewBackButton,
    setOverviewShortcutBackVisible,
    activeProject,
    activeProjectHeader,
    activeProjectLastUpdatedLabel,
    projectBackView,
    constructionBackView,
    setConstructionBackView,
    setProjectTab,
    setProjectBackView,
    canCreateProject,
    openEditProjectModal,
    planningWeekStart,
    planningTaskTypeView,
    openTaskModal,
    canManageTasks,
  } = useAppContext();

  return (
    <header className="workspace-header">
      <div className="workspace-header-main">
        {showOverviewBackButton && (
          <button
            type="button"
            className="icon-btn header-back-btn"
            onClick={() => {
              setOverviewShortcutBackVisible(false);
              setMainView("overview");
            }}
          >
            <BackIcon />
            <span>{language === "de" ? "Zurück" : "Back"}</span>
          </button>
        )}
          <div>
          {mainView === "project" && activeProject ? (
            <>
              <h1>{activeProjectHeader.title}</h1>
              {activeProjectHeader.subtitle && <small className="project-name-subtle">{activeProjectHeader.subtitle}</small>}
            </>
          ) : (
            <h1>{mainLabels[mainView]}</h1>
          )}
          {mainView === "project" && activeProject && (
            <small>
              {activeProject.project_number} | {language === "de" ? "Status" : "Status"}:{" "}
              {statusLabel(activeProject.status, language)} |{" "}
              {language === "de" ? "Letzte Änderung" : "Last update"}: {activeProjectLastUpdatedLabel || "-"}
            </small>
          )}
        </div>
      </div>
      <div className="header-tools">
        {mainView === "planning" && canManageTasks && (
          <button
            type="button"
            onClick={() => openTaskModal({ dueDate: planningWeekStart, taskType: planningTaskTypeView })}
          >
            {language === "de" ? "Neue Aufgabe" : "Add task"}
          </button>
        )}
        {mainView === "construction" && constructionBackView && (
          <button
            type="button"
            className="icon-btn header-back-btn"
            onClick={() => {
              if (constructionBackView === "project") {
                setProjectTab("tasks");
              }
              setMainView(constructionBackView);
              setConstructionBackView(null);
            }}
          >
            <BackIcon />
            <span>{language === "de" ? "Zurück" : "Back"}</span>
          </button>
        )}
        {mainView === "project" && projectBackView === "my_tasks" && (
          <button
            type="button"
            onClick={() => {
              setMainView("my_tasks");
            }}
          >
            {language === "de" ? "Zurück zu Meine Aufgaben" : "Back to My Tasks"}
          </button>
        )}
        {mainView === "project" && projectBackView === "office_tasks" && (
          <button
            type="button"
            onClick={() => {
              setMainView("office_tasks");
            }}
          >
            {language === "de" ? "Zurück zu Aufgaben" : "Back to Tasks"}
          </button>
        )}
        {mainView === "project" && projectBackView === "projects_all" && (
          <button
            type="button"
            onClick={() => {
              setMainView("projects_all");
            }}
          >
            {language === "de" ? "Zurück zu Alle Projekte" : "Back to All Projects"}
          </button>
        )}
        {canCreateProject && mainView === "project" && activeProject && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => openEditProjectModal(activeProject)}
            aria-label={language === "de" ? "Projekt bearbeiten" : "Edit project"}
            title={language === "de" ? "Projekt bearbeiten" : "Edit project"}
          >
            <PenIcon />
          </button>
        )}
      </div>
    </header>
  );
}
