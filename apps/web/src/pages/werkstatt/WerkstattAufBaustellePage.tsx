import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import {
  MOCK_ON_SITE_PROJECTS,
  type OnSiteItem,
  type OnSiteItemStatus,
  type OnSiteProject,
} from "../../components/werkstatt/mockData";

/**
 * WerkstattAufBaustellePage — "Auf Baustelle" full view. Drill-down target
 * of the Dashboard's "Auf Baustelle" card "Alle →" button.
 *
 * Shows all currently checked-out Werkstatt articles, grouped by project.
 * Each project group can be collapsed; filter chips narrow by status
 * (alle / aktiv / überfällig / heute / diese Woche). Search matches
 * article name, SP-number, or assignee.
 *
 * Per-row actions: "Zurückgeben" returns the item (stub callback — real
 * call lands on POST /api/werkstatt/mobile/return once the FE is wired).
 * "Mahnen" (per overdue row) fires a notice today; when notifications land,
 * it will trigger a reminder to the assignee.
 */
type FilterKey = "all" | "active" | "overdue" | "due_today" | "this_week";

interface FilterDef {
  key: FilterKey;
  label_de: string;
  label_en: string;
}

const FILTERS: ReadonlyArray<FilterDef> = [
  { key: "all", label_de: "Alle", label_en: "All" },
  { key: "active", label_de: "Aktiv", label_en: "Active" },
  { key: "overdue", label_de: "Überfällig", label_en: "Overdue" },
  { key: "due_today", label_de: "Heute", label_en: "Today" },
  { key: "this_week", label_de: "Diese Woche", label_en: "This week" },
];

function itemMatchesFilter(item: OnSiteItem, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "overdue") return item.status === "overdue";
  if (filter === "due_today") return item.status === "due_today";
  if (filter === "this_week") return item.status === "due_today" || item.status === "due_soon";
  if (filter === "active") return item.status !== "overdue";
  return true;
}

function statusClass(status: OnSiteItemStatus): string {
  switch (status) {
    case "overdue":
      return "werkstatt-onsite-return werkstatt-onsite-return--overdue";
    case "due_today":
      return "werkstatt-onsite-return werkstatt-onsite-return--today";
    case "due_soon":
      return "werkstatt-onsite-return werkstatt-onsite-return--soon";
    default:
      return "werkstatt-onsite-return";
  }
}

