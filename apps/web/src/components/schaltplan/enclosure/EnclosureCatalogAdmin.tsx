/**
 * "Schrankkatalog" — the Werkstatt's list of Hager univers Z cabinets and
 * field modules (docs/PANEL_ENCLOSURE.md §3.3, §3.5, §7, §10.2, §11).
 *
 * Mounted as one sheet of the Schrank tab's stack: ModulePickerSheet's
 * "Katalog verwalten" pushes it, and "Eintrag anlegen" on a shelf article
 * the catalogue lacks pushes it with `create`, which opens the form
 * prefilled. It renders a `SheetFrame` and no backdrop, like every sheet of
 * the stack; anywhere else, render one `SheetBackdrop` next to it.
 *
 * Writes need `werkstatt:manage`, which the server enforces and reports as
 * `catalog.can_manage`. Without it there is no admin at all — no list, no
 * buttons, one sentence saying who keeps the catalogue.
 *
 * Codes are never deleted (§3.5): a custom entry is archived (hidden from
 * the pickers, still resolving for every board that names it), a changed
 * built-in can go back to the Hager standard. One write at a time; each is
 * followed by `onChanged()` (the shared catalogue's reload) so the pickers
 * see it, and the list shows what the server answered even when that
 * reload fails — the hook keeps its old copy then.
 *
 * The form is the one sheet whose state does not autosave, so leaving it
 * is one step and asks first: ‹, Escape and a tap on the backdrop all go
 * back to the list (the admin hands the stack that step through
 * `setBackHandler`), and with typed changes ‹, Escape, the backdrop and ×
 * ask "Eingaben verwerfen?" before anything is dropped.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import { CatalogEntryForm } from "./CatalogEntryForm";
import { ConfirmStrip, SheetFrame, SheetSection, UnverifiedBadge } from "./EnclosureSheetFrame";
import {
  blankDraft,
  draftFromSpec,
  draftFromUncatalogued,
  usedByText,
  type AnySpec,
  type CatalogDraft,
} from "./catalogEntryDraft";
import { createCatalogEntry, resetCatalogEntry, setCatalogEntryArchived, updateCatalogEntry } from "../../../utils/schaltplanEnclosureApi";
import type {
  CatalogEntry,
  CatalogEntryIn,
  CatalogEntryType,
  CatalogSource,
  EnclosureCatalog,
  EnclosureSpec,
  ModuleSpec,
  UncataloguedArticle,
} from "../../../types/panelEnclosure";
import "../../../styles/schaltplan-enclosure-admin.css";

export interface EnclosureCatalogAdminProps {
  token: string | null;
  /** The shared catalogue (useEnclosureCatalog). Its `can_manage` decides whether there is an admin. */
  catalog: EnclosureCatalog;
  /** After every write: reload the shared catalogue (useEnclosureCatalog's `reload`). */
  onChanged: () => Promise<void>;
  onClose: () => void;
  /** The sheet below in the stack, when there is one. */
  onBack?: () => void;
  /** Open the form prefilled for this shelf article ("Eintrag anlegen" in the module picker). */
  create?: UncataloguedArticle | null;
  /** The sheet stack's hook for a sheet's own back step (`SheetStack.setBackHandler`): the form takes it while open. */
  setBackHandler?: (handler: (() => void) | null) => void;
}

type AnyEntry = CatalogEntry<EnclosureSpec | ModuleSpec>;

type Editing =
  | { mode: "create"; draft: CatalogDraft }
  | { mode: "edit"; entry: AnyEntry; draft: CatalogDraft; original: AnySpec | null };

/** What the server answered to this session's writes, over the catalogue they were made against. */
type Written = { base: EnclosureCatalog; entries: ReadonlyMap<string, AnyEntry> };

