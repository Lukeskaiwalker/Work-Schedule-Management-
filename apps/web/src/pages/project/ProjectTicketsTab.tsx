import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAppContext } from "../../context/AppContext";
import type { Ticket, TicketChecklistItem, TicketStatus } from "../../types";

type TicketFilter = "all" | TicketStatus;

type StepperStep = {
  key: TicketStatus | "created" | "approved";
  label: string;
};

function ticketStatusMeta(status: TicketStatus | undefined, language: "de" | "en") {
  const normalized: TicketStatus = status ?? "open";
  if (normalized === "in_review") {
    return {
      key: normalized,
      label: language === "de" ? "In Prüfung" : "In review",
      className: "ticket-status-pill ticket-status-pill--review",
    };
  }
  if (normalized === "closed") {
    return {
      key: normalized,
      label: language === "de" ? "Geschlossen" : "Closed",
      className: "ticket-status-pill ticket-status-pill--closed",
    };
  }
  return {
    key: normalized,
    label: language === "de" ? "Offen" : "Open",
    className: "ticket-status-pill ticket-status-pill--open",
  };
}

function formatTicketReference(ticket: Ticket, activeProjectNumber: string | null): string {
  if (ticket.reference && ticket.reference.trim().length > 0) return ticket.reference;
  const projectPart = activeProjectNumber ?? "000";
  const suffix = String(ticket.id).padStart(2, "0");
  return `JT-${projectPart}-${suffix}`;
}

