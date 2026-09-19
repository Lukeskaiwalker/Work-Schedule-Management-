/**
 * "Projekte" on the customer page: the customer's projects behind an
 * Aktiv / Abgeschlossen / Archiviert switch.
 *
 * Which of the three a project belongs to is read off its status here.
 * The switch's position belongs to the page, not the card: the card is
 * unmounted with the overview when another tab opens, and a reader who
 * was on Abgeschlossen expects to find it there on the way back.
 */
import { CustomerProjectRow } from "./CustomerProjectRow";
import type { CustomerProjectSummary } from "../../utils/customersApi";

export type CustomerProjectFilter = "active" | "completed" | "archived";

function isActiveStatus(status: string): boolean {
  const s = status.toLowerCase();
  return !(
    s === "completed" ||
    s === "done" ||
    s === "archived" ||
    s === "on_hold" ||
    s === "hold"
  );
}

function isCompletedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "completed" || s === "done";
}

function isArchivedStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "archived";
}

type Props = {
  projects: CustomerProjectSummary[];
  filter: CustomerProjectFilter;
  onFilterChange: (filter: CustomerProjectFilter) => void;
  language: "de" | "en";
  onOpen: (projectId: number) => void;
};

export function CustomerProjectsCard({ projects, filter, onFilterChange, language, onOpen }: Props) {
  const de = language === "de";

  const active = projects.filter((p) => isActiveStatus(p.status));
  const completed = projects.filter((p) => isCompletedStatus(p.status));
  const archived = projects.filter((p) => isArchivedStatus(p.status));
  const shown = filter === "active" ? active : filter === "completed" ? completed : archived;

  const tabs = [
    { key: "active" as const, label: de ? "Aktiv" : "Active", count: active.length },
    { key: "completed" as const, label: de ? "Abgeschlossen" : "Completed", count: completed.length },
    { key: "archived" as const, label: de ? "Archiviert" : "Archived", count: archived.length },
  ];

  return (
    <section className="customer-projects-card">
      <header className="customer-contact-card-head">
        <h3 className="customer-contact-card-title">
          {de ? "Projekte" : "Projects"}{" "}
          <span className="customer-projects-count muted">({projects.length})</span>
        </h3>
      </header>
      <div
        className="customer-projects-tabs"
        role="tablist"
        aria-label={de ? "Projektfilter" : "Project filter"}
      >
        {tabs.map((tab) => (
          <button
            key={`customer-projects-tab-${tab.key}`}
            type="button"
            role="tab"
            aria-selected={filter === tab.key}
            className={
              filter === tab.key
                ? "customer-projects-tab customer-projects-tab--active"
                : "customer-projects-tab"
            }
            onClick={() => onFilterChange(tab.key)}
          >
            {tab.label}
            <span className="customer-projects-tab-count">{tab.count}</span>
          </button>
        ))}
      </div>
      <div className="customer-projects-list">
        {shown.length === 0 ? (
          <div className="customers-empty muted">{de ? "Keine Projekte." : "No projects."}</div>
        ) : (
          shown.map((project) => (
            <CustomerProjectRow
              key={`customer-project-${project.id}`}
              project={project}
              language={language}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </section>
  );
}
