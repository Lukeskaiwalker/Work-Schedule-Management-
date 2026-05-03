import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { CustomerContactCard } from "../components/customers/CustomerContactCard";
import { CustomerProjectRow } from "../components/customers/CustomerProjectRow";
import { CustomerTasksCard } from "../components/customers/CustomerTasksCard";
import {
  getCustomer,
  listCustomerProjects,
  type CustomerProjectSummary,
} from "../utils/customersApi";
import type { CustomerListItem } from "../types";

type ProjectTab = "active" | "completed" | "archived";

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

/**
 * Customer detail page. Self-gates on `mainView !== "customer_detail"`.
 * Loads its own detail + linked-projects data on mount / when the active
 * customer id changes. Uses context for navigation out (project open +
 * create-project-for-customer).
 */
export function CustomerDetailPage() {
  const {
    mainView,
    language,
    activeCustomerId,
    setMainView,
    openCustomerModal,
    archiveCustomer,
    unarchiveCustomer,
    openProjectById,
    openCreateProjectModal,
    setProjectForm,
    customers,
    token,
  } = useAppContext();

  const [customer, setCustomer] = useState<CustomerListItem | null>(null);
  const [projects, setProjects] = useState<CustomerProjectSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [projectTab, setProjectTab] = useState<ProjectTab>("active");

  useEffect(() => {
    if (mainView !== "customer_detail" || !activeCustomerId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getCustomer(token, activeCustomerId),
      listCustomerProjects(token, activeCustomerId),
    ])
      .then(([detail, rows]) => {
        if (cancelled) return;
        setCustomer(detail);
        setProjects(rows);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mainView, activeCustomerId, customers, token]);

  const active = useMemo(
    () => projects.filter((p) => isActiveStatus(p.status)),
    [projects],
  );
  const completed = useMemo(
    () => projects.filter((p) => isCompletedStatus(p.status)),
    [projects],
  );
  const archived = useMemo(
    () => projects.filter((p) => isArchivedStatus(p.status)),
    [projects],
  );

  if (mainView !== "customer_detail") return null;

  const de = language === "de";

  if (!activeCustomerId || !customer) {
    return (
      <section className="customer-detail-page">
        <div className="customers-empty muted">
          {loading
            ? de
              ? "Lädt…"
              : "Loading…"
            : de
              ? "Kein Kunde ausgewählt."
              : "No customer selected."}
        </div>
      </section>
    );
  }

  const isArchived = Boolean(customer.archived_at);
  const shownProjects =
    projectTab === "active"
      ? active
      : projectTab === "completed"
        ? completed
        : archived;

  function handleNewProjectForCustomer() {
    // Open the project create modal and pre-fill the customer link + the
    // snapshot fields (name/address/contact) from the Stammdaten so the
    // user sees a ready-to-save record.
    if (!customer) return;
    openCreateProjectModal();
    setProjectForm((current) => ({
      ...current,
      customer_id: customer.id,
      customer_name: customer.name,
      customer_address: customer.address ?? "",
      customer_contact: customer.contact_person ?? "",
      customer_email: customer.email ?? "",
      customer_phone: customer.phone ?? "",
      use_separate_site_address: false,
      construction_site_address: "",
    }));
  }

  function handleOpenProject(projectId: number) {
    openProjectById(projectId, "customer_detail");
  }

  return (
    <section className="customer-detail-page">
      <header className="customer-detail-head">
        <button
          type="button"
          className="customer-detail-back"
          onClick={() => setMainView("customers")}
        >
          ← {de ? "Alle Kunden" : "All customers"}
        </button>
        <div className="customer-detail-title-block">
          <span className="customer-detail-eyebrow">
            {de ? "KUNDE" : "CUSTOMER"}
          </span>
          <h2 className="customer-detail-title">{customer.name}</h2>
          {customer.address && (
            <span className="customer-detail-subtitle muted">
              {customer.address}
            </span>
          )}
        </div>
        <div className="customer-detail-actions">
          <button
            type="button"
            className="customers-action-btn"
            onClick={() => openCustomerModal({ initial: customer })}
          >
            {de ? "Bearbeiten" : "Edit"}
          </button>
          <button
            type="button"
            className="customers-action-btn"
            onClick={() => {
              if (isArchived) void unarchiveCustomer(customer.id);
              else void archiveCustomer(customer.id);
            }}
          >
            {isArchived
              ? de
                ? "Wiederherstellen"
                : "Unarchive"
              : de
                ? "Archivieren"
                : "Archive"}
          </button>
          <button
            type="button"
            className="customers-action-btn customers-action-btn--primary"
            onClick={handleNewProjectForCustomer}
          >
            + {de ? "Neues Projekt" : "New project"}
          </button>
        </div>
      </header>

      <div className="customer-detail-grid">
        <div className="customer-detail-col customer-detail-col--left">
          <CustomerContactCard
            customer={customer}
            language={language === "de" ? "de" : "en"}
          />

          <section className="customer-notes-card">
            <header className="customer-contact-card-head">
              <h3 className="customer-contact-card-title">
                {de ? "Notizen" : "Notes"}
              </h3>
            </header>
            <div className="customer-notes-body">
              {customer.notes ? (
                customer.notes
              ) : (
                <span className="muted">
                  {de ? "Keine Notizen." : "No notes yet."}
                </span>
              )}
            </div>
          </section>

          {/* Customer-anchored tasks (v2.4.5+) — call-back reminders,
              follow-ups, and other todo items that aren't tied to a
              specific project. Lives on the left column to keep the
              project list (right column) uncluttered. */}
          <CustomerTasksCard customerId={customer.id} />
        </div>

        <div className="customer-detail-col customer-detail-col--right">
          <section className="customer-projects-card">
            <header className="customer-contact-card-head">
              <h3 className="customer-contact-card-title">
                {de ? "Projekte" : "Projects"}{" "}
                <span className="customer-projects-count muted">
                  ({projects.length})
                </span>
              </h3>
            </header>
            <div
              className="customer-projects-tabs"
              role="tablist"
              aria-label={de ? "Projektfilter" : "Project filter"}
            >
              {(
                [
                  {
                    key: "active" as const,
                    labelDe: "Aktiv",
                    labelEn: "Active",
                    count: active.length,
                  },
                  {
                    key: "completed" as const,
                    labelDe: "Abgeschlossen",
                    labelEn: "Completed",
                    count: completed.length,
                  },
                  {
                    key: "archived" as const,
                    labelDe: "Archiviert",
                    labelEn: "Archived",
                    count: archived.length,
                  },
                ]
              ).map((tab) => (
                <button
                  key={`customer-projects-tab-${tab.key}`}
                  type="button"
                  role="tab"
                  aria-selected={projectTab === tab.key}
                  className={
                    projectTab === tab.key
                      ? "customer-projects-tab customer-projects-tab--active"
                      : "customer-projects-tab"
                  }
                  onClick={() => setProjectTab(tab.key)}
                >
                  {de ? tab.labelDe : tab.labelEn}
                  <span className="customer-projects-tab-count">{tab.count}</span>
                </button>
              ))}
            </div>
            <div className="customer-projects-list">
              {shownProjects.length === 0 ? (
                <div className="customers-empty muted">
                  {de ? "Keine Projekte." : "No projects."}
                </div>
              ) : (
                shownProjects.map((project) => (
                  <CustomerProjectRow
                    key={`customer-project-${project.id}`}
                    project={project}
                    language={language === "de" ? "de" : "en"}
                    onOpen={handleOpenProject}
                  />
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
