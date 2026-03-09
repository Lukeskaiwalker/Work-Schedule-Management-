import React from "react";
import { useAppContext } from "../context/AppContext";
import { AvatarBadge } from "../components/shared/AvatarBadge";
import { ThreadIconBadge, threadInitials } from "../components/shared/ThreadIconBadge";

export function MessagesPage() {
  const {
    mainView,
    language,
    threads,
    activeThreadId,
    setActiveThreadId,
    activeThread,
    chatRenderRows,
    messageBody,
    setMessageBody,
    messageAttachment,
    messageAttachmentInputRef,
    messageListRef,
    onMessageListScroll,
    onMessageAttachmentChange,
    clearMessageAttachment,
    sendMessage,
    canSendMessage,
    threadActionMenuOpen,
    setThreadActionMenuOpen,
    threadProjectTitleParts,
    userNameById,
    userInitialsById,
    userHasAvatar,
    userAvatarVersionById,
    filePreviewUrl,
    fileDownloadUrl,
    openArchivedThreadsModal,
    openCreateThreadModal,
    openEditThreadModal,
    archiveActiveThread,
    deleteThread,
  } = useAppContext();

  const [mobileThreadListOpen, setMobileThreadListOpen] = React.useState(true);

  React.useEffect(() => {
    if (mainView === "messages") {
      setMobileThreadListOpen(true);
    }
  }, [mainView]);

  if (mainView !== "messages") return null;

  const threadSelected = !mobileThreadListOpen;

  return (
    <section className={threadSelected ? "chat-layout thread-selected" : "chat-layout"}>
      <aside className="thread-panel chat-thread-list">
        <div className="row thread-panel-head">
          <h3>{language === "de" ? "Threads" : "Threads"}</h3>
          <div className="thread-panel-actions">
            <button
              type="button"
              className="icon-btn thread-archive-list-btn"
              onClick={() => void openArchivedThreadsModal()}
              aria-label={language === "de" ? "Archivierte Chats" : "Archived chats"}
              title={language === "de" ? "Archivierte Chats" : "Archived chats"}
            >
              {language === "de" ? "Archiv" : "Archive"}
            </button>
            <button
              type="button"
              className="create-new-btn thread-create-btn"
              onClick={openCreateThreadModal}
              aria-label={language === "de" ? "Thread erstellen" : "Create thread"}
              title={language === "de" ? "Thread erstellen" : "Create thread"}
            >
              +
            </button>
          </div>
        </div>
        <ul className="thread-list">
          {threads.map((thread) => {
            const threadProjectLabel = threadProjectTitleParts(thread);
            return (
              <li key={thread.id}>
                <button
                  className={activeThreadId === thread.id ? "active thread-item" : "thread-item"}
                  onClick={() => {
                    setActiveThreadId(thread.id);
                    setMobileThreadListOpen(false);
                  }}
                >
                  <ThreadIconBadge
                    threadId={thread.id}
                    initials={threadInitials(thread.name)}
                    hasIcon={Boolean(thread.icon_updated_at)}
                    versionKey={thread.icon_updated_at || "0"}
                    className="thread-avatar-sm"
                  />
                  <span className="thread-item-main">
                    <span className="thread-title-row">
                      <span className="thread-title-main">
                        <b>{thread.name}</b>
                        {(thread.is_restricted || thread.visibility === "restricted") && (
                          <span className="thread-visibility-badge">
                            {language === "de" ? "Eingeschränkt" : "Restricted"}
                          </span>
                        )}
                      </span>
                      {thread.unread_count > 0 && <span className="thread-unread-badge">{thread.unread_count}</span>}
                    </span>
                    <small>{threadProjectLabel.title || (language === "de" ? "Allgemein" : "General")}</small>
                    {threadProjectLabel.subtitle && <small className="project-name-subtle">{threadProjectLabel.subtitle}</small>}
                    <small>{thread.last_message_preview ?? "-"}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="chat-panel chat-message-pane">
        {!activeThread && (
          <div className="chat-empty">{language === "de" ? "Bitte einen Thread wählen." : "Please select a thread."}</div>
        )}
        {activeThread && (() => {
          const activeThreadProjectLabel = threadProjectTitleParts(activeThread);
          return (
            <>
            <div className="chat-panel-head">
              <button
                type="button"
                className="icon-btn chat-mobile-back-btn"
                onClick={() => setMobileThreadListOpen(true)}
                aria-label={language === "de" ? "Zur Thread-Liste" : "Back to thread list"}
              >
                ← {language === "de" ? "Threads" : "Threads"}
              </button>
              <div className="chat-thread-meta">
                <ThreadIconBadge
                  threadId={activeThread.id}
                  initials={threadInitials(activeThread.name)}
                  hasIcon={Boolean(activeThread.icon_updated_at)}
                  versionKey={activeThread.icon_updated_at || "0"}
                />
                <div>
                  <span className="thread-title-main">
                    <b>{activeThread.name}</b>
                    {(activeThread.is_restricted || activeThread.visibility === "restricted") && (
                      <span className="thread-visibility-badge">
                        {language === "de" ? "Eingeschränkt" : "Restricted"}
                      </span>
                    )}
                  </span>
                  <small>{activeThreadProjectLabel.title || (language === "de" ? "Allgemein" : "General")}</small>
                  {activeThreadProjectLabel.subtitle && <small className="project-name-subtle">{activeThreadProjectLabel.subtitle}</small>}
                </div>
              </div>
              {activeThread.can_edit && (
                <div className="thread-head-actions">
                  <div className="thread-actions-menu-wrap">
                    <button
                      type="button"
                      className="thread-actions-trigger"
                      aria-haspopup="menu"
                      aria-expanded={threadActionMenuOpen}
                      aria-label={language === "de" ? "Thread-Aktionen öffnen" : "Open thread actions"}
                      title={language === "de" ? "Thread-Aktionen" : "Thread actions"}
                      onClick={() => setThreadActionMenuOpen(!threadActionMenuOpen)}
                    >
                      &#8942;
                    </button>
                    {threadActionMenuOpen && (
                      <div className="thread-actions-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setThreadActionMenuOpen(false);
                            openEditThreadModal(activeThread);
                          }}
                        >
                          {language === "de" ? "Thread bearbeiten" : "Edit thread"}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setThreadActionMenuOpen(false);
                            void archiveActiveThread();
                          }}
                        >
                          {language === "de" ? "Archivieren" : "Archive"}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => {
                            setThreadActionMenuOpen(false);
                            void deleteThread(activeThread);
                          }}
                        >
                          {language === "de" ? "Löschen" : "Delete"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <ul ref={messageListRef as React.RefObject<HTMLUListElement>} onScroll={onMessageListScroll} className="message-list">
              {chatRenderRows.map((row) => {
                if (row.kind === "day") {
                  return (
                    <li key={row.key} className="message-day-divider">
                      <span>{row.label}</span>
                    </li>
                  );
                }
                const message = row.message;
                const senderId = message.sender_id;
                const senderName = userNameById(senderId);
                return (
                  <li key={row.key} className={row.mine ? "message-row mine" : "message-row other"}>
                    {!row.mine && (
                      <span className="message-avatar-slot" aria-hidden="true">
                        {row.showAvatar ? (
                          <AvatarBadge
                            userId={senderId}
                            initials={userInitialsById(senderId)}
                            hasAvatar={userHasAvatar(senderId)}
                            versionKey={String(userAvatarVersionById(senderId))}
                            className="message-sender-avatar"
                          />
                        ) : (
                          <span className="message-avatar-placeholder" />
                        )}
                      </span>
                    )}
                    <div className={row.mine ? "message-bubble mine" : "message-bubble other"}>
                      {row.showSenderName && <small className="message-sender-name">{senderName}</small>}
                      {message.body && <p>{message.body}</p>}
                      {message.attachments.map((attachment) => (
                        <div key={attachment.id} className="chat-attachment">
                          {attachment.content_type.startsWith("image/") && (
                            <img src={filePreviewUrl(attachment.id)} alt={attachment.file_name} />
                          )}
                          <div className="row wrap">
                            <a href={filePreviewUrl(attachment.id)} target="_blank" rel="noreferrer">
                              {language === "de" ? "Vorschau" : "Preview"}
                            </a>
                            <a href={fileDownloadUrl(attachment.id)}>{attachment.file_name}</a>
                          </div>
                        </div>
                      ))}
                      <small className={row.mine ? "message-time mine" : "message-time other"}>{row.timeLabel}</small>
                    </div>
                  </li>
                );
              })}
            </ul>

            <form onSubmit={sendMessage} className="chat-compose">
              <label
                className={messageAttachment ? "chat-attach-btn has-file" : "chat-attach-btn"}
                aria-label={language === "de" ? "Datei anhängen" : "Attach file"}
                title={language === "de" ? "Datei anhängen" : "Attach file"}
              >
                <span>+</span>
                <input ref={messageAttachmentInputRef as React.RefObject<HTMLInputElement>} type="file" name="attachment" onChange={onMessageAttachmentChange} />
              </label>
              <div className="chat-compose-main">
                <input
                  name="body"
                  value={messageBody}
                  onChange={(event) => setMessageBody(event.target.value)}
                  placeholder={language === "de" ? "Nachricht eingeben" : "Type message"}
                />
                {messageAttachment && (
                  <div className="chat-pending-attachment">
                    <small title={messageAttachment.name}>{messageAttachment.name}</small>
                    <button
                      type="button"
                      className="chat-attachment-remove"
                      onClick={clearMessageAttachment}
                      aria-label={language === "de" ? "Anhang entfernen" : "Remove attachment"}
                      title={language === "de" ? "Anhang entfernen" : "Remove attachment"}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
              <button
                type="submit"
                className={canSendMessage ? "chat-send-btn" : "chat-send-btn is-muted"}
                disabled={!canSendMessage}
                aria-label={language === "de" ? "Senden" : "Send"}
                title={language === "de" ? "Senden" : "Send"}
              >
                <span className="chat-send-arrow">➤</span>
              </button>
            </form>
          </>
          );
        })()}
      </div>
    </section>
  );
}
