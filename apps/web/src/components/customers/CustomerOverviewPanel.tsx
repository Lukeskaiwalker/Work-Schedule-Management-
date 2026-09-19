/**
 * Übersicht on the customer page: what you look at first. Kontaktdaten and
 * Notizen on the left, the projects with their Aktiv/Abgeschlossen/Archiviert
 * switch on the right — the top of the old one-long-scroll page, and nothing
 * below it. Everything that used to follow has a tab of its own now.
 */
import { CustomerContactCard } from "./CustomerContactCard";
import { CustomerProjectsCard, type CustomerProjectFilter } from "./CustomerProjectsCard";
import type { CustomerProjectSummary } from "../../utils/customersApi";
import type { CustomerListItem } from "../../types";

type Props = {
  customer: CustomerListItem;
  projects: CustomerProjectSummary[];
  projectFilter: CustomerProjectFilter;
  onProjectFilterChange: (filter: CustomerProjectFilter) => void;
  language: "de" | "en";
  onOpenProject: (projectId: number) => void;
};

export function CustomerOverviewPanel({
  customer,
  projects,
  projectFilter,
  onProjectFilterChange,
  language,
  onOpenProject,
}: Props) {
  const de = language === "de";

  return (
    <div className="customer-detail-grid">
      <div className="customer-detail-col customer-detail-col--left">
        <CustomerContactCard customer={customer} language={language} />

        <section className="customer-notes-card">
          <header className="customer-contact-card-head">
            <h3 className="customer-contact-card-title">{de ? "Notizen" : "Notes"}</h3>
          </header>
          <div className="customer-notes-body">
            {customer.notes ? (
              customer.notes
            ) : (
              <span className="muted">{de ? "Keine Notizen." : "No notes yet."}</span>
            )}
          </div>
        </section>
      </div>

      <div className="customer-detail-col customer-detail-col--right">
        <CustomerProjectsCard
          projects={projects}
          filter={projectFilter}
          onFilterChange={onProjectFilterChange}
          language={language}
          onOpen={onOpenProject}
        />
      </div>
    </div>
  );
}
