import { useAppContext } from "../../context/AppContext";
import type { MainView } from "../../types";

/**
 * Fixed bottom tab bar for phone viewports (< 768px).
 *
 * Provides quick access to the 5 Paper-specified destinations:
 * Start / Aufgaben / Werkstatt / Zeit / Profil. Any remaining destinations
 * (Calendar, Planning, Messages, Wiki, Admin, etc.) stay available through
 * the off-canvas sidebar drawer — a long-press on the logo / header
 * surfaces it on mobile layouts.
 *
 * Hidden on tablet (≥ 768px) and desktop (≥ 900px) via CSS.
 */
export function MobileBottomNav() {
  const {
    mainView,
    setMainView,
    setWerkstattTab,
    workspaceMode,
    language,
  } = useAppContext();

  // Don't render on project detail views — the project header + tabs
  // occupy the full screen on mobile and the bottom bar would clash.
  // Also hide behind the fullscreen mobile scanner (A IX-0) whose own
  // dark layout owns the whole viewport.
  if (mainView === "project") return null;
  if (mainView === "werkstatt_scan") return null;

  const de = language === "de";

  // The "Tasks" tab adapts per workspace mode:
  // Construction → my_tasks, Office → office_tasks.
  const tasksView: MainView =
    workspaceMode === "construction" ? "my_tasks" : "office_tasks";

  const isActive = (view: MainView | MainView[]) =>
    Array.isArray(view) ? view.includes(mainView) : mainView === view;

  // Icons are inline SVGs so the mobile nav matches the Paper artboards
  // (A3Y-0 / AIX-0 / ATF-0). Colour comes from `currentColor` so the
  // active-tab style can tint the whole glyph via CSS.
  type TabIcon = "home" | "tasks" | "werkstatt" | "time" | "profile";

  const renderIcon = (icon: TabIcon) => {
    switch (icon) {
      case "home":
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 11.5 12 4l9 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6 10.5v9h12v-9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "tasks":
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 7h14M7 12h14M7 17h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        );
      case "werkstatt":
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3.5 7.5a1.8 1.8 0 0 1 1.8-1.8h3.9l1.8 2.1h7.7a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
        );
      case "time":
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12.6" r="7.6" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 8.4v4.2l2.8 1.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "profile":
        return (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="8.4" r="3.6" stroke="currentColor" strokeWidth="1.8" />
            <path d="M4.8 20c.6-4 3.6-6.1 7.2-6.1s6.6 2.1 7.2 6.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
    }
  };

  const tabs: {
    key: string;
    label: string;
    icon: TabIcon;
    active: boolean;
    action: () => void;
  }[] = [
    {
      key: "home",
      label: de ? "Start" : "Home",
      icon: "home",
      active: isActive("overview"),
      action: () => setMainView("overview"),
    },
    {
      key: "tasks",
      label: de ? "Aufgaben" : "Tasks",
      icon: "tasks",
      active: isActive(["my_tasks", "office_tasks"]),
      action: () => setMainView(tasksView),
    },
    {
      key: "werkstatt",
      label: de ? "Werkstatt" : "Workshop",
      icon: "werkstatt",
      active: isActive(["werkstatt", "werkstatt_scan"]),
      action: () => {
        setWerkstattTab("dashboard");
        setMainView("werkstatt");
      },
    },
    {
      key: "time",
      label: de ? "Zeit" : "Time",
      icon: "time",
      active: isActive("time"),
      action: () => setMainView("time"),
    },
    {
      key: "profile",
      label: de ? "Profil" : "Profile",
      icon: "profile",
      active: isActive("profile"),
      action: () => setMainView("profile"),
    },
  ];

  return (
    <nav className="mobile-bottom-nav" aria-label={de ? "Hauptnavigation" : "Main navigation"}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={`mobile-bottom-nav-tab${tab.active ? " mobile-bottom-nav-tab--active" : ""}`}
          onClick={tab.action}
          aria-current={tab.active ? "page" : undefined}
        >
          <span className="mobile-bottom-nav-icon" aria-hidden="true">
            {renderIcon(tab.icon)}
          </span>
          <span className="mobile-bottom-nav-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
