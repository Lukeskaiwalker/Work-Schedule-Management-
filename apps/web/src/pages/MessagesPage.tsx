import React from "react";
import { useAppContext } from "../context/AppContext";
import { AvatarBadge } from "../components/shared/AvatarBadge";
import { ThreadIconBadge, threadInitials } from "../components/shared/ThreadIconBadge";
import {
  MessageImageLightbox,
  type LightboxImage,
} from "../components/chat/MessageImageLightbox";
import { MessageReactionStrip } from "../components/chat/MessageReactionStrip";

function formatThreadTimestamp(
  iso: string | null | undefined,
  language: "de" | "en",
): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - dayStart.getTime()) / (1000 * 60 * 60 * 24));
  const locale = language === "de" ? "de-DE" : "en-US";
  if (diffDays <= 0) {
    return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (diffDays === 1) return language === "de" ? "Gestern" : "Yesterday";
  if (diffDays < 7) {
    return date.toLocaleDateString(locale, { weekday: "short" });
  }
  return date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

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
    messageAttachments,
    removeMessageAttachment,
    messageAttachmentInputRef,
    messageListRef,
    onMessageListScroll,
    onMessageAttachmentChange,
    clearMessageAttachment,
    sendMessage,
    canSendMessage,
    toggleMessageReaction,
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

  // Lightbox state. Holds the list of images from the message bubble that
  // was clicked plus the index of the specific image inside that list, so
  // arrow-key nav steps through siblings of the same message rather than
  // jumping across messages. `null` means the lightbox is closed.
  const [lightbox, setLightbox] = React.useState<{
    images: LightboxImage[];
    index: number;
  } | null>(null);
  const closeLightbox = React.useCallback(() => setLightbox(null), []);

  React.useEffect(() => {
    if (mainView === "messages") {
      setMobileThreadListOpen(true);
    }
  }, [mainView]);

  if (mainView !== "messages") return null;

  const de = language === "de";
  const threadSelected = !mobileThreadListOpen;

  const activeParticipantCount =
    activeThread && Array.isArray(activeThread.participant_user_ids)
      ? activeThread.participant_user_ids.length
      : 0;
  const activeParticipantNames =
    activeThread && Array.isArray(activeThread.participant_user_ids)
      ? activeThread.participant_user_ids
          .slice(0, 3)
          .map((id: number) => userNameById(id))
          .filter((name: string) => name && name.length > 0)
          .join(", ")
      : "";

  return (
    <section
      className={`messages-page${threadSelected ? " messages-page--thread-active" : ""}`}
    >
      {/* ── Left: Thread list ───────────────────────────────────── */}
      <aside className="messages-page-threads">
        <header className="messages-page-threads-head">
          <h2 className="messages-page-threads-title">{de ? "Threads" : "Threads"}</h2>
          <div className="messages-page-threads-actions">
            <button
              type="button"
              className="messages-page-threads-archive"
              onClick={() => void openArchivedThreadsModal()}
            >
              {de ? "Archiv" : "Archive"}
            </button>
            <button
              type="button"
              className="messages-page-threads-create"
              onClick={openCreateThreadModal}
              aria-label={de ? "Thread erstellen" : "Create thread"}
              title={de ? "Thread erstellen" : "Create thread"}
            >
              +
            </button>
          </div>
        </header>

        <ul className="messages-page-thread-list">
          {threads.length === 0 && (
            <li className="messages-page-thread-empty muted">
              {de ? "Keine Threads vorhanden." : "No threads yet."}
            </li>
          )}
          {threads.map((thread) => {
            const threadProjectLabel = threadProjectTitleParts(thread);
            const isActive = activeThreadId === thread.id;
            const hasUnread = thread.unread_count > 0;
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className={`messages-page-thread-item${isActive ? " messages-page-thread-item--active" : ""}`}
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
                    className="messages-page-thread-avatar"
                  />
                  <div className="messages-page-thread-body">
                    <div className="messages-page-thread-top">
                      <span className="messages-page-thread-name">{thread.name}</span>
                      <span className="messages-page-thread-time">
                        {formatThreadTimestamp(thread.last_message_at, language)}
                      </span>
                    </div>
                    <div className="messages-page-thread-bottom">
                      <span className="messages-page-thread-preview">
                        {thread.last_message_preview ??
                          threadProjectLabel.title ??
                          (de ? "Keine Nachrichten" : "No messages")}
                      </span>
                      {hasUnread && (
                        <span className="messages-page-thread-unread">{thread.unread_count}</span>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* ── Right: Message pane ─────────────────────────────────── */}
      <div className="messages-page-chat">
        {!activeThread && (
          <div className="messages-page-empty">
            <div className="messages-page-empty-icon" aria-hidden="true">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
                <path
                  d="M4.5 6.5h15a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-8l-4 3v-3h-3a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2Z"
                  stroke="#c9d9ea"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span className="muted">
              {de ? "Bitte einen Thread wählen." : "Please select a thread."}
            </span>
          </div>
        )}
        {activeThread && (
          <>
            <header className="messages-page-chat-head">
              <button
                type="button"
                className="messages-page-chat-back"
                onClick={() => setMobileThreadListOpen(true)}
                aria-label={de ? "Zur Thread-Liste" : "Back to thread list"}
              >
                ← {de ? "Threads" : "Threads"}
              </button>
              <ThreadIconBadge
                threadId={activeThread.id}
                initials={threadInitials(activeThread.name)}
                hasIcon={Boolean(activeThread.icon_updated_at)}
                versionKey={activeThread.icon_updated_at || "0"}
                className="messages-page-chat-head-avatar"
              />
              <div className="messages-page-chat-head-text">
                <h2 className="messages-page-chat-title">{activeThread.name}</h2>
                <p className="messages-page-chat-subtitle">
                  {activeParticipantCount > 0
                    ? `${activeParticipantCount} ${de ? "Teilnehmer" : "participants"}`
                    : de
                      ? "Allgemein"
                      : "General"}
                  {activeParticipantNames ? ` · ${activeParticipantNames}` : ""}
                </p>
              </div>
              {activeThread.can_edit && (
                <div className="messages-page-chat-menu">
                  <button
                    type="button"
                    className="messages-page-chat-menu-btn"
                    aria-haspopup="menu"
                    aria-expanded={threadActionMenuOpen}
                    aria-label={de ? "Thread-Aktionen öffnen" : "Open thread actions"}
                    onClick={() => setThreadActionMenuOpen(!threadActionMenuOpen)}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="5.5" cy="12" r="1.5" fill="currentColor" />
                      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                      <circle cx="18.5" cy="12" r="1.5" fill="currentColor" />
                    </svg>
                  </button>
                  {threadActionMenuOpen && (
                    <div className="messages-page-chat-menu-popup" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setThreadActionMenuOpen(false);
                          openEditThreadModal(activeThread);
                        }}
                      >
                        {de ? "Thread bearbeiten" : "Edit thread"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setThreadActionMenuOpen(false);
                          void archiveActiveThread();
                        }}
                      >
                        {de ? "Archivieren" : "Archive"}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="messages-page-chat-menu-danger"
                        onClick={() => {
                          setThreadActionMenuOpen(false);
                          void deleteThread(activeThread);
                        }}
                      >
                        {de ? "Löschen" : "Delete"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </header>

            <ul
              ref={messageListRef as React.RefObject<HTMLUListElement>}
              onScroll={onMessageListScroll}
              className="messages-page-message-list"
            >
              {chatRenderRows.map((row) => {
                if (row.kind === "day") {
                  return (
                    <li key={row.key} className="messages-page-day-divider">
                      <span>{row.label}</span>
                    </li>
                  );
                }
                const message = row.message;
                const senderId = message.sender_id;
                const senderName = userNameById(senderId);
                return (
                  <li
                    key={row.key}
                    className={`messages-page-row messages-page-row--${row.mine ? "mine" : "other"}`}
                  >
                    {row.showSenderName && (
                      <div
                        className={`messages-page-row-sender${row.mine ? " messages-page-row-sender--mine" : ""}`}
                      >
                        <span>{row.mine ? (de ? "Du" : "You") : senderName}</span>
                        <span className="messages-page-row-sender-sep">·</span>
                        <span>{row.timeLabel}</span>
                      </div>
                    )}
                    <div className="messages-page-row-body">
                      {!row.mine && (
                        <span className="messages-page-row-avatar-slot" aria-hidden="true">
                          {row.showAvatar ? (
                            <AvatarBadge
                              userId={senderId}
                              initials={userInitialsById(senderId)}
                              hasAvatar={userHasAvatar(senderId)}
                              versionKey={String(userAvatarVersionById(senderId))}
                              className="messages-page-row-avatar"
                            />
                          ) : (
                            <span className="messages-page-row-avatar-placeholder" />
                          )}
                        </span>
                      )}
                      <div
                        className={`messages-page-bubble messages-page-bubble--${row.mine ? "mine" : "other"}`}
                      >
                        {message.body && <p className="messages-page-bubble-text">{message.body}</p>}
                        {(() => {
                          // Pre-compute the image list for this message so
                          // every clicked thumbnail can hand the lightbox
                          // the full sibling set for arrow navigation.
                          const messageImages: LightboxImage[] = message.attachments
                            .filter((a) => a.content_type.startsWith("image/"))
                            .map((a) => ({
                              id: a.id,
                              src: filePreviewUrl(a.id),
                              alt: a.file_name,
                              fileName: a.file_name,
                            }));
                          return message.attachments.map((attachment) => {
                            const isImage = attachment.content_type.startsWith("image/");
                            const imageIndex = messageImages.findIndex(
                              (img) => img.id === attachment.id,
                            );
                            return (
                              <div
                                key={attachment.id}
                                className="messages-page-bubble-attachment"
                              >
                                {isImage && (
                                  <button
                                    type="button"
                                    className="messages-page-bubble-attachment-image-btn"
                                    onClick={() =>
                                      setLightbox({
                                        images: messageImages,
                                        index: imageIndex >= 0 ? imageIndex : 0,
                                      })
                                    }
                                    aria-label={
                                      de ? "Bild vergrößern" : "Open image preview"
                                    }
                                  >
                                    <img
                                      src={filePreviewUrl(attachment.id)}
                                      alt={attachment.file_name}
                                    />
                                  </button>
                                )}
                                <div className="messages-page-bubble-attachment-links">
                                  <a
                                    href={filePreviewUrl(attachment.id)}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {de ? "Vorschau" : "Preview"}
                                  </a>
                                  <a href={fileDownloadUrl(attachment.id)}>
                                    {attachment.file_name}
                                  </a>
                                </div>
                              </div>
                            );
                          });
                        })()}
                        <MessageReactionStrip
                          reactions={message.reactions ?? []}
                          onToggle={(emoji) => toggleMessageReaction(message.id, emoji)}
                          language={language}
                        />
                      </div>
                      {row.mine && (
                        <span className="messages-page-row-avatar-slot" aria-hidden="true">
                          {row.showAvatar ? (
                            <AvatarBadge
                              userId={senderId}
                              initials={userInitialsById(senderId)}
                              hasAvatar={userHasAvatar(senderId)}
                              versionKey={String(userAvatarVersionById(senderId))}
                              className="messages-page-row-avatar"
                            />
                          ) : (
                            <span className="messages-page-row-avatar-placeholder" />
                          )}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <form onSubmit={sendMessage} className="messages-page-composer">
              <label
                className="messages-page-composer-attach"
                aria-label={de ? "Datei anhängen" : "Attach file"}
                title={de ? "Datei anhängen" : "Attach file"}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <input
                  ref={messageAttachmentInputRef as React.RefObject<HTMLInputElement>}
                  type="file"
                  name="attachments"
                  multiple
                  onChange={onMessageAttachmentChange}
                />
              </label>
              <div className="messages-page-composer-field">
                <input
                  name="body"
                  value={messageBody}
                  onChange={(event) => setMessageBody(event.target.value)}
                  placeholder={de ? "Nachricht eingeben…" : "Type a message…"}
                  className="messages-page-composer-input"
                />
                {messageAttachments.length > 0 && (
                  <div className="messages-page-composer-attachments">
                    {messageAttachments.map((file, index) => (
                      <div
                        key={`composer-attachment-${index}-${file.name}`}
                        className="messages-page-composer-attachment"
                      >
                        <small title={file.name}>{file.name}</small>
                        <button
                          type="button"
                          className="messages-page-composer-attachment-remove"
                          onClick={() => removeMessageAttachment(index)}
                          aria-label={de ? "Anhang entfernen" : "Remove attachment"}
                          title={de ? "Anhang entfernen" : "Remove attachment"}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {messageAttachments.length > 1 && (
                      <button
                        type="button"
                        className="messages-page-composer-attachment-remove"
                        onClick={clearMessageAttachment}
                        aria-label={de ? "Alle entfernen" : "Remove all"}
                        title={de ? "Alle entfernen" : "Remove all"}
                      >
                        {de ? "Alle entfernen" : "Clear all"}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <button
                type="submit"
                className="messages-page-composer-send"
                disabled={!canSendMessage}
                aria-label={de ? "Senden" : "Send"}
                title={de ? "Senden" : "Send"}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 12h14m0 0-6-6m6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </form>
          </>
        )}
      </div>
      {lightbox && (
        <MessageImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onIndexChange={(next) =>
            setLightbox((prev) => (prev ? { ...prev, index: next } : prev))
          }
          onClose={closeLightbox}
          language={language}
        />
      )}
    </section>
  );
}
