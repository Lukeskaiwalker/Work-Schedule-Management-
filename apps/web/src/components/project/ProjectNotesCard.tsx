/**
 * "Interne Notizen" on the project overview: the project's note feed.
 *
 * One posting per row, newest first, with who wrote it and when — what
 * replaced the single text everyone overwrote. The composer sits on top,
 * next to the newest note, because that is where the next one is written.
 * The overview brings the latest page; "Ältere anzeigen" fetches the rest
 * from GET /projects/{id}/notes by before_id and appends it below.
 *
 * After a post or a delete the overview is reloaded and the appended older
 * pages are dropped: the latest page has shifted by one, so anything kept
 * would either gap or duplicate at the seam. Paging back is one click.
 */
import { useEffect, useState, type KeyboardEvent } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import type { ProjectNote } from "../../types";
import { formatServerDateTime } from "../../utils/dates";
import "../../styles/project-notes.css";

// The server's page size for the overview and the list endpoint. A page
// this long may have more behind it; a shorter one is the end of the feed.
export const NOTES_PAGE = 20;
// Mirrors PROJECT_NOTE_MAX_CHARS on the server, so the browser stops the
// typing where the API would refuse it.
const NOTE_MAX_CHARS = 4000;

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function ProjectNotesCard() {
  const {
    token,
    language,
    user,
    activeProjectId,
    projectOverviewDetails,
    loadProjectOverview,
    canCreateProject,
    setError,
    setNotice,
  } = useAppContext();
  const de = language === "de";

  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [olderNotes, setOlderNotes] = useState<ProjectNote[]>([]);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // The card stays mounted across a project switch (the tab does not
  // unmount it), so what belongs to the previous project — its older pages
  // and a half-written note — must not carry over.
  useEffect(() => {
    setDraft("");
    setOlderNotes([]);
    setOlderExhausted(false);
  }, [activeProjectId]);

  const latest = projectOverviewDetails?.notes ?? [];
  const latestIds = new Set(latest.map((note) => note.id));
  const notes = [...latest, ...olderNotes.filter((note) => !latestIds.has(note.id))];
  const lastPageFull = olderNotes.length > 0 || latest.length >= NOTES_PAGE;
  const canLoadOlder = notes.length > 0 && !olderExhausted && lastPageFull;
  const canPost = draft.trim().length > 0 && !posting;

  function canRemove(note: ProjectNote): boolean {
    const own = note.author_user_id != null && note.author_user_id === user?.id;
    return own || canCreateProject;
  }

  async function post() {
    const body = draft.trim();
    if (!activeProjectId || !body || posting) return;
    setPosting(true);
    try {
      await apiFetch<ProjectNote>(`/projects/${activeProjectId}/notes`, token, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      setDraft("");
      setOlderNotes([]);
      setOlderExhausted(false);
      await loadProjectOverview(activeProjectId);
      setNotice(de ? "Notiz gepostet" : "Note posted");
    } catch (err) {
      // The text stays in the composer: a failed post is retried, not retyped.
      setError(messageOf(err, de ? "Notiz konnte nicht gepostet werden" : "Failed to post note"));
    } finally {
      setPosting(false);
    }
  }

  async function remove(note: ProjectNote) {
    if (!activeProjectId || removingId !== null) return;
    if (!window.confirm(de ? "Diese Notiz löschen?" : "Delete this note?")) return;
    setRemovingId(note.id);
    try {
      await apiFetch<void>(`/projects/${activeProjectId}/notes/${note.id}`, token, { method: "DELETE" });
      setOlderNotes([]);
      setOlderExhausted(false);
      await loadProjectOverview(activeProjectId);
      setNotice(de ? "Notiz gelöscht" : "Note deleted");
    } catch (err) {
      setError(messageOf(err, de ? "Notiz konnte nicht gelöscht werden" : "Failed to delete note"));
    } finally {
      setRemovingId(null);
    }
  }

  async function loadOlder() {
    if (!activeProjectId || loadingOlder || notes.length === 0) return;
    const oldest = notes[notes.length - 1];
    setLoadingOlder(true);
    try {
      const page = await apiFetch<ProjectNote[]>(
        `/projects/${activeProjectId}/notes?limit=${NOTES_PAGE}&before_id=${oldest.id}`,
        token,
      );
      setOlderNotes((current) => [...current, ...page]);
      if (page.length < NOTES_PAGE) setOlderExhausted(true);
    } catch (err) {
      setError(messageOf(err, de ? "Ältere Notizen konnten nicht geladen werden" : "Failed to load older notes"));
    } finally {
      setLoadingOlder(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void post();
    }
  }

  return (
    <div className="card project-overview-note project-notes-card">
      <div className="project-overview-card-head">
        <h3 className="project-overview-title">
          {de ? "Interne Notizen" : "Internal notes"}
          <span className="project-notes-count" aria-label={de ? "Anzahl Notizen" : "Number of notes"}>
            {notes.length}
            {canLoadOlder ? "+" : ""}
          </span>
        </h3>
      </div>

      <div className="project-notes-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
          maxLength={NOTE_MAX_CHARS}
          disabled={posting}
          placeholder={de ? "Neue Notiz … (Strg+Enter zum Posten)" : "New note … (Ctrl+Enter to post)"}
          aria-label={de ? "Neue Notiz" : "New note"}
        />
        <div className="project-notes-composer-actions">
          <button type="button" onClick={() => void post()} disabled={!canPost}>
            {posting ? (de ? "Wird gepostet …" : "Posting …") : de ? "Posten" : "Post"}
          </button>
        </div>
      </div>

      {notes.length === 0 ? (
        <small className="muted project-notes-empty">
          {de ? "Noch keine Notizen — die erste hier posten." : "No notes yet — post the first one here."}
        </small>
      ) : (
        <ul className="project-notes-list">
          {notes.map((note) => (
            <li key={`project-note-${note.id}`} className="project-notes-item">
              <div className="project-notes-meta">
                <b className="project-notes-author">{note.author_name || "—"}</b>
                <small className="project-notes-time">{formatServerDateTime(note.created_at, language)}</small>
                {canRemove(note) && (
                  <button
                    type="button"
                    className="icon-btn project-notes-remove"
                    onClick={() => void remove(note)}
                    disabled={removingId === note.id}
                    aria-label={de ? "Notiz löschen" : "Delete note"}
                    title={de ? "Notiz löschen" : "Delete note"}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="project-notes-body">{note.body}</div>
            </li>
          ))}
        </ul>
      )}

      {canLoadOlder && (
        <button
          type="button"
          className="linklike project-notes-more"
          onClick={() => void loadOlder()}
          disabled={loadingOlder}
        >
          {loadingOlder ? (de ? "Lade …" : "Loading …") : de ? "Ältere anzeigen" : "Show older"}
        </button>
      )}
    </div>
  );
}
