import { useAppContext } from "../../context/AppContext";

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

  return (
    <div className="modal-backdrop" onClick={closeArchivedThreadsModal}>
      <div className="card modal-card modal-card-sm" onClick={(event) => event.stopPropagation()}>
        <h3>{language === "de" ? "Archivierte Chats" : "Archived chats"}</h3>
        {archivedThreads.length === 0 && (
          <small className="muted">
            {language === "de" ? "Keine archivierten Chats vorhanden." : "No archived chats available."}
          </small>
        )}
        {archivedThreads.length > 0 && (
          <ul className="thread-list">
            {archivedThreads.map((thread) => {
              const threadProjectLabel = threadProjectTitleParts(thread);
              return (
                <li key={`archived-thread-${thread.id}`}>
                  <div className="thread-archive-row">
                    <div className="thread-item-main">
                      <span className="thread-title-main">
                        <b>{thread.name}</b>
                        {(thread.is_restricted || thread.visibility === "restricted") && (
                          <span className="thread-visibility-badge">
                            {language === "de" ? "Eingeschränkt" : "Restricted"}
                          </span>
                        )}
                      </span>
                      <small>{threadProjectLabel.title || (language === "de" ? "Allgemein" : "General")}</small>
                      {threadProjectLabel.subtitle && <small className="project-name-subtle">{threadProjectLabel.subtitle}</small>}
                    </div>
                    <div className="thread-archive-actions">
                      {thread.can_edit && (
                        <>
                          <button type="button" onClick={() => void restoreArchivedThread(thread.id)}>
                            {language === "de" ? "Wiederherstellen" : "Restore"}
                          </button>
                          <button
                            type="button"
                            className="danger-btn"
                            onClick={() => void deleteThread(thread)}
                          >
                            {language === "de" ? "Löschen" : "Delete"}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="row wrap">
          <button type="button" onClick={closeArchivedThreadsModal}>
            {language === "de" ? "Schließen" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
