import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import type { Language } from "../../types";
import {
  createCalendarFeed,
  deleteCalendarFeed,
  getCalendarFeed,
  type CalendarFeed,
} from "../../utils/calendarFeedApi";
import { fetchCountLabel, formatFetchedAt, friendlyFetchAgent } from "./calendarFeedText";
import "../../styles/calendar-feed.css";

/**
 * The "Kalender-Abo" card on the profile page.
 *
 * Every user gets one subscription link that a phone's calendar app can poll:
 * their own tasks, approved vacation and school days. The card manages that
 * link and nothing else — the .ics itself is fetched by the calendar app,
 * never by this page.
 *
 * Three states, plus loading and a failed load:
 *   • none      — what the feature does and a button that creates the link
 *   • active    — the link (as webcal button and copyable https field), when
 *                 it was last fetched and by which app, rotate and remove
 *   • how-to    — collapsed under the active state, one recipe per app
 *
 * Rotating and removing both ask first: either one breaks the link on every
 * device where it was entered, and that is not undoable from here.
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; feed: CalendarFeed | null };

type Action = "create" | "rotate" | "remove" | null;

const COPIED_RESET_MS = 2000;
const LINK_INPUT_ID = "smpl-calendar-feed-link";

const ROTATE_CONFIRM =
  "Link neu erzeugen?\n\nDer bisherige Link funktioniert dann auf keinem Gerät mehr, auf dem er eingetragen wurde. Dort muss der neue Link eingetragen werden.";
const REMOVE_CONFIRM =
  "Kalender-Abo entfernen?\n\nDer Link funktioniert dann auf keinem Gerät mehr. Du kannst jederzeit ein neues Abo einrichten.";

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function CalendarFeedSection() {
  const { token, language, setNotice } = useAppContext();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<Action>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const feed = await getCalendarFeed(token);
      setState({ kind: "ready", feed });
    } catch (err) {
      setState({ kind: "error", message: errorMessage(err) });
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function runCreate(action: "create" | "rotate") {
    setBusy(action);
    setActionError(null);
    try {
      const feed = await createCalendarFeed(token);
      setState({ kind: "ready", feed });
      setCopied(false);
      setNotice(action === "rotate" ? "Neuer Abo-Link erzeugt." : "Kalender-Abo eingerichtet.");
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function handleCreate() {
    void runCreate("create");
  }

  function handleRotate() {
    if (!window.confirm(ROTATE_CONFIRM)) return;
    void runCreate("rotate");
  }

  async function handleRemove() {
    if (!window.confirm(REMOVE_CONFIRM)) return;
    setBusy("remove");
    setActionError(null);
    try {
      await deleteCalendarFeed(token);
      setState({ kind: "ready", feed: null });
      setCopied(false);
      setNotice("Kalender-Abo entfernt.");
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // The clipboard API refuses on insecure origins and in some embedded
      // views. Selecting the field lets the user copy by hand.
      const input = document.getElementById(LINK_INPUT_ID) as HTMLInputElement | null;
      input?.select();
    }
  }

  return (
    <div className="profile-page-card profile-page-card--calendar-feed">
      <header className="profile-page-card-head">
        <h2 className="profile-page-card-title">Kalender-Abo</h2>
      </header>

      {state.kind === "loading" && <p className="calendar-feed-muted">Lade…</p>}

      {state.kind === "error" && (
        <div className="calendar-feed-error-block" role="alert">
          <p className="calendar-feed-error">{state.message}</p>
          <button type="button" className="calendar-feed-secondary-btn" onClick={() => void load()}>
            Erneut versuchen
          </button>
        </div>
      )}

      {state.kind === "ready" && state.feed === null && (
        <EmptyState busy={busy === "create"} error={actionError} onCreate={handleCreate} />
      )}

      {state.kind === "ready" && state.feed !== null && (
        <ActiveState
          feed={state.feed}
          language={language}
          busy={busy}
          error={actionError}
          copied={copied}
          onCopy={() => void handleCopy(state.feed!.url)}
          onRotate={handleRotate}
          onRemove={() => void handleRemove()}
        />
      )}

      <small className="calendar-feed-note">
        Der Link enthält dein persönliches Zugangs-Token. Wer ihn hat, sieht deine Termine — nicht weitergeben.
      </small>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────

type EmptyStateProps = {
  busy: boolean;
  error: string | null;
  onCreate: () => void;
};

function EmptyState({ busy, error, onCreate }: EmptyStateProps) {
  return (
    <div className="calendar-feed-empty">
      <p className="calendar-feed-intro">
        Deine Aufgaben, Urlaub und Berufsschule als Abo-Kalender auf dem Handy. Änderungen an Terminen kommen
        automatisch an — nichts muss von Hand eingetragen werden.
      </p>
      {error && <p className="calendar-feed-error">{error}</p>}
      <div className="profile-page-form-actions">
        <button type="button" className="profile-page-save-btn" disabled={busy} onClick={onCreate}>
          {busy ? "Wird eingerichtet…" : "Kalender-Abo einrichten"}
        </button>
      </div>
    </div>
  );
}

// ── Active state ──────────────────────────────────────────────────────────

type ActiveStateProps = {
  feed: CalendarFeed;
  language: Language;
  busy: Action;
  error: string | null;
  copied: boolean;
  onCopy: () => void;
  onRotate: () => void;
  onRemove: () => void;
};

function ActiveState({ feed, language, busy, error, copied, onCopy, onRotate, onRemove }: ActiveStateProps) {
  const anyBusy = busy !== null;
  return (
    <div className="calendar-feed-active">
      <div className="calendar-feed-primary">
        <a className="calendar-feed-open-btn" href={feed.webcal_url}>
          Im Kalender öffnen
        </a>
        <span className="calendar-feed-primary-hint">Öffnet die Kalender-App und bietet das Abo an.</span>
      </div>

      <div className="calendar-feed-link-row">
        <label className="calendar-feed-link-label" htmlFor={LINK_INPUT_ID}>
          Abo-Link (https)
        </label>
        <div className="calendar-feed-link-fields">
          <input
            id={LINK_INPUT_ID}
            type="text"
            readOnly
            value={feed.url}
            className="calendar-feed-link-input"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="calendar-feed-copy-btn" onClick={onCopy}>
            {copied ? "Kopiert" : "Link kopieren"}
          </button>
        </div>
      </div>

      <p className="calendar-feed-status">
        <FetchStatus feed={feed} language={language} />
      </p>

      {error && <p className="calendar-feed-error">{error}</p>}

      <div className="calendar-feed-actions">
        <button type="button" className="calendar-feed-secondary-btn" disabled={anyBusy} onClick={onRotate}>
          {busy === "rotate" ? "Wird erzeugt…" : "Link neu erzeugen"}
        </button>
        <button
          type="button"
          className="calendar-feed-secondary-btn calendar-feed-secondary-btn--danger"
          disabled={anyBusy}
          onClick={onRemove}
        >
          {busy === "remove" ? "Wird entfernt…" : "Abo entfernen"}
        </button>
      </div>

      <HowTo />
    </div>
  );
}

function FetchStatus({ feed, language }: { feed: CalendarFeed; language: Language }) {
  if (!feed.last_fetched_at) {
    return <>Noch nicht abgerufen — den Link im Kalender eintragen.</>;
  }
  const agent = friendlyFetchAgent(feed.last_fetch_agent);
  const parts = [
    `Zuletzt abgerufen: ${formatFetchedAt(feed.last_fetched_at, language)}`,
    ...(agent ? [agent] : []),
    fetchCountLabel(feed.fetch_count),
  ];
  return <>{parts.join(" · ")}</>;
}

// ── How-to ────────────────────────────────────────────────────────────────

function HowTo() {
  return (
    <details className="calendar-feed-howto">
      <summary className="calendar-feed-howto-summary">So richtest du es ein</summary>
      <div className="calendar-feed-howto-body">
        <section className="calendar-feed-howto-item">
          <h3 className="calendar-feed-howto-title">iPhone / iPad</h3>
          <p className="calendar-feed-howto-text">
            &bdquo;Im Kalender öffnen&ldquo; antippen, dann <strong>Abonnieren</strong>. Oder von Hand: Einstellungen →
            Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo hinzufügen, den Link einfügen.
          </p>
        </section>
        <section className="calendar-feed-howto-item">
          <h3 className="calendar-feed-howto-title">Google Kalender</h3>
          <p className="calendar-feed-howto-text">
            Am PC: calendar.google.com → Weitere Kalender &bdquo;+&ldquo; → Per URL → den https-Link einfügen. Google
            aktualisiert Abos nur etwa alle 12–24 Stunden.
          </p>
        </section>
        <section className="calendar-feed-howto-item">
          <h3 className="calendar-feed-howto-title">Outlook</h3>
          <p className="calendar-feed-howto-text">
            Kalender hinzufügen → Aus dem Internet abonnieren → den https-Link einfügen.
          </p>
        </section>
      </div>
    </details>
  );
}