const SOURCE_LABELS: Readonly<Record<CatalogSource, string>> = {
  builtin: "Hager-Standard",
  override: "angepasst",
  custom: "eigener Eintrag",
};
const NOT_MANAGER = "Den Schrankkatalog pflegt die Werkstatt.";
const BROKEN = "Der gespeicherte Aufbau ist fehlerhaft — bitte neu erfassen. Schlüssel, die Verteilerpläne verwenden, müssen dabei bleiben.";
const NO_ENTRIES: ReadonlyMap<string, AnyEntry> = new Map();
export const DISCARD_QUESTION = "Eingaben verwerfen? Der Eintrag ist noch nicht gespeichert.";

function errorText(failure: unknown): string {
  return failure instanceof Error && failure.message ? failure.message : "Das hat nicht geklappt — Verbindung prüfen und noch einmal versuchen.";
}

// ── List model ───────────────────────────────────────────────────────────────

function merged(list: readonly AnyEntry[] | undefined, written: ReadonlyMap<string, AnyEntry>, type: CatalogEntryType): AnyEntry[] {
  const own = list ?? [];
  const known = new Set(own.map((entry) => entry.code));
  const added = [...written.values()].filter((entry) => entry.entry_type === type && !known.has(entry.code));
  const all = [...own.map((entry) => written.get(entry.code) ?? entry), ...added];
  // Archived ones last: they are what the admin looks for least.
  return [...all.filter((entry) => !entry.archived), ...all.filter((entry) => entry.archived)];
}

function matches(entry: AnyEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || `${entry.code} ${entry.spec?.name ?? ""}`.toLowerCase().includes(needle);
}

function editingFor(entry: AnyEntry): Editing {
  if (!entry.spec) return { mode: "edit", entry, draft: { ...blankDraft(entry.entry_type), code: entry.code }, original: null };
  return { mode: "edit", entry, draft: draftFromSpec(entry.entry_type, entry.spec), original: entry.spec };
}

const safeSource = (url: string | null | undefined) => (typeof url === "string" && /^https:\/\/[^\s/]+\S*$/.test(url) ? url : null);

// ── One entry ────────────────────────────────────────────────────────────────

type ItemProps = {
  entry: AnyEntry;
  busy: boolean;
  confirming: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onAskReset: () => void;
  onReset: () => void;
  onCancelReset: () => void;
};

function EntryItem({ entry, busy, confirming, onEdit, onArchive, onAskReset, onReset, onCancelReset }: ItemProps) {
  const name = entry.spec?.name ?? "";
  const facts = [
    SOURCE_LABELS[entry.source] ?? entry.source,
    entry.archived ? "archiviert" : "",
    entry.invalid ? "fehlerhaft" : "",
    entry.used_by_plans > 0 ? usedByText(entry.used_by_plans) : "",
    entry.stock_available > 0 ? `${entry.stock_available} im Lager` : "",
  ].filter(Boolean);
  const source = safeSource(entry.spec?.source_url);
  return (
    <li className={`sp-encl-admin-item${entry.archived ? " sp-encl-admin-item--archived" : ""}`} aria-label={name ? `${entry.code} · ${name}` : entry.code}>
      <div className="sp-encl-admin-item-head">
        <span className="sp-palette-text">
          <b>{entry.code}</b>
          {name ? <small>{name}</small> : null}
          <small className="sp-encl-admin-facts">{facts.join(" · ")}</small>
        </span>
        {entry.spec && !entry.spec.verified ? <UnverifiedBadge /> : null}
      </div>
      {confirming ? (
        <ConfirmStrip
          question={`Auf Hager-Standard zurücksetzen? Die Änderungen an ${entry.code} gehen verloren.`}
          confirmLabel="Ja, zurücksetzen"
          onConfirm={onReset}
          onCancel={onCancelReset}
        />
      ) : (
        <div className="sp-encl-admin-actions">
          <button type="button" className="sp-btn sp-encl-target" disabled={busy} onClick={onEdit}>
            Bearbeiten
          </button>
          <button type="button" className="sp-btn sp-encl-target" disabled={busy} onClick={onArchive}>
            {entry.archived ? "Wiederherstellen" : "Archivieren"}
          </button>
          {entry.source === "override" ? (
            <button type="button" className="sp-btn sp-encl-target" disabled={busy} onClick={onAskReset}>
              Auf Hager-Standard zurücksetzen
            </button>
          ) : null}
          {source ? (
            <a className="sp-btn sp-btn--ghost sp-encl-target" href={source} target="_blank" rel="noreferrer noopener">
              Quelle
            </a>
          ) : null}
        </div>
      )}
    </li>
  );
}

