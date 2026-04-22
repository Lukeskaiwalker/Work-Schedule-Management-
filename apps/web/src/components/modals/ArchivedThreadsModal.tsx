import { useAppContext } from "../../context/AppContext";
import { ThreadIconBadge, threadInitials } from "../shared/ThreadIconBadge";

export function ArchivedThreadsModal() {
  const {
    language,
    archivedThreadsModalOpen,
    mainView,
    archivedThreads,
    closeArchivedThreadsModal,
    restoreArchivedThread,
    deleteThread,
    threadProjectTitleParts,
  } = useAppContext();

  if (!archivedThreadsModalOpen || mainView !== "messages") return null;
  const de = language === "de";

  return (
    <div className="modal-backdrop" onClick={closeArchivedThreadsModal}>
      <div
        className="card modal-card task-modal-card"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="task-modal-form">
          <header className="task-modal-head">
            <div className="task-modal-eyebrow">
              <span className="task-modal-eyebrow-label">
                {de ? "ARCHIV" : "ARCHIVE"}
              </span>
            </div>
            <h2 className="task-modal-title">
              {de ? "Archivierte Chats" : "Archived chats"}
            </h2>
          </header>

          <section className="task-modal-section task-modal-section--stack">
            {archivedThreads.length === 0 && (
              <div className="archived-threads-empty muted">
                {de
                  ? "Keine archivierten Chats vorhanden."
                  : "No archived chats available."}
              </div>
            )}
            {archivedThreads.length > 0 && (
              <ul className="archived-threads-list">
                {archivedThreads.map((thread) => {
                  const threadProjectLabel = threadProjectTitleParts(thread);
                  return (
                    <li
                      key={`archived-thread-${thread.id}`}
                      className="archived-threads-row"
                    >
                      <ThreadIconBadge
                        threadId={thread.id}
                        initials={threadInitials(thread.name)}
                        hasIcon={Boolean(thread.icon_updated_at)}
                        versionKey={thread.icon_updated_at || "0"}
                        className="archived-threads-avatar"
                      />
                      <div className="archived-threads-main">
                        <span className="archived-threads-title-line">
                          <span className="archived-threads-name">{thread.name}</span>
                          {(thread.is_restricted || thread.visibility === "restricted") && (
                            <span className="archived-threads-restricted-badge">
                              {de ? "Eingeschränkt" : "Restricted"}
                            </span>
                          )}
                        </span>
                        <span className="archived-threads-subtitle">
                          {threadProjectLabel.title || (de ? "Allgemein" : "General")}
                          {threadProjectLabel.subtitle
                            ? ` · ${threadProjectLabel.subtitle}`
                            : ""}
                        </span>
                      </div>
                      {thread.can_edit && (
                        <div className="archived-threads-actions">
                          <button
                            type="button"
                            className="task-modal-btn task-modal-btn--secondary"
                            onClick={() => void restoreArchivedThread(thread.id)}
                          >
                            {de ? "Wiederherstellen" : "Restore"}
                          </button>
                          <button
                            type="button"
                            className="task-modal-btn project-modal-btn--danger"
                            onClick={() => void deleteThread(thread)}
                          >
                            {de ? "Löschen" : "Delete"}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <footer className="task-modal-footer">
            <button
              type="button"
              className="task-modal-btn task-modal-btn--primary"
              onClick={closeArchivedThreadsModal}
            >
              {de ? "Schließen" : "Close"}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