function formatTicketDate(dateIso: string, language: "de" | "en"): string {
  if (!dateIso) return "—";
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return dateIso;
  const locale = language === "de" ? "de-DE" : "en-US";
  return date.toLocaleDateString(locale, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const first = parts[0] ?? "";
    return first.slice(0, 2).toUpperCase();
  }
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

function getStepperSteps(language: "de" | "en"): StepperStep[] {
  return [
    { key: "created", label: language === "de" ? "Erstellt" : "Created" },
    { key: "open", label: language === "de" ? "Offen" : "Open" },
    { key: "in_review", label: language === "de" ? "In Prüfung" : "In review" },
    { key: "approved", label: language === "de" ? "Genehmigt" : "Approved" },
    { key: "closed", label: language === "de" ? "Geschlossen" : "Closed" },
  ];
}

function stepIndexForStatus(status: TicketStatus | undefined): number {
  if (status === "in_review") return 2;
  if (status === "closed") return 4;
  return 1; // "open" or undefined → "Open" step
}

function nextStatusFor(status: TicketStatus | undefined): TicketStatus | null {
  const current = status ?? "open";
  if (current === "open") return "in_review";
  if (current === "in_review") return "closed";
  return null;
}

function nextStatusLabel(status: TicketStatus | undefined, language: "de" | "en"): string | null {
  const next = nextStatusFor(status);
  if (next === null) return null;
  if (next === "in_review") return language === "de" ? "In Prüfung markieren" : "Mark in review";
  if (next === "closed") return language === "de" ? "Ticket schließen" : "Close ticket";
  return null;
}

type ActivityKind = "created" | "note" | "upload" | "status";

type ActivityItem = {
  id: string;
  author: string;
  kind: ActivityKind;
  timestamp: string;
  body?: string;
};

function mockActivityForTicket(ticket: Ticket): ActivityItem[] {
  const createdAt = `${ticket.ticket_date ?? ""} · 07:02`.trim();
  const noteAt = `${ticket.ticket_date ?? ""} · 09:14`.trim();
  const uploadAt = `${ticket.ticket_date ?? ""} · 11:47`.trim();
  return [
    { id: `activity-${ticket.id}-created`, author: "Max Maier", kind: "created", timestamp: createdAt },
    {
      id: `activity-${ticket.id}-note`,
      author: "Luca Schmidt",
      kind: "note",
      timestamp: noteAt,
      body:
        ticket.notes?.trim().length
          ? ticket.notes
          : "Old shower tray cracked — will need extra time for safe removal. Ordered skip bin for 12:00.",
    },
    {
      id: `activity-${ticket.id}-upload`,
      author: "Max Maier",
      kind: "upload",
      timestamp: uploadAt,
    },
  ];
}

export function ProjectTicketsTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    activeProjectId,
    language,
    tickets,
    setTickets,
    activeProjectTicketAddress,
    activeProjectTicketDate,
    createTicket,
    canCreateProject,
  } = useAppContext();

  const [filter, setFilter] = useState<TicketFilter>("all");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [activeTicketId, setActiveTicketId] = useState<number | null>(null);
  const [commentDraft, setCommentDraft] = useState("");

  const projectNumber = useMemo(() => {
    if (!activeProject) return null;
    const number = (activeProject as { project_number?: string }).project_number;
    if (number && number.length > 0) return number;
    return String(activeProject.id).padStart(3, "0");
  }, [activeProject]);

  const activeTicket = useMemo(
    () => tickets.find((ticket) => ticket.id === activeTicketId) ?? null,
    [tickets, activeTicketId],
  );

  const filteredTickets = useMemo(() => {
    if (filter === "all") return tickets;
    return tickets.filter((ticket) => (ticket.status ?? "open") === filter);
  }, [tickets, filter]);

  // Reset comment draft when switching ticket
  useEffect(() => {
    setCommentDraft("");
  }, [activeTicketId]);

  if (mainView !== "project" || !activeProject || projectTab !== "tickets") return null;

  const de = language === "de";

  // ── Detail view ────────────────────────────────────────────────────────────
  if (activeTicket) {
    return (
      <TicketDetailView
        ticket={activeTicket}
        projectNumber={projectNumber}
        language={language}
        commentDraft={commentDraft}
        setCommentDraft={setCommentDraft}
        onBack={() => setActiveTicketId(null)}
        onChecklistToggle={(index) => {
          const nextTickets = tickets.map((ticket: Ticket) => {
            if (ticket.id !== activeTicket.id) return ticket;
            const currentChecklist = ticket.checklist ?? [];
            const updated = currentChecklist.map((item: TicketChecklistItem, idx: number) =>
              idx === index ? { ...item, done: !item.done } : item,
            );
            return { ...ticket, checklist: updated };
          });
          setTickets(nextTickets);
        }}
        onAdvanceStatus={() => {
          const next = nextStatusFor(activeTicket.status);
          if (!next) return;
          const nextTickets = tickets.map((ticket: Ticket) =>
            ticket.id === activeTicket.id ? { ...ticket, status: next } : ticket,
          );
          setTickets(nextTickets);
        }}
        printUrl={
          activeProjectId
            ? `/api/projects/${activeProjectId}/job-tickets/${activeTicket.id}/print`
            : "#"
        }
      />
    );
  }

  // ── List view ──────────────────────────────────────────────────────────────
  const filterOptions: { value: TicketFilter; label: string }[] = [
    { value: "all", label: de ? "Alle Tickets" : "All tickets" },
    { value: "open", label: de ? "Offen" : "Open" },
    { value: "in_review", label: de ? "In Prüfung" : "In review" },
    { value: "closed", label: de ? "Geschlossen" : "Closed" },
  ];

  return (
    <section className="tickets-tab">
      <div className="tickets-tab-head">
        <div
          className="tickets-tab-filter-group"
          role="tablist"
          aria-label={de ? "Ticket-Filter" : "Ticket filter"}
        >
          {filterOptions.map((option) => (
            <button
              key={`ticket-filter-${option.value}`}
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              className={`tickets-tab-filter${filter === option.value ? " tickets-tab-filter--active" : ""}`}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="tickets-tab-meta">
          <span className="tickets-tab-count">
            {de
              ? `${filteredTickets.length} ${filteredTickets.length === 1 ? "Ticket" : "Tickets"}`
              : `${filteredTickets.length} ${filteredTickets.length === 1 ? "ticket" : "tickets"}`}
          </span>
          {canCreateProject && (
            <button
              type="button"
              className="tickets-tab-new-btn"
              onClick={() => setCreatorOpen((open) => !open)}
            >
              + {de ? "Neues Ticket" : "New ticket"}
            </button>
          )}
        </div>
      </div>

      {creatorOpen && (
        <TicketCreatorForm
          language={language}
          onSubmit={async (event) => {
            await createTicket(event);
            setCreatorOpen(false);
          }}
          onCancel={() => setCreatorOpen(false)}
          address={activeProjectTicketAddress}
          date={activeProjectTicketDate}
        />
      )}

      <div className="tickets-tab-list">
        {filteredTickets.length === 0 && (
          <div className="tickets-tab-empty muted">
            {de ? "Keine Tickets in diesem Filter." : "No tickets in this filter."}
          </div>
        )}
        {filteredTickets.map((ticket) => {
          const statusMeta = ticketStatusMeta(ticket.status, language);
          const reference = formatTicketReference(ticket, projectNumber);
          const crewList = ticket.assigned_crew ?? [];
          const crewLabel =
            crewList.length > 0
              ? `${de ? "Team" : "Crew"}: ${crewList.join(", ")}`
              : `${de ? "Team" : "Crew"}: —`;
          const dateLabel = `${de ? "Datum" : "Date"}: ${formatTicketDate(ticket.ticket_date, language)}`;
          const attachmentsCount = ticket.attachments_count ?? 0;
          const attachmentsLabel = de
            ? `${attachmentsCount} ${attachmentsCount === 1 ? "Anhang" : "Anhänge"}`
            : `${attachmentsCount} ${attachmentsCount === 1 ? "attachment" : "attachments"}`;
          const isClosed = statusMeta.key === "closed";
          return (
            <article
              key={`ticket-${ticket.id}`}
              className={`ticket-row${isClosed ? " ticket-row--closed" : ""}`}
            >
              <div className="ticket-row-id-col">
                <span className="ticket-reference">{reference}</span>
                <span className={statusMeta.className}>
                  <span aria-hidden="true" className="ticket-status-dot" />
                  {statusMeta.label}
                </span>
              </div>
              <div className="ticket-row-main">
                <h4 className="ticket-row-title">{ticket.title}</h4>
                <p className="ticket-row-meta">
                  <span>{crewLabel}</span>
                  <span aria-hidden="true"> · </span>
                  <span>{dateLabel}</span>
                  <span aria-hidden="true"> · </span>
                  <span>{attachmentsLabel}</span>
                </p>
              </div>
              <div className="ticket-row-actions">
                <button
                  type="button"
                  className="ticket-row-btn"
                  onClick={() => setActiveTicketId(ticket.id)}
                >
                  {de ? "Öffnen" : "Open"}
                </button>
                <a
                  className="ticket-row-btn"
                  target="_blank"
                  rel="noreferrer"
                  href={`/api/projects/${activeProjectId}/job-tickets/${ticket.id}/print`}
                >
                  {de ? "Drucken" : "Print"}
                </a>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ── Creator form ─────────────────────────────────────────────────────────────
function TicketCreatorForm(props: {
  language: "de" | "en";
  address: string;
  date: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  onCancel: () => void;
}) {
  const de = props.language === "de";
  return (
    <form
      className="tickets-tab-creator"
      onSubmit={(event) => {
        void props.onSubmit(event);
      }}
    >
      <h4>{de ? "Neues Job Ticket" : "New job ticket"}</h4>
      <div className="row">
        <label className="tickets-tab-creator-field">
          <span>{de ? "Titel" : "Title"}</span>
          <input name="title" required placeholder={de ? "Titel eingeben" : "Enter title"} />
        </label>
        <label className="tickets-tab-creator-field">
          <span>{de ? "Team (kommagetrennt)" : "Crew (comma separated)"}</span>
          <input name="assigned_crew" placeholder={de ? "z. B. Max, Luca" : "e.g. Max, Luca"} />
        </label>
      </div>
      <label className="tickets-tab-creator-field">
        <span>{de ? "Notizen" : "Notes"}</span>
        <textarea name="notes" rows={3} />
      </label>
      <small className="muted">
        {de ? "Adresse" : "Address"}: <b>{props.address}</b> · {de ? "Datum" : "Date"}: <b>{props.date}</b>
      </small>
      <div className="row">
        <button type="submit" className="tickets-tab-creator-save">
          {de ? "Ticket speichern" : "Save ticket"}
        </button>
        <button type="button" className="tickets-tab-creator-cancel" onClick={props.onCancel}>
          {de ? "Abbrechen" : "Cancel"}
        </button>
      </div>
    </form>
  );
}

// ── Detail view ──────────────────────────────────────────────────────────────
type TicketDetailViewProps = {
  ticket: Ticket;
  projectNumber: string | null;
  language: "de" | "en";
  commentDraft: string;
  setCommentDraft: (value: string) => void;
  onBack: () => void;
  onChecklistToggle: (index: number) => void;
  onAdvanceStatus: () => void;
  printUrl: string;
};

function TicketDetailView(props: TicketDetailViewProps) {
  const { ticket, projectNumber, language, commentDraft, setCommentDraft } = props;
  const de = language === "de";
  const reference = formatTicketReference(ticket, projectNumber);
  const statusMeta = ticketStatusMeta(ticket.status, language);
  const steps = getStepperSteps(language);
  const currentStepIndex = stepIndexForStatus(ticket.status);
  const checklist: TicketChecklistItem[] = ticket.checklist ?? [];
  const crewList = ticket.assigned_crew ?? [];
  const activity = mockActivityForTicket(ticket);
  const advanceLabel = nextStatusLabel(ticket.status, language);

  return (
    <section className="ticket-detail">
      <div className="ticket-detail-breadcrumb">
        <button type="button" className="ticket-detail-back-btn" onClick={props.onBack}>
          ← {de ? "Zurück zu Tickets" : "Back to tickets"}
        </button>
        <span className="ticket-detail-breadcrumb-sep" aria-hidden="true">
          {" / "}
        </span>
        <span className="ticket-detail-breadcrumb-current">{reference}</span>
        <div className="ticket-detail-breadcrumb-actions">
          <a
            className="ticket-detail-print-btn"
            href={props.printUrl}
            target="_blank"
            rel="noreferrer"
          >
            {de ? "Ticket drucken" : "Print ticket"}
          </a>
          {advanceLabel && (
            <button
              type="button"
              className="ticket-detail-primary-btn"
              onClick={props.onAdvanceStatus}
            >
              {advanceLabel}
            </button>
          )}
        </div>
      </div>

      <div className="ticket-detail-layout">
        <div className="ticket-detail-main">
          {/* Header card */}
          <article className="ticket-detail-card ticket-detail-header-card">
            <div className="ticket-detail-header-row">
              <span className="ticket-reference">{reference}</span>
              <span className={statusMeta.className}>
                <span aria-hidden="true" className="ticket-status-dot" />
                {statusMeta.label}
              </span>
            </div>
            <h2 className="ticket-detail-title">{ticket.title}</h2>
            <div className="ticket-detail-meta-grid">
              <div className="ticket-detail-meta-field">
                <span className="ticket-detail-meta-label">{de ? "DATUM" : "DATE"}</span>
                <span className="ticket-detail-meta-value">
                  {formatTicketDate(ticket.ticket_date, language)}
                </span>
              </div>
              <div className="ticket-detail-meta-field">
                <span className="ticket-detail-meta-label">{de ? "TEAM" : "CREW"}</span>
                <span className="ticket-detail-meta-value">
                  {crewList.length > 0 ? crewList.join(", ") : "—"}
                </span>
              </div>
              <div className="ticket-detail-meta-field">
                <span className="ticket-detail-meta-label">{de ? "ORT" : "SITE"}</span>
                <span className="ticket-detail-meta-value">{ticket.site_address || "—"}</span>
              </div>
            </div>
          </article>

          {/* Status stepper */}
          <article className="ticket-detail-card ticket-detail-stepper-card">
            <ol className="ticket-detail-stepper">
              {steps.map((step, index) => {
                const isDone = index < currentStepIndex;
                const isCurrent = index === currentStepIndex;
                const state = isDone ? "done" : isCurrent ? "current" : "future";
                return (
                  <li
                    key={`stepper-${step.key}`}
                    className={`ticket-detail-step ticket-detail-step--${state}`}
                  >
                    <span className="ticket-detail-step-dot" aria-hidden="true">
                      {isDone ? "✓" : isCurrent ? "●" : ""}
                    </span>
                    <span className="ticket-detail-step-label">{step.label}</span>
                  </li>
                );
              })}
            </ol>
          </article>

          {/* Notes + checklist card */}
          <article className="ticket-detail-card ticket-detail-notes-card">
            <header className="ticket-detail-card-head">
              <span className="ticket-detail-section-label">{de ? "NOTIZEN" : "NOTES"}</span>
            </header>
            {ticket.notes && ticket.notes.trim().length > 0 ? (
              <p className="ticket-detail-notes-body">{ticket.notes}</p>
            ) : (
              <p className="ticket-detail-notes-body muted">
                {de
                  ? "Keine Notizen für dieses Ticket."
                  : "No notes recorded for this ticket yet."}
              </p>
            )}
            {checklist.length > 0 && (
              <ul className="ticket-detail-checklist">
                {checklist.map((item, index) => (
                  <li
                    key={`checklist-${ticket.id}-${index}`}
                    className={`ticket-detail-checklist-item${item.done ? " ticket-detail-checklist-item--done" : ""}`}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={() => props.onChecklistToggle(index)}
                      />
                      <span>{item.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </article>

          {/* Attachments card */}
          <article className="ticket-detail-card ticket-detail-attachments-card">
            <header className="ticket-detail-card-head">
              <span className="ticket-detail-section-label">{de ? "ANHÄNGE" : "ATTACHMENTS"}</span>
              <span className="ticket-detail-section-hint">
                {de
                  ? `${ticket.attachments_count ?? 0} ${(ticket.attachments_count ?? 0) === 1 ? "Datei" : "Dateien"}`
                  : `${ticket.attachments_count ?? 0} ${(ticket.attachments_count ?? 0) === 1 ? "file" : "files"}`}
              </span>
            </header>
            <div className="ticket-detail-attachments-grid">
              {Array.from({ length: Math.max(ticket.attachments_count ?? 0, 0) }).map((_, index) => (
                <div
                  key={`ticket-attachment-${ticket.id}-${index}`}
                  className="ticket-detail-attachment-tile"
                >
                  <div className="ticket-detail-attachment-thumb" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
                      <rect
                        x="3"
                        y="5"
                        width="18"
                        height="14"
                        rx="2"
                        stroke="#8fa2ba"
                        strokeWidth="1.6"
                      />
                      <circle cx="9" cy="11" r="1.8" fill="#8fa2ba" />
                      <path
                        d="m4.5 18 5-5 4 4 3-3 3 3"
                        stroke="#8fa2ba"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <span className="ticket-detail-attachment-name">
                    file_{String(index + 1).padStart(2, "0")}.jpg
                  </span>
                </div>
              ))}
              <button type="button" className="ticket-detail-attachment-tile ticket-detail-attachment-add">
                <span aria-hidden="true">+</span>
                <span>{de ? "Datei hinzufügen" : "Add attachment"}</span>
              </button>
            </div>
          </article>
        </div>

        {/* Right activity sidebar */}
        <aside className="ticket-detail-sidebar">
          <header className="ticket-detail-sidebar-head">
            <h3>{de ? "Aktivität" : "Activity"}</h3>
          </header>
          <ol className="ticket-detail-activity">
            {activity.map((item) => (
              <li key={item.id} className={`ticket-detail-activity-item activity-${item.kind}`}>
                <div className="ticket-detail-activity-avatar" aria-hidden="true">
                  {initialsFromName(item.author)}
                </div>
                <div className="ticket-detail-activity-body">
                  <div className="ticket-detail-activity-top">
                    <b>{item.author}</b>
                    <span className="ticket-detail-activity-action">
                      {item.kind === "created" &&
                        (de ? "hat das Ticket erstellt" : "created ticket")}
                      {item.kind === "note" &&
                        (de ? "hat eine Notiz hinzugefügt" : "added a note")}
                      {item.kind === "upload" &&
                        (de ? "hat 2 Fotos hochgeladen" : "uploaded 2 photos")}
                      {item.kind === "status" &&
                        (de ? "hat den Status geändert" : "changed status")}
                    </span>
                  </div>
                  {item.body && <p className="ticket-detail-activity-note">{item.body}</p>}
                  <span className="ticket-detail-activity-time">{item.timestamp}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="ticket-detail-comment-box">
            <div className="ticket-detail-comment-avatar" aria-hidden="true">
              {initialsFromName("MM")}
            </div>
            <input
              type="text"
              className="ticket-detail-comment-input"
              value={commentDraft}
              onChange={(event) => setCommentDraft(event.target.value)}
              placeholder={de ? "Kommentar hinzufügen…" : "Add a comment…"}
            />
            <button
              type="button"
              className="ticket-detail-comment-send"
              disabled={commentDraft.trim().length === 0}
            >
              {de ? "Senden" : "Send"}
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}
