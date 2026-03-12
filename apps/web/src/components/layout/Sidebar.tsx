import { useEffect, useState, type RefObject } from "react";
import { useAppContext } from "../../context/AppContext";
import { NotificationPanel } from "../NotificationPanel";
import { BellIcon, SidebarNavIcon, SearchIcon } from "../icons";
import { AvatarBadge } from "../shared/AvatarBadge";

export function Sidebar() {
  const {
    token,
    language,
    workspaceMode,
    setWorkspaceMode,
    workspaceModeLabel,
    mainView,
    setMainView,
    sidebarOpen,
    setSidebarOpen,
    navViews,
    mainLabels,
    hasUnreadThreads,
    sseStatus,
    hasTaskNotifications,
    notifications,
    notifPanelOpen,
    setNotifPanelOpen,
    markAllNotificationsRead,
    setProjectBackView,
    setOverviewShortcutBackVisible,
    setConstructionBackView,
    setMyTasksBackProjectId,
    projectSidebarSearchOpen,
    setProjectSidebarSearchOpen,
    projectSidebarSearchQuery,
    setProjectSidebarSearchQuery,
    filteredSidebarProjects,
    activeProjectId,
    setActiveProjectId,
    setProjectTab,
    setHighlightedArchivedProjectId,
    canCreateProject,
    openCreateProjectModal,
    preUserMenuOpen,
    setPreUserMenuOpen,
    preUserMenuRef,
    setLanguage,
    isAdmin,
    canManageProjectImport,
    canManageSchoolAbsences,
    openAdminViewFromMenu,
    openProfileViewFromMenu,
    signOut,
    currentReleaseLabel,
    user,
    userInitials,
    avatarVersionKey,
    menuUserNameById,
    sidebarNowLabel,
    projectTitleParts,
  } = useAppContext();

  const mobileQuery =
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 899px)")
      : null;

  const [isMobileSidebarViewport, setIsMobileSidebarViewport] = useState(
    () => mobileQuery?.matches ?? false,
  );

  useEffect(() => {
    if (!mobileQuery) return;
    const onChange = (e: MediaQueryListEvent) =>
      setIsMobileSidebarViewport(e.matches);
    mobileQuery.addEventListener("change", onChange);
    return () => mobileQuery.removeEventListener("change", onChange);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isMobileSidebarViewport || !sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobileSidebarViewport, sidebarOpen, setSidebarOpen]);

  useEffect(() => {
    if (!isMobileSidebarViewport || !sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobileSidebarViewport, sidebarOpen]);

  const sidebarVisible = !isMobileSidebarViewport || sidebarOpen;
  const closeSidebar = () => setSidebarOpen(false);

  return (
    <>
      <aside
        className={sidebarVisible ? "sidebar sidebar--open" : "sidebar"}
        aria-hidden={isMobileSidebarViewport ? !sidebarOpen : false}
      >
      <div className="sidebar-main">
        <div className="brand-block">
          <img src="/logo.jpeg" alt="Company logo" className="brand-logo" />
          <div className="brand-meta">
            <div className="brand-title-row">
              <h2>SMPL</h2>
              <div className="workspace-mode-switch" role="group" aria-label={language === "de" ? "Ansicht wählen" : "Select view"}>
                <button
                  type="button"
                  className={workspaceMode === "construction" ? "active" : ""}
                  onClick={() => {
                    setWorkspaceMode("construction");
                    closeSidebar();
                  }}
                >
                  {language === "de" ? "Baustelle" : "Construction"}
                </button>
                <button
                  type="button"
                  className={workspaceMode === "office" ? "active" : ""}
                  onClick={() => {
                    setWorkspaceMode("office");
                    closeSidebar();
                  }}
                >
                  {language === "de" ? "Büro" : "Office"}
                </button>
              </div>
            </div>
            <small className="role">
              {language === "de" ? "Workflow-App" : "Workflow app"} | {workspaceModeLabel}
            </small>
          </div>
        </div>

        <nav className="main-nav">
          {navViews.map((item) => (
            <button
              key={item}
              className={item === mainView ? "active" : ""}
              onClick={() => {
                setProjectBackView(null);
                setOverviewShortcutBackVisible(false);
                setConstructionBackView(null);
                if (item === "my_tasks" || item === "office_tasks") setMyTasksBackProjectId(null);
                setMainView(item);
                closeSidebar();
              }}
            >
              <span className="nav-item-content">
                <span className="nav-icon-wrap">
                  <SidebarNavIcon view={item} />
                  {item === "messages" && hasUnreadThreads && <span className="nav-unread-dot" />}
                  {(item === "my_tasks" || item === "office_tasks" || item === "planning" || item === "calendar") &&
                    hasTaskNotifications && (
                    <span className="nav-unread-dot" />
                  )}
                </span>
                <span>{mainLabels[item]}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="project-list">
          <div className="project-list-title-row">
            <div className="project-list-title-group">
              <div className="project-list-title">{language === "de" ? "Projekte" : "Projects"}</div>
              <button
                type="button"
                className={projectSidebarSearchOpen ? "icon-btn project-search-toggle active" : "icon-btn project-search-toggle"}
                onClick={() => {
                  setProjectSidebarSearchOpen((current) => {
                    const next = !current;
                    if (!next) setProjectSidebarSearchQuery("");
                    return next;
                  });
                }}
                aria-label={language === "de" ? "Projekt-Suche" : "Project search"}
                title={language === "de" ? "Projekt-Suche" : "Project search"}
              >
                <SearchIcon />
              </button>
            </div>
            {canCreateProject && (
              <button
                type="button"
                className="create-new-btn"
                onClick={() => {
                  openCreateProjectModal();
                  closeSidebar();
                }}
                aria-label={language === "de" ? "Neues Projekt erstellen" : "Create new project"}
                title={language === "de" ? "Neues Projekt erstellen" : "Create new project"}
              >
                +
              </button>
            )}
          </div>
          {projectSidebarSearchOpen && (
            <input
              autoFocus
              className="project-sidebar-search-input"
              value={projectSidebarSearchQuery}
              onChange={(event) => setProjectSidebarSearchQuery(event.target.value)}
              placeholder={language === "de" ? "Projekt suchen..." : "Search project..."}
              aria-label={language === "de" ? "Projekt suchen" : "Search project"}
            />
          )}
          <div className={projectSidebarSearchOpen ? "project-list-scroll with-search" : "project-list-scroll"}>
            {filteredSidebarProjects.map(({ project, isArchived }) => {
              const projectLabel = projectTitleParts(project);
              return (
                <button
                  key={project.id}
                  className={[
                    "project-item",
                    project.id === activeProjectId && mainView === "project" ? "active" : "",
                    isArchived ? "project-item-archived" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => {
                    if (isArchived) {
                      setHighlightedArchivedProjectId(project.id);
                      setProjectBackView(null);
                      setOverviewShortcutBackVisible(false);
                      setConstructionBackView(null);
                      setMainView("projects_archive");
                      closeSidebar();
                      return;
                    }
                    setActiveProjectId(project.id);
                    setProjectTab("overview");
                    setProjectBackView(null);
                    setOverviewShortcutBackVisible(false);
                    setConstructionBackView(null);
                    setMainView("project");
                    closeSidebar();
                  }}
                >
                  <span className="project-item-main">
                    <b>{projectLabel.title}</b>
                    {projectLabel.subtitle && <small className="project-name-subtle">{projectLabel.subtitle}</small>}
                    {isArchived && (
                      <small className="project-item-archive-mark">
                        {language === "de" ? "Archiviert" : "Archived"}
                      </small>
                    )}
                  </span>
                </button>
              );
            })}
            {filteredSidebarProjects.length === 0 && (
              <small>{projectSidebarSearchQuery ? (language === "de" ? "Keine Treffer" : "No matching projects") : language === "de" ? "Keine Projekte" : "No projects"}</small>
            )}
            <div className="project-list-archive-entry">
              <div className="project-list-divider" />
              <button
                type="button"
                className={mainView === "projects_archive" ? "project-archive-btn active" : "project-archive-btn"}
                onClick={() => {
                  setProjectBackView(null);
                  setOverviewShortcutBackVisible(false);
                  setConstructionBackView(null);
                  setMainView("projects_archive");
                  closeSidebar();
                }}
              >
                {language === "de" ? "Projektarchiv" : "Project archive"}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="sidebar-footer">
        {token && (
          <div className="notif-bell-wrap">
            <button
              type="button"
              className="notif-bell-btn"
              onClick={() => {
                setPreUserMenuOpen(false);
                setNotifPanelOpen((current) => !current);
              }}
              aria-label={language === "de" ? "Benachrichtigungen" : "Notifications"}
              title={language === "de" ? "Benachrichtigungen" : "Notifications"}
            >
              <BellIcon />
              {hasTaskNotifications && <span className="notif-bell-badge" aria-label="Unread notifications" />}
            </button>
            {notifPanelOpen && (
              <NotificationPanel
                notifications={notifications}
                language={language}
                onMarkAllRead={() => {
                  void markAllNotificationsRead();
                }}
                onDismiss={() => setNotifPanelOpen(false)}
                onNavigate={(notif) => {
                  setNotifPanelOpen(false);
                  setProjectBackView(null);
                  setOverviewShortcutBackVisible(false);
                  setConstructionBackView(null);
                  if (notif.entity_type === "task") {
                    if (notif.project_id) {
                      setActiveProjectId(notif.project_id);
                    }
                    setMyTasksBackProjectId(null);
                    setMainView("my_tasks");
                    closeSidebar();
                    return;
                  }
                  if (notif.project_id) {
                    setActiveProjectId(notif.project_id);
                    setProjectTab("overview");
                    setMainView("project");
                    closeSidebar();
                  }
                }}
              />
            )}
          </div>
        )}
        <div className="pre-user-menu-wrap" ref={preUserMenuRef as RefObject<HTMLDivElement>}>
          {preUserMenuOpen && (
            <div className="pre-user-menu-popup">
              <div className="row lang-row lang-row-small pre-user-lang">
                <button
                  type="button"
                  onClick={() => setLanguage("de")}
                  className={language === "de" ? "active" : ""}
                >
                  DE
                </button>
                <button
                  type="button"
                  onClick={() => setLanguage("en")}
                  className={language === "en" ? "active" : ""}
                >
                  EN
                </button>
              </div>
              <button
                type="button"
                className="pre-user-action"
                onClick={() => {
                  openProfileViewFromMenu();
                  closeSidebar();
                }}
              >
                {language === "de" ? "Benutzerdaten" : "User data"}
              </button>
              {(isAdmin || canManageProjectImport || canManageSchoolAbsences) && (
                <button
                  type="button"
                  className="pre-user-action"
                  onClick={() => {
                    openAdminViewFromMenu();
                    closeSidebar();
                  }}
                >
                  {language === "de" ? "Admin Center" : "Admin Center"}
                </button>
              )}
              <button
                type="button"
                className="pre-user-action"
                onClick={() => {
                  signOut();
                  closeSidebar();
                }}
              >
                {language === "de" ? "Abmelden" : "Sign out"}
              </button>
              <div className="pre-user-meta">
                <small>
                  {language === "de" ? "Release-Version" : "Release version"}: <b>{currentReleaseLabel}</b>
                </small>
                <small>
                  {language === "de" ? "Mitarbeiter-ID" : "Employee ID"}: <b>{user!.id}</b>
                </small>
              </div>
            </div>
          )}
          <button
            type="button"
            className={mainView === "profile" || mainView === "admin" ? "sidebar-user-btn active" : "sidebar-user-btn"}
            onClick={() => setPreUserMenuOpen(!preUserMenuOpen)}
            aria-expanded={preUserMenuOpen}
            aria-label={language === "de" ? "Benutzermenü öffnen" : "Open user menu"}
          >
            <div className="sidebar-user">
              <AvatarBadge
                userId={user!.id}
                initials={userInitials}
                hasAvatar={Boolean(user!.avatar_updated_at)}
                versionKey={avatarVersionKey}
              />
              <div className="sidebar-user-meta">
                <b>{menuUserNameById(user!.id, user!.display_name || user!.full_name)}</b>
                <small className="role">Role: {user!.role}</small>
              </div>
              {token && (
                <span
                  className={`sse-status-dot sse-status-dot--${sseStatus}`}
                  title={
                    sseStatus === "connected"
                      ? "Live - updates arrive instantly"
                      : sseStatus === "connecting"
                        ? "Connecting to live updates..."
                        : sseStatus === "reconnecting"
                          ? "Reconnecting..."
                          : "Live updates offline"
                  }
                  aria-label={`Live connection status: ${sseStatus}`}
                />
              )}
            </div>
          </button>
        </div>
        <div className="sidebar-now">
          <small>{sidebarNowLabel}</small>
        </div>
      </div>
      </aside>
      {isMobileSidebarViewport && sidebarOpen && (
        <div
          className="sidebar-overlay active"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </>
  );
}
