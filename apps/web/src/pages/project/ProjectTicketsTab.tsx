import { useAppContext } from "../../context/AppContext";

export function ProjectTicketsTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    activeProjectId,
    language,
    tickets,
    activeProjectTicketAddress,
    activeProjectTicketDate,
    createTicket,
    uploadTicketAttachment,
  } = useAppContext();

  if (mainView !== "project" || !activeProject || projectTab !== "tickets") return null;

  return (
    <section className="grid">
      <form className="card" onSubmit={createTicket}>
        <h3>{language === "de" ? "Job Ticket erstellen" : "Create job ticket"}</h3>
        <input name="title" placeholder="Title" required />
        <small className="muted">
          {language === "de" ? "Projektadresse" : "Project address"}: <b>{activeProjectTicketAddress}</b>
        </small>
        <small className="muted">
          {language === "de" ? "Projektdatum" : "Project date"}: <b>{activeProjectTicketDate}</b>
        </small>
        <input
          name="assigned_crew"
          placeholder={language === "de" ? "Team (kommagetrennt)" : "Crew (comma separated)"}
        />
        <textarea name="notes" placeholder={language === "de" ? "Notizen" : "Notes"} />
        <button type="submit">{language === "de" ? "Ticket speichern" : "Save ticket"}</button>
      </form>
      <div className="card">
        <h3>Tickets</h3>
        <ul>
          {tickets.map((ticket) => (
            <li key={ticket.id}>
              <span>
                {ticket.title} ({ticket.ticket_date})
              </span>
              <a target="_blank" rel="noreferrer" href={`/api/projects/${activeProjectId}/job-tickets/${ticket.id}/print`}>
                {language === "de" ? "Drucken" : "Print"}
              </a>
            </li>
          ))}
        </ul>
      </div>
      <form className="card" onSubmit={uploadTicketAttachment}>
        <h3>{language === "de" ? "Ticket-Anhang" : "Ticket attachment"}</h3>
        <input type="number" name="ticket_id" placeholder="Ticket ID" required />
        <input type="file" name="file" required />
        <button type="submit">{language === "de" ? "Hochladen" : "Upload"}</button>
      </form>
    </section>
  );
}
