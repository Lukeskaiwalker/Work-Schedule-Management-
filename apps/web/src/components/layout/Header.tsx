import { useAppContext } from "../../context/AppContext";
import { BackIcon } from "../icons";
import type { MainView } from "../../types";

/**
 * Pages that render their own in-card "title + toolbar" header (matching Paper).
 * For these views we hide the generic Header.tsx <h1> to avoid visually doubling
 * the page title. The Header bar still shows the date/time and back buttons.
 */
const PAGES_WITH_OWN_TITLE: ReadonlySet<MainView> = new Set<MainView>([
  "my_tasks",
  "office_tasks",
  "calendar",
  "materials",
  "werkstatt",
  "messages",
  "profile",
  "admin",
  "planning",
  "customers",
  "customer_detail",
]);

function userInitials(displayName: string | undefined, fullName: string | undefined): string {
  const name = (displayName || fullName || "").trim();
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  return `${(parts[0] ?? "").charAt(0)}${(parts[parts.length - 1] ?? "").charAt(0)}`.toUpperCase();
}

export function Header() {
  const {
    language,
    mainView,
    user,
    sidebarOpen,
    setSidebarOpen,
    setMainView,
    mainLabels,
    showOverviewBackButton,
    setOverviewShortcutBackVisible,
    activeProject,
    projectBackView,
    constructionBackView,
    setConstructionBackView,
    setProjectTab,
    canCreateProject,
    openEditProjectModal,
    canManageTasks,
    openTaskModal,
    now,
    companySettings,
  } = useAppContext();

  const isProject = mainView === "project" && !!activeProject;

  // Format "Thu, 10 Apr 2026 · 09:42" (en) / "Do, 10. Apr 2026 · 09:42" (de)
  const locale = language === "de" ? "de-DE" : "en-US";
  const dateLabel = now.toLocaleDateString(locale, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const timeLabel = now.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const headerDateLabel = `${dateLabel} · ${timeLabel}`;

  function handleProjectBack() {
    if (projectBackView === "my_tasks") setMainView("my_tasks");
    else if (projectBackView === "office_tasks") setMainView("office_tasks");
    else if (projectBackView === "planning") setMainView("planning");
    else if (projectBackView === "customer_detail") setMainView("customer_detail");
    else setMainView("projects_all");
  }

  const projectBackLabel =
    projectBackView === "my_tasks"
      ? language === "de" ? "← Meine Aufgaben" : "← My Tasks"
      : projectBackView === "office_tasks"
        ? language === "de" ? "← Aufgaben" : "← Tasks"
        : projectBackView === "planning"
          ? language === "de" ? "← Wochenplanung" : "← Weekly Planning"
          : projectBackView === "customer_detail"
            ? language === "de" ? "← Kunde" : "← Customer"
            : language === "de" ? "← Alle Projekte" : "← All Projects";

  const brandTitle = companySettings?.navigation_title?.trim() || "SMPL";
  const avatarText = userInitials(user?.display_name, user?.full_name);

  return (
    <header className={`workspace-header${isProject ? " workspace-header-project" : ""}`}>
      <div className="workspace-header-main">
        <button
          type="button"
          className="icon-btn sidebar-toggle"
          onClick={() => setSidebarOpen((current) => !current)}
          aria-label={
            sidebarOpen
              ? language === "de" ? "Navigation schließen" : "Close navigation"
              : language === "de" ? "Navigation öffnen" : "Open navigation"
          }
          title={
            sidebarOpen
              ? language === "de" ? "Navigation schließen" : "Close navigation"
              : language === "de" ? "Navigation öffnen" : "Open navigation"
          }
        >
          <span aria-hidden="true">{sidebarOpen ? "✕" : "☰"}</span>
        </button>

        {/* Brand text — visible only on mobile (<768px), hidden on tablet/desktop */}
        <span className="mobile-header-brand">{brandTitle}</span>

        {isProject ? (
          <button type="button" className="project-header-back-btn" onClick={handleProjectBack}>
            {projectBackLabel}
          </button>
        ) : (
          <>
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
            {!PAGES_WITH_OWN_TITLE.has(mainView) && (
              <div className="workspace-header-title">
                <h1>{mainLabels[mainView]}</h1>
              </div>
            )}
          </>
        )}
      </div>

      <div className="header-tools workspace-header-actions">
        {mainView === "construction" && constructionBackView && (
          <button
            type="button"
            className="icon-btn header-back-btn"
            onClick={() => {
              if (constructionBackView === "project") setProjectTab("tasks");
              setMainView(constructionBackView);
              setConstructionBackView(null);
            }}
          >
            <BackIcon />
            <span>{language === "de" ? "Zurück" : "Back"}</span>
          </button>
        )}

        {isProject && canCreateProject && (
          <button
            type="button"
            className="project-header-action-btn"
            onClick={() => openEditProjectModal(activeProject)}
          >
            {language === "de" ? "Projekt bearbeiten" : "Edit Project"}
          </button>
        )}
        {isProject && canManageTasks && (
          <button
            type="button"
            className="project-header-action-btn primary"
            onClick={() => openTaskModal({ projectId: activeProject.id })}
          >
            + {language === "de" ? "Aufgabe" : "Add Task"}
          </button>
        )}

        {!isProject && (
          <span className="workspace-header-datetime" aria-label={headerDateLabel}>
            {headerDateLabel}
          </span>
        )}

        {/* User avatar — visible only on mobile (<768px), hidden on tablet/desktop */}
        <div className="mobile-header-avatar" aria-hidden="true">
          {avatarText}
        </div>
      </div>
    </header>
  );
}
