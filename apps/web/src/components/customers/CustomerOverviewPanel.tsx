/**
 * Übersicht on the customer page: what you look at first. Kontaktdaten, the
 * Kundenbesuche and the note feed on the left, the projects with their
 * Aktiv/Abgeschlossen/Archiviert switch on the right — the top of the old
 * one-long-scroll page, and nothing below it. Everything that used to
 * follow has a tab of its own now.
 *
 * The feeds on the left are keyed by the customer: a switch to another
 * customer starts them afresh instead of carrying a half-written entry
 * over. The visit card gets the projects so a visit can be linked to one.
 */
import { CustomerContactCard } from "./CustomerContactCard";
import { CustomerVisitCard } from "./CustomerVisitCard";
import { CustomerNotesCard } from "./CustomerNotesCard";
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
  return (
    <div className="customer-detail-grid">
      <div className="customer-detail-col customer-detail-col--left">
        <CustomerContactCard customer={customer} language={language} />
        <CustomerVisitCard
          key={`visit-${customer.id}`}
          customerId={customer.id}
          projects={projects}
          language={language}
        />
        <CustomerNotesCard key={`notes-${customer.id}`} customerId={customer.id} />
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
