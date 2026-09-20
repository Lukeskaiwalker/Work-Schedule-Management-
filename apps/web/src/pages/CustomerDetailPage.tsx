import { useEffect, useState } from "react";
import { useAppContext } from "../context/AppContext";
import {
  CustomerDetailTabPanel,
  CustomerDetailTabs,
  readStoredCustomerTab,
  storeCustomerTab,
  type CustomerDetailTab,
} from "../components/customers/CustomerDetailTabs";
import { CustomerOverviewPanel } from "../components/customers/CustomerOverviewPanel";
import type { CustomerProjectFilter } from "../components/customers/CustomerProjectsCard";
import { CustomerTasksCard } from "../components/customers/CustomerTasksCard";
import { CustomerReportsCard } from "../components/customers/CustomerReportsCard";
import { CustomerBoxesCard } from "../components/customers/CustomerBoxesCard";
import { CustomerActivityCard } from "../components/customers/CustomerActivityCard";
import { CustomerFilesCard } from "../components/customers/CustomerFilesCard";
import {
  getCustomer,
  listCustomerProjects,
  type CustomerProjectSummary,
} from "../utils/customersApi";
import type { CustomerListItem } from "../types";
import "../styles/customer-detail.css";

/**
 * Customer detail page. Self-gates on `mainView !== "customer_detail"`.
 * Loads its own detail + linked-projects data on mount / when the active
 * customer id changes. Uses context for navigation out (project open +
 * create-project-for-customer).
 *
 * Under the header a tab strip — Übersicht · Aufgaben · Berichte & Kisten ·
 * Dateien · Änderungen — and only the chosen panel is mounted. Every card
 * fetches on mount, so the overview no longer pays for the tasks, reports,
 * boxes and change log, and Dateien is one click away instead of a scroll
 * past all of them. The tab is the page's own state: a "Zum Kunden" jump
 * from a project and `openProjectById` back only set mainView.
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
  const [projectFilter, setProjectFilter] = useState<CustomerProjectFilter>("active");
  // Read once, before the first paint: the remembered tab is rendered from
  // the start, not after a flash of the overview.
  const [tab, setTab] = useState<CustomerDetailTab>(readStoredCustomerTab);

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

  // Another customer keeps the remembered tab — a reader comparing two
  // customers' files wants Dateien on both — and starts on Übersicht only
  // when nothing is remembered.
  useEffect(() => {
    setTab(readStoredCustomerTab());
  }, [activeCustomerId]);

  if (mainView !== "customer_detail") return null;

  const de = language === "de";
  const lang = de ? "de" : "en";

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

  function selectTab(next: CustomerDetailTab) {
    setTab(next);
    storeCustomerTab(next);
  }

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

      <CustomerDetailTabs active={tab} onChange={selectTab} language={lang} />

      {/* Every card is keyed by the customer so a switch to another customer
          starts it afresh instead of paging on from the old one. */}
      <CustomerDetailTabPanel tab={tab}>
        {tab === "overview" && (
          <CustomerOverviewPanel
            customer={customer}
            projects={projects}
            projectFilter={projectFilter}
            onProjectFilterChange={setProjectFilter}
            language={lang}
            onOpenProject={handleOpenProject}
          />
        )}
        {/* Customer-anchored tasks (v2.4.5+) — call-back reminders,
            follow-ups, and other todo items that aren't tied to a
            specific project. */}
        {tab === "tasks" && <CustomerTasksCard key={customer.id} customerId={customer.id} />}
        {tab === "reports" && (
          <>
            <CustomerReportsCard key={`reports-${customer.id}`} customerId={customer.id} />
            <CustomerBoxesCard key={`boxes-${customer.id}`} customerId={customer.id} />
          </>
        )}
        {/* The customer's folder — with every project folder that lands in
            it. The file browser needs the full width for its rows; on a
            tablet beside the sidebar a column would clip it. */}
        {tab === "files" && <CustomerFilesCard key={customer.id} customerId={customer.id} />}
        {/* The change log across all of this customer's projects — what
            every project overview shows for itself, merged. */}
        {tab === "activity" && (
          <CustomerActivityCard key={customer.id} customerId={customer.id} />
        )}
      </CustomerDetailTabPanel>
    </section>
  );
}
