import { useEffect, useMemo, useState, type RefObject } from "react";
import { useAppContext } from "../../context/AppContext";
import { NotificationPanel } from "../NotificationPanel";
import { BellIcon, SidebarNavIcon } from "../icons";
import { AvatarBadge } from "../shared/AvatarBadge";
import type { MainView } from "../../types";

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
    preUserMenuOpen,
    setPreUserMenuOpen,
    preUserMenuRef,
    setLanguage,
    isAdmin,
    canManageUsers,
    canManagePermissions,
    canViewAudit,
    canManageSettings,
    canManageSystem,
    canExportBackups,
    canManageProjectImport,
    canManageSchoolAbsences,
    signOut,
    currentReleaseLabel,
    companySettings,
    user,
    userInitials,
    avatarVersionKey,
    menuUserNameById,
    sidebarNowLabel,
  } = useAppContext();

  const mobileQuery =
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 899px)")
      : null;

  const [isMobileSidebarViewport, setIsMobileSidebarViewport] = useState(
    () => mobileQuery?.matches ?? false,
  );
  const brandLogoUrl = companySettings?.logo_url?.trim() || "/logo.jpeg";
  const brandTitle = companySettings?.navigation_title?.trim() || "SMPL";

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
  const canAccessAdminCenter =
    isAdmin ||
    canManageUsers ||
    canManagePermissions ||
    canViewAudit ||
    canManageSettings ||
    canManageSystem ||
    canExportBackups ||
    canManageProjectImport ||
    canManageSchoolAbsences;

  // Append "admin" to the nav list for users with admin access so the Admin
  // Center becomes a first-class sidebar destination, matching the rest of
  // the nav items in the Paper design.
  //
  // "materials" is filtered out: the top-level Materials view was absorbed
  // into Werkstatt as sub-tabs (Projekt-Bedarfe + Katalog). Deep links still
  // work via App.tsx's redirect; the sidebar just no longer surfaces it.
  const visibleNavViews = useMemo<MainView[]>(() => {
    const withoutMaterials = navViews.filter((view) => view !== "materials");
    if (!canAccessAdminCenter) return withoutMaterials;
    if (withoutMaterials.includes("admin")) return withoutMaterials;
    return [...withoutMaterials, "admin"];
  }, [navViews, canAccessAdminCenter]);

  return (
    <>
      <aside
        className={sidebarVisible ? "sidebar sidebar--open" : "sidebar"}
        aria-hidden={isMobileSidebarViewport ? !sidebarOpen : false}
      >
      <div className="sidebar-main">
        <div className="brand-block">
          <div className="brand-header-row">
            <img src={brandLogoUrl} alt="Company logo" className="brand-logo" />
            <div className="brand-meta">
              <h2>{brandTitle}</h2>
            </div>
          </div>
          <div className="brand-now" aria-label={language === "de" ? "Aktuelles Datum und Uhrzeit" : "Current date and time"}>
            {sidebarNowLabel}
          </div>
          {!user?.workspace_lock && (
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
          )}
          <small className="role sidebar-workspace-label">
            {language === "de" ? "Workflow-App" : "Workflow app"} | {workspaceModeLabel}
          </small>
        </div>

        <nav className="main-nav">
          {visibleNavViews.map((item) => (
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
      </div>
      <div className="sidebar-footer">
        <div className="sidebar-footer-top">
          <div className="pre-user-menu-wrap" ref={preUserMenuRef as RefObject<HTMLDivElement>}>
            {preUserMenuOpen && (
              <div className="pre-user-menu-popup" role="menu">
                <div className="pre-user-menu-section">
                  <span className="pre-user-menu-section-label">
                    {language === "de" ? "SPRACHE" : "LANGUAGE"}
                  </span>
                  <div
                    className="pre-user-menu-lang"
                    role="group"
                    aria-label={language === "de" ? "Sprache wählen" : "Select language"}
                  >
                    <button
                      type="button"
                      onClick={() => setLanguage("de")}
                      className={
                        language === "de"
                          ? "pre-user-menu-lang-btn pre-user-menu-lang-btn--active"
                          : "pre-user-menu-lang-btn"
                      }
                    >
                      DE
                    </button>
                    <button
                      type="button"
                      onClick={() => setLanguage("en")}
                      className={
                        language === "en"
                          ? "pre-user-menu-lang-btn pre-user-menu-lang-btn--active"
                          : "pre-user-menu-lang-btn"
                      }
                    >
                      EN
                    </button>
                  </div>
                </div>
                <div className="pre-user-menu-divider" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="pre-user-menu-item pre-user-menu-item--danger"
                  onClick={() => {
                    signOut();
                    closeSidebar();
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M10 17l-5-5 5-5M5 12h12"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>{language === "de" ? "Abmelden" : "Sign out"}</span>
                </button>
                <div className="pre-user-menu-footer">
                  <small>
                    <span>{language === "de" ? "Version" : "Version"}</span>
                    <b>{currentReleaseLabel}</b>
                  </small>
                  <small>
                    <span>{language === "de" ? "Mitarbeiter-ID" : "Employee ID"}</span>
                    <b>{user!.id}</b>
                  </small>
                </div>
              </div>
            )}
            <button
              type="button"
              className={mainView === "profile" || mainView === "admin" ? "sidebar-user-btn active" : "sidebar-user-btn"}
              onClick={() => {
                setNotifPanelOpen(false);
                setPreUserMenuOpen(!preUserMenuOpen);
              }}
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
                  <small className="role">{user!.role}</small>
                </div>
              </div>
            </button>
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
          {token && (
            <div className="notif-bell-wrap">
              <button
                type="button"
                className={notifPanelOpen ? "notif-bell-btn notif-bell-btn--open" : "notif-bell-btn"}
                onClick={() => {
                  setPreUserMenuOpen(false);
                  setNotifPanelOpen((current) => !current);
                }}
                aria-expanded={notifPanelOpen}
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
                      setMyTasksBackProjectId(null);
                      setMainView("my_tasks");
                      closeSidebar();
                      return;
                    }
                    setMainView("overview");
                    closeSidebar();
                  }}
                />
              )}
            </div>
          )}
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
