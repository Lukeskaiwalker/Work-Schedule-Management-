/**
 * "Notizen" on the customer page: the customer's note feed.
 *
 * The project's "Interne Notizen" (components/project/ProjectNotesCard),
 * moved onto the customer: one posting per row, newest first, with who
 * wrote it and when — what replaced the single text everyone overwrote
 * (the old text is the feed's first entry since migration 0092). The
 * composer sits on top, next to the newest note, because that is where the
 * next one is written. Unlike the project card this one fetches its own
 * first page — the customer page has no overview payload to carry it —
 * and "Ältere anzeigen" pages back by before_id and appends below.
 *
 * After a post or a delete the first page is fetched again and the
 * appended older pages are dropped: the latest page has shifted by one, so
 * anything kept would either gap or duplicate at the seam. Paging back is
 * one click.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useAppContext } from "../../context/AppContext";
import type { CustomerNote } from "../../types";
import {
  CUSTOMER_NOTES_PAGE,
  deleteCustomerNote,
  listCustomerNotes,
  postCustomerNote,
} from "../../utils/customersApi";
import { formatServerDateTime } from "../../utils/dates";
import "../../styles/customer-notes.css";

// Mirrors the server's limit on a note's body, so the browser stops the
// typing where the API would refuse it.
const NOTE_MAX_CHARS = 4000;

type Props = {
  customerId: number;
};

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function CustomerNotesCard({ customerId }: Props) {
  const { token, language, user, canCreateProject, setError, setNotice } = useAppContext();
  const de = language === "de";

  const [latest, setLatest] = useState<CustomerNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [olderNotes, setOlderNotes] = useState<CustomerNote[]>([]);
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Which customer the in-flight requests belong to. A switch to another
  // customer bumps it, and a late answer for the old one is dropped instead
  // of landing in the new feed — together with the old draft and pages.
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    const ticket = generation.current;
    setDraft("");
    setLatest([]);
    setOlderNotes([]);
    setOlderExhausted(false);
    setLoadError(null);
    setLoading(true);

    listCustomerNotes(token, customerId)
      .then((page) => {
        if (generation.current !== ticket) return;
        setLatest(page);
      })
      .catch((err: unknown) => {
        if (generation.current !== ticket) return;
        setLoadError(messageOf(err, de ? "Notizen konnten nicht geladen werden" : "Failed to load notes"));
      })
      .finally(() => {
        if (generation.current !== ticket) return;
        setLoading(false);
      });

    return () => {
      generation.current += 1;
    };
  }, [customerId, token, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const latestIds = new Set(latest.map((note) => note.id));
  const notes = [...latest, ...olderNotes.filter((note) => !latestIds.has(note.id))];
  const lastPageFull = olderNotes.length > 0 || latest.length >= CUSTOMER_NOTES_PAGE;
  const canLoadOlder = !loading && notes.length > 0 && !olderExhausted && lastPageFull;
  const canPost = draft.trim().length > 0 && !posting;

  function canRemove(note: CustomerNote): boolean {
    const own = note.author_user_id != null && note.author_user_id === user?.id;
    return own || canCreateProject;
  }

  // The first page afresh, in place of what is shown: no loading flash, and
  // the older pages go with it because their seam has moved.
  async function refreshLatest() {
    const ticket = generation.current;
    const page = await listCustomerNotes(token, customerId);
    if (generation.current !== ticket) return;
    setLatest(page);
    setOlderNotes([]);
    setOlderExhausted(false);
    setLoadError(null);
  }

  async function post() {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      await postCustomerNote(token, customerId, body);
      setDraft("");
      await refreshLatest();
      setNotice(de ? "Notiz gepostet" : "Note posted");
    } catch (err) {
      // The text stays in the composer: a failed post is retried, not retyped.
      setError(messageOf(err, de ? "Notiz konnte nicht gepostet werden" : "Failed to post note"));
    } finally {
      setPosting(false);
    }
  }

  async function remove(note: CustomerNote) {
    if (removingId !== null) return;
    if (!window.confirm(de ? "Diese Notiz löschen?" : "Delete this note?")) return;
    setRemovingId(note.id);
    try {
      await deleteCustomerNote(token, customerId, note.id);
      await refreshLatest();
      setNotice(de ? "Notiz gelöscht" : "Note deleted");
    } catch (err) {
      setError(messageOf(err, de ? "Notiz konnte nicht gelöscht werden" : "Failed to delete note"));
    } finally {
      setRemovingId(null);
    }
  }

  async function loadOlder() {
    if (loadingOlder || notes.length === 0) return;
    const oldest = notes[notes.length - 1];
    const ticket = generation.current;
    setLoadingOlder(true);
    try {
      const page = await listCustomerNotes(token, customerId, oldest.id);
      if (generation.current !== ticket) return;
      setOlderNotes((current) => [...current, ...page]);
      if (page.length < CUSTOMER_NOTES_PAGE) setOlderExhausted(true);
    } catch (err) {
      setError(messageOf(err, de ? "Ältere Notizen konnten nicht geladen werden" : "Failed to load older notes"));
    } finally {
      if (generation.current === ticket) setLoadingOlder(false);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void post();
    }
  }

  return (
    <section className="customer-notes-card">
      <header className="customer-contact-card-head">
        <h3 className="customer-contact-card-title">
          {de ? "Notizen" : "Notes"}
          {!loading && (
            <span className="customer-notes-count" aria-label={de ? "Anzahl Notizen" : "Number of notes"}>
              {notes.length}
              {canLoadOlder ? "+" : ""}
            </span>
          )}
        </h3>
      </header>

      <div className="customer-notes-composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerKeyDown}
          maxLength={NOTE_MAX_CHARS}
          disabled={posting}
          placeholder={de ? "Neue Notiz … (Strg+Enter zum Posten)" : "New note … (Ctrl+Enter to post)"}
          aria-label={de ? "Neue Notiz" : "New note"}
        />
        <div className="customer-notes-composer-actions">
          <button type="button" onClick={() => void post()} disabled={!canPost}>
            {posting ? (de ? "Wird gepostet …" : "Posting …") : de ? "Posten" : "Post"}
          </button>
        </div>
      </div>

      {loading ? (
        <small className="muted" role="status">
          {de ? "Notizen werden geladen…" : "Loading notes…"}
        </small>
      ) : loadError !== null ? (
        <div className="customer-notes-error" role="alert">
          <span>{de ? "Notizen konnten nicht geladen werden." : "Notes could not be loaded."}</span>
          <small className="muted">{loadError}</small>
          <button type="button" className="linklike" onClick={() => setReloadKey((current) => current + 1)}>
            {de ? "Erneut versuchen" : "Try again"}
          </button>
        </div>
      ) : notes.length === 0 ? (
        <small className="muted customer-notes-empty">
          {de ? "Noch keine Notizen — die erste hier posten." : "No notes yet — post the first one here."}
        </small>
      ) : (
        <ul className="customer-notes-list">
          {notes.map((note) => (
            <li key={`customer-note-${note.id}`} className="customer-notes-item">
              <div className="customer-notes-meta">
                <b className="customer-notes-author">{note.author_name || "—"}</b>
                <small className="customer-notes-time">{formatServerDateTime(note.created_at, language)}</small>
                {canRemove(note) && (
                  <button
                    type="button"
                    className="icon-btn customer-notes-remove"
                    onClick={() => void remove(note)}
                    disabled={removingId === note.id}
                    aria-label={de ? "Notiz löschen" : "Delete note"}
                    title={de ? "Notiz löschen" : "Delete note"}
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="customer-notes-body">{note.body}</div>
            </li>
          ))}
        </ul>
      )}

      {canLoadOlder && (
        <button
          type="button"
          className="linklike customer-notes-more"
          onClick={() => void loadOlder()}
          disabled={loadingOlder}
        >
          {loadingOlder ? (de ? "Lade …" : "Loading …") : de ? "Ältere anzeigen" : "Show older"}
        </button>
      )}
    </section>
  );
}