type SectionProps = { title: string; entries: AnyEntry[]; render: (entry: AnyEntry) => ReactElement };

function EntrySection({ title, entries, render }: SectionProps) {
  return (
    <SheetSection title={`${title} (${entries.length})`}>
      {entries.length > 0 ? <ul className="sp-encl-admin-list">{entries.map(render)}</ul> : <p className="sp-encl-empty">Kein Treffer.</p>}
    </SheetSection>
  );
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** Where leaving the form goes: back to the list, or out of the stack (×). */
type Leave = "back" | "close";

/**
 * While the form is open, hand the stack its back step (`leave("back")`),
 * so Escape and the backdrop return to the list as ‹ does.
 */
function useFormBackStep(formOpen: boolean, leave: (to: Leave) => void, setBackHandler: EnclosureCatalogAdminProps["setBackHandler"]) {
  const latest = useRef(leave);
  useEffect(() => {
    latest.current = leave;
  });
  useEffect(() => {
    if (!formOpen || !setBackHandler) return undefined;
    setBackHandler(() => latest.current("back"));
    return () => setBackHandler(null);
  }, [formOpen, setBackHandler]);
}

export function EnclosureCatalogAdmin({ token, catalog, onChanged, onClose, onBack, create = null, setBackHandler }: EnclosureCatalogAdminProps) {
  const [editing, setEditing] = useState<Editing | null>(() => (create ? { mode: "create", draft: draftFromUncatalogued(create) } : null));
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState<Leave | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const [written, setWritten] = useState<Written | null>(null);
  const overlay = written && written.base === catalog ? written.entries : NO_ENTRIES;
  const enclosures = useMemo(() => merged(catalog.enclosures, overlay, "enclosure"), [catalog.enclosures, overlay]);
  const modules = useMemo(() => merged(catalog.modules, overlay, "module"), [catalog.modules, overlay]);
  const templates = useMemo(() => [...modules, ...enclosures], [modules, enclosures]);

  const run = async (action: () => Promise<AnyEntry>, message: (entry: AnyEntry) => string, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const entry = await action();
      setWritten((previous) => {
        const kept = previous && previous.base === catalog ? previous.entries : NO_ENTRIES;
        return { base: catalog, entries: new Map([...kept, [entry.code, entry]]) };
      });
      after?.();
      // A failed reload keeps the hook's old copy; the overlay above still shows the answer.
      await onChanged().catch(() => undefined);
      setStatus(message(entry));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const open = (next: Editing | null) => {
    setEditing(next);
    setDirty(false);
    setDiscard(null);
    setError(null);
    setStatus(null);
    setConfirmReset(null);
  };
  /** Leave the form — at once when nothing was typed, else after "Ja, verwerfen". */
  const leave = (to: Leave, confirmed = false) => {
    if (dirty && !confirmed) {
      setDiscard(to);
      return;
    }
    if (to === "close") onClose();
    else open(null);
  };
  useFormBackStep(editing !== null && catalog.can_manage === true, leave, setBackHandler);
  const submit = (body: CatalogEntryIn) => {
    if (!editing) return;
    const close = () => {
      setEditing(null);
      setDirty(false);
      setDiscard(null);
    };
    if (editing.mode === "create") void run(() => createCatalogEntry(token, body), (entry) => `${entry.code} angelegt.`, close);
    else void run(() => updateCatalogEntry(token, editing.entry.code, body), (entry) => `${entry.code} gespeichert.`, close);
  };
  const archive = (entry: AnyEntry) =>
    void run(
      () => setCatalogEntryArchived(token, entry.code, !entry.archived),
      (result) => `${result.code} ${result.archived ? "archiviert" : "wiederhergestellt"}.`,
    );
  const reset = (entry: AnyEntry) => {
    setConfirmReset(null);
    void run(() => resetCatalogEntry(token, entry.code), (result) => `${result.code} auf Hager-Standard zurückgesetzt.`);
  };

  if (!catalog.can_manage) {
    return (
      <SheetFrame key="denied" title="Schrankkatalog" onBack={onBack} onClose={onClose} className="sp-encl-admin">
        <p className="sp-encl-hint">{NOT_MANAGER}</p>
      </SheetFrame>
    );
  }

  if (editing) {
    const title = editing.mode === "create" ? "Eintrag anlegen" : `${editing.entry.code} bearbeiten`;
    const subtitle = editing.mode === "edit" ? SOURCE_LABELS[editing.entry.source] : undefined;
    return (
      // Keyed apart from the list: a fresh sheet body starts at the top, not at the list's scroll position.
      <SheetFrame
        key="form"
        title={title}
        subtitle={subtitle}
        onBack={() => leave("back")}
        onClose={() => leave("close")}
        className="sp-encl-admin sp-encl-admin--form"
        footer={
          discard ? (
            <ConfirmStrip
              question={DISCARD_QUESTION}
              confirmLabel="Ja, verwerfen"
              cancelLabel="Weiter bearbeiten"
              onConfirm={() => leave(discard, true)}
              onCancel={() => setDiscard(null)}
            />
          ) : undefined
        }
      >
        {editing.mode === "edit" && !editing.entry.spec ? <p className="sp-encl-note">{BROKEN}</p> : null}
        <CatalogEntryForm
          key={editing.mode === "edit" ? `edit:${editing.entry.code}` : "create"}
          mode={editing.mode}
          initialDraft={editing.draft}
          original={editing.mode === "edit" ? editing.original : null}
          usedByPlans={editing.mode === "edit" ? editing.entry.used_by_plans : 0}
          templates={templates}
          busy={busy}
          error={error}
          onSubmit={submit}
          onCancel={() => open(null)}
          onDirtyChange={setDirty}
        />
      </SheetFrame>
    );
  }

  const item = (entry: AnyEntry) => (
    <EntryItem
      key={entry.code}
      entry={entry}
      busy={busy}
      confirming={confirmReset === entry.code}
      onEdit={() => open(editingFor(entry))}
      onArchive={() => archive(entry)}
      onAskReset={() => setConfirmReset(entry.code)}
      onReset={() => reset(entry)}
      onCancelReset={() => setConfirmReset(null)}
    />
  );
  return (
    <SheetFrame key="list" title="Schrankkatalog" subtitle="Hager univers Z" onBack={onBack} onClose={onClose} className="sp-encl-admin">
      <div className="sp-encl-admin-toolbar">
        <button type="button" className="sp-btn sp-btn--primary sp-encl-target" disabled={busy} onClick={() => open({ mode: "create", draft: blankDraft("module") })}>
          Eintrag anlegen
        </button>
        <SearchField value={query} onChange={setQuery} />
      </div>
      {error ? (
        <p role="alert" className="sp-encl-admin-message sp-encl-admin-message--error">
          {error}
        </p>
      ) : null}
      <p role="status" className="sp-encl-admin-message">
        {status ?? ""}
      </p>
      <EntrySection title="Schränke" entries={enclosures.filter((entry) => matches(entry, query))} render={item} />
      <EntrySection title="Module" entries={modules.filter((entry) => matches(entry, query))} render={item} />
    </SheetFrame>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="sp-field sp-encl-admin-search">
      <label className="sp-field-label" htmlFor={id}>
        Suchen
      </label>
      <input
        id={id}
        type="search"
        value={value}
        placeholder="Code oder Bezeichnung"
        autoCapitalize="characters"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