export function WerkstattAufBaustellePage() {
  const { mainView, language, werkstattTab, setNotice } = useAppContext();

  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  /* Filtered projects — drop groups that end up empty after filter+search. */
  const filteredProjects = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filterMatch = (item: OnSiteItem) => {
      if (!itemMatchesFilter(item, activeFilter)) return false;
      if (!needle) return true;
      return (
        item.article_name.toLowerCase().includes(needle) ||
        item.article_no.toLowerCase().includes(needle) ||
        item.assignee_name.toLowerCase().includes(needle)
      );
    };
    const projectMatch = (project: OnSiteProject) => {
      if (needle && (
        project.project_number.toLowerCase().includes(needle) ||
        project.project_title.toLowerCase().includes(needle)
      )) return project.items;  // whole group if project text matches
      return project.items.filter(filterMatch);
    };
    return MOCK_ON_SITE_PROJECTS
      .map((p) => ({ ...p, items: projectMatch(p) }))
      .filter((p) => p.items.length > 0);
  }, [search, activeFilter]);

  /* Totals for KPI strip — computed from the full (unfiltered) dataset so
   * the headline numbers don't change as you filter the view. */
  const totals = useMemo(() => {
    let totalItems = 0;
    let totalQuantity = 0;
    let overdue = 0;
    let dueToday = 0;
    const projectIds = new Set<string>();
    for (const project of MOCK_ON_SITE_PROJECTS) {
      projectIds.add(project.id);
      for (const item of project.items) {
        totalItems += 1;
        totalQuantity += item.quantity;
        if (item.status === "overdue") overdue += 1;
        if (item.status === "due_today") dueToday += 1;
      }
    }
    return {
      totalItems,
      totalQuantity,
      projectCount: projectIds.size,
      overdue,
      dueToday,
    };
  }, []);

  if (mainView !== "werkstatt" || werkstattTab !== "on_site") return null;

  const de = language === "de";

  function toggleProject(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function returnItem(project: OnSiteProject, item: OnSiteItem): void {
    setNotice(
      de
        ? `${item.quantity}× ${item.article_name} zurückgegeben von ${project.project_number} (API folgt)`
        : `Returned ${item.quantity}× ${item.article_name} from ${project.project_number} (API pending)`,
    );
    // TODO(werkstatt): POST /api/werkstatt/mobile/return
    //   { article_id, quantity: item.quantity, condition: "ok", notes: null }
  }

  function remindAssignee(project: OnSiteProject, item: OnSiteItem): void {
    setNotice(
      de
        ? `Erinnerung an ${item.assignee_name} gesendet · ${item.article_name}`
        : `Reminder sent to ${item.assignee_name} · ${item.article_name}`,
    );
    // TODO(werkstatt): POST /api/werkstatt/mobile/remind once endpoint lands.
  }

  const anyOverdue = totals.overdue > 0;

  return (
    <section className="werkstatt-tab-page werkstatt-onsite-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › AUF BAUSTELLE" : "WORKSHOP › ON SITE"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Auf Baustelle — alle Projekte" : "On site — all projects"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? `${totals.totalItems} Artikel bei ${totals.projectCount} Projekten`
              : `${totals.totalItems} items at ${totals.projectCount} projects`}
            {anyOverdue && (
              <>
                {" · "}
                <span className="werkstatt-onsite-subtitle-danger">
                  {totals.overdue} {de ? "überfällig" : "overdue"}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={!anyOverdue}
            onClick={() =>
              setNotice(
                de
                  ? `${totals.overdue} Erinnerung(en) an überfällige Mitarbeiter gesendet (API folgt)`
                  : `${totals.overdue} reminder(s) sent to overdue assignees (API pending)`,
              )
            }
          >
            {de ? "Alle überfälligen mahnen" : "Remind all overdue"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            onClick={() =>
              setNotice(
                de
                  ? "Neue Entnahme – Dialog folgt (API vorhanden: POST /api/werkstatt/mobile/checkout)"
                  : "New checkout dialog coming soon (endpoint ready)",
              )
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {de ? "Neue Entnahme" : "New checkout"}
          </button>
        </div>
      </header>

      {/* KPI strip */}
      <div className="werkstatt-kpi-strip werkstatt-onsite-kpi-strip">
        <div className="werkstatt-kpi werkstatt-kpi--info">
          <span className="werkstatt-kpi-label">
            {de ? "AUSGEGEBEN" : "CHECKED OUT"}
          </span>
          <div className="werkstatt-kpi-row">
            <span className="werkstatt-kpi-value">{totals.totalItems}</span>
            <span className="werkstatt-kpi-subtitle">
              {de ? "Positionen" : "line items"}
            </span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--neutral">
          <span className="werkstatt-kpi-label">
            {de ? "AUF PROJEKTEN" : "AT PROJECTS"}
          </span>
          <div className="werkstatt-kpi-row">
            <span className="werkstatt-kpi-value">{totals.projectCount}</span>
            <span className="werkstatt-kpi-subtitle">
              {de ? "Baustellen aktiv" : "sites active"}
            </span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--warning">
          <span className="werkstatt-kpi-label">
            {de ? "HEUTE ZURÜCK" : "DUE TODAY"}
          </span>
          <div className="werkstatt-kpi-row">
            <span className="werkstatt-kpi-value">{totals.dueToday}</span>
            <span className="werkstatt-kpi-subtitle">
              {de ? "Positionen" : "line items"}
            </span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--danger">
          <span className="werkstatt-kpi-label">{de ? "ÜBERFÄLLIG" : "OVERDUE"}</span>
          <div className="werkstatt-kpi-row">
            <span className="werkstatt-kpi-value">{totals.overdue}</span>
            <span className="werkstatt-kpi-subtitle">
              {de ? "nachfragen" : "to chase"}
            </span>
          </div>
        </div>
      </div>

      {/* Filter + search */}
      <div className="werkstatt-filter-bar werkstatt-filter-bar--slim">
        <div className="werkstatt-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              de
                ? "Projekt, Artikel oder Person suchen…"
                : "Search project, article or person…"
            }
          />
        </div>
        <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
          {FILTERS.map((def) => (
            <button
              key={def.key}
              type="button"
              role="tab"
              aria-selected={activeFilter === def.key}
              className={`werkstatt-segmented-btn${activeFilter === def.key ? " werkstatt-segmented-btn--active" : ""}`}
              onClick={() => setActiveFilter(def.key)}
            >
              {de ? def.label_de : def.label_en}
            </button>
          ))}
        </div>
      </div>

      {/* Project groups */}
      <div className="werkstatt-onsite-groups">
        {filteredProjects.map((project) => {
          const isCollapsed = collapsed.has(project.id);
          const groupOverdue = project.items.filter((i) => i.status === "overdue").length;
          return (
            <article
              key={project.id}
              className={`werkstatt-onsite-group${isCollapsed ? " werkstatt-onsite-group--collapsed" : ""}`}
            >
              <header className="werkstatt-onsite-group-head">
                <button
                  type="button"
                  className="werkstatt-onsite-group-toggle"
                  onClick={() => toggleProject(project.id)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="werkstatt-onsite-caret" aria-hidden="true">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <div className="werkstatt-onsite-group-identity">
                    <div className="werkstatt-onsite-group-title-row">
                      <span className="werkstatt-onsite-project-number">
                        {project.project_number}
                      </span>
                      <span className="werkstatt-onsite-project-title">
                        {project.project_title}
                      </span>
                    </div>
                    <p className="werkstatt-onsite-group-meta">
                      {project.customer_short} · {project.site_city} · {project.items.length}{" "}
                      {de ? "Artikel" : "items"}
                      {groupOverdue > 0 && (
                        <>
                          {" · "}
                          <span className="werkstatt-onsite-group-overdue">
                            {groupOverdue} {de ? "überfällig" : "overdue"}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                </button>
                {groupOverdue > 0 && (
                  <button
                    type="button"
                    className="werkstatt-action-btn werkstatt-action-btn--warn"
                    onClick={() =>
                      setNotice(
                        de
                          ? `Erinnerung an ${groupOverdue} Mitarbeiter von ${project.project_number} gesendet`
                          : `Reminder sent to ${groupOverdue} assignees on ${project.project_number}`,
                      )
                    }
                  >
                    {de ? "Team mahnen" : "Remind team"}
                  </button>
                )}
              </header>

              {!isCollapsed && (
                <ul className="werkstatt-onsite-items">
                  {project.items.map((item) => (
                    <li key={item.id} className="werkstatt-onsite-item">
                      <div className="werkstatt-onsite-item-icon" aria-hidden="true">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
                            stroke="#5C7895"
                            strokeWidth="1.6"
                            strokeLinejoin="round"
                          />
                          <path d="M3 7.5 12 12l9-4.5M12 12v9" stroke="#5C7895" strokeWidth="1.6" />
                        </svg>
                      </div>
                      <div className="werkstatt-onsite-item-main">
                        <div className="werkstatt-onsite-item-title">
                          {item.article_name}
                        </div>
                        <div className="werkstatt-onsite-item-meta">
                          <span className="werkstatt-onsite-item-sp">{item.article_no}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {item.quantity}× {de ? item.checked_out_label_de : item.checked_out_label_en}
                          </span>
                        </div>
                      </div>
                      <div className="werkstatt-onsite-item-assignee">
                        <span className="werkstatt-initials" aria-hidden="true">
                          {item.assignee_initials}
                        </span>
                        <span className="werkstatt-onsite-assignee-name">
                          {item.assignee_name}
                        </span>
                      </div>
                      <div className={statusClass(item.status)}>
                        {item.status === "overdue" && (
                          <span className="werkstatt-onsite-return-dot" aria-hidden="true" />
                        )}
                        <span>
                          {de ? item.expected_return_label_de : item.expected_return_label_en}
                        </span>
                      </div>
                      <div className="werkstatt-onsite-item-actions">
                        {item.status === "overdue" && (
                          <button
                            type="button"
                            className="werkstatt-action-btn werkstatt-action-btn--warn werkstatt-action-btn--small"
                            onClick={() => remindAssignee(project, item)}
                            title={de ? "Mitarbeiter erinnern" : "Remind assignee"}
                          >
                            {de ? "Mahnen" : "Remind"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="werkstatt-action-btn werkstatt-action-btn--small"
                          onClick={() => returnItem(project, item)}
                          title={de ? "Als zurückgegeben markieren" : "Mark as returned"}
                        >
                          ↩ {de ? "Zurück" : "Return"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}

        {filteredProjects.length === 0 && (
          <div className="werkstatt-card werkstatt-onsite-empty muted">
            {de
              ? "Keine Artikel für die aktuelle Auswahl."
              : "No items match the current filter."}
          </div>
        )}
      </div>
    </section>
  );
}
