/**
 * AdminDashboardDefaultsPanel — the Verwaltungszentrum tab „Startseiten“.
 *
 * Sets the start page each role begins with, once per device class
 * (docs/DASHBOARD.md §8.6). A role default applies to users who have not
 * arranged their own page for that device, and to anyone who resets theirs;
 * nobody's customised layout is overwritten (the intro says so, because that
 * is the first thing an admin asks).
 *
 * Three things here are deliberate:
 *
 *   The editor is the same DashboardEditor the users get (D12), rendered in a
 *   frame of the device's real width — 390 / 820 / 1280 px — and told the
 *   device, so a phone layout shows one column even on the admin's desktop
 *   (D10). The frame scrolls sideways in its own container, because the page
 *   root clips anything wider than the screen (`overflow-x: clip`).
 *
 *   Every catalog widget may be placed for every role. The server accepts a
 *   widget the role cannot see, stores it, and lists it in `hidden_for_role`
 *   (D7); here that becomes a marker on the tile rather than a refusal, so an
 *   admin can prepare a default before granting the permission.
 *
 *   Switching role or device with unsaved changes asks first. The draft lives
 *   only in this component, and a switch replaces it with the stored layout of
 *   the new selection.
 *
 * Styles are module constants rather than a stylesheet: this part owns no
 * sheet (§9.6), and the few rules it needs ride in this lazy chunk with it.
 */
import { useCallback, useEffect, useId, useMemo, useState, type CSSProperties } from "react";

import { useAppContext } from "../../context/AppContext";
import type { Language } from "../../types";
import {
  DASHBOARD_DEVICES,
  DASHBOARD_WIDGET_IDS,
  type DashboardCatalogEntry,
  type DashboardDevice,
  type DashboardRoleDefault,
  type DashboardRoleDefaults,
  type DashboardWidgetId,
  type DashboardWidgetItem,
  type DashboardWidgetSize,
} from "../../types/dashboard";
import {
  dashboardErrorDetail,
  fetchDashboardRoleDefaults,
  resetDashboardRoleDefault,
  saveDashboardRoleDefault,
} from "../../utils/dashboardApi";
import { roleLabel } from "../../utils/roles";
import { DashboardEditor } from "../dashboard/DashboardEditor";

type Selection = { role: string; device: DashboardDevice };
type Feedback = { ok: boolean; text: string };

/** §8.6: a common phone, an iPad Air in portrait, the desktop breakpoint (D9). */
const PREVIEW_WIDTH_PX: Readonly<Record<DashboardDevice, number>> = { mobile: 390, tablet: 820, desktop: 1280 };

const DEVICE_LABELS: Readonly<Record<DashboardDevice, { de: string; en: string }>> = {
  mobile: { de: "Handy", en: "Phone" },
  tablet: { de: "Tablet", en: "Tablet" },
  desktop: { de: "Desktop", en: "Desktop" },
};

/** Admins arrange defaults at a desk; the desktop layout is the one most seen. */
const INITIAL_DEVICE: DashboardDevice = "desktop";
const FALLBACK_SIZE: DashboardWidgetSize = "medium";
const KNOWN_IDS: ReadonlySet<string> = new Set<string>(DASHBOARD_WIDGET_IDS);

const PICKERS_STYLE: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 };
const PICKER_STYLE: CSSProperties = { flex: "1 1 180px", maxWidth: 260 };
const STATUS_ROW_STYLE: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 };
const BADGE_STYLE: Readonly<Record<"custom" | "factory", CSSProperties>> = {
  custom: { background: "var(--accent)", color: "#fff", border: "1px solid var(--accent)" },
  factory: { background: "var(--surface-2)", color: "var(--muted)", border: "1px solid var(--line)" },
};
// `contain: inline-size` keeps the 1280 px frame from widening the card and
// the admin grid around it; only this container scrolls.
const PREVIEW_SCROLL_STYLE: CSSProperties = {
  overflowX: "auto",
  maxWidth: "100%",
  minWidth: 0,
  contain: "inline-size",
  paddingBottom: 8,
};
const PREVIEW_FRAME_STYLE: CSSProperties = {
  boxSizing: "border-box",
  flex: "none",
  padding: 12,
  border: "1px dashed var(--line)",
  borderRadius: "var(--radius)",
  background: "var(--bg)",
};

function isKnownId(id: string): id is DashboardWidgetId {
  return KNOWN_IDS.has(id);
}

/** Drops ids this build has no tile for (a newer server); the editor looks every id up. */
function knownWidgets(widgets: readonly DashboardWidgetItem[]): DashboardWidgetItem[] {
  return widgets.filter((widget) => isKnownId(widget.id));
}

function sameViews(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((view, index) => view === right[index]);
}

/** Order, sizes and tile lists equal; a missing `settings` equals an empty one. */
function sameWidgets(a: readonly DashboardWidgetItem[], b: readonly DashboardWidgetItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return item.id === other.id && item.size === other.size && sameViews(item.settings?.views, other.settings?.views);
    })
  );
}

function findDefault(data: DashboardRoleDefaults, selection: Selection): DashboardRoleDefault | null {
  return data.defaults.find((entry) => entry.role === selection.role && entry.device === selection.device) ?? null;
}

/** A new response object with the one saved or reset entry swapped in. */
function replaceDefault(data: DashboardRoleDefaults | null, next: DashboardRoleDefault): DashboardRoleDefaults | null {
  if (!data) return data;
  const replaced = data.defaults.map((entry) =>
    entry.role === next.role && entry.device === next.device ? next : entry,
  );
  return { ...data, defaults: replaced };
}

/**
 * What the role cannot see, from every device's answer for that role: the
 * permission is the role's, not the device's, so a widget the phone default
 * reported hidden is marked on the desktop draft too, before any save.
 */
function hiddenIdsForRole(data: DashboardRoleDefaults | null, role: string | null): ReadonlySet<DashboardWidgetId> {
  if (!data || role === null) return new Set();
  const ids = data.defaults.filter((entry) => entry.role === role).flatMap((entry) => entry.hidden_for_role);
  return new Set(ids.filter(isKnownId));
}

function availableIdsOf(catalog: readonly DashboardCatalogEntry[]): DashboardWidgetId[] {
  return catalog.map((entry) => entry.id).filter(isKnownId);
}

function defaultSizesOf(catalog: readonly DashboardCatalogEntry[]): Record<DashboardWidgetId, DashboardWidgetSize> {
  const fromCatalog = new Map(catalog.map((entry) => [entry.id, entry.default_size]));
  return Object.fromEntries(
    DASHBOARD_WIDGET_IDS.map((id) => [id, fromCatalog.get(id) ?? FALLBACK_SIZE]),
  ) as Record<DashboardWidgetId, DashboardWidgetSize>;
}

function saveErrorText(error: unknown, de: boolean): string {
  const base = de ? "Konnte nicht gespeichert werden." : "Could not be saved.";
  // The server's own sentence for a refused layout (German, §3.1); anything
  // else — offline, a 500, FastAPI's list detail — is the bare line.
  const detail = dashboardErrorDetail(error);
  return detail ? `${base} ${detail.message}` : base;
}

/** The roles and widget catalog, fetched once per mount and again on „Erneut versuchen“. */
function useRoleDefaults(token: string | null) {
  const [data, setData] = useState<DashboardRoleDefaults | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchDashboardRoleDefaults(token).then(
      (next) => {
        if (!cancelled) setData(next);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  return { data, setData, failed, retry };
}

function DiscardDialog({
  language,
  onCancel,
  onDiscard,
}: {
  language: Language;
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const titleId = useId();
  const de = language === "de";
  return (
    <div
      className="admin-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="admin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      >
        <h3 id={titleId} className="admin-dialog-title">
          {de ? "Ungespeicherte Änderungen verwerfen?" : "Discard unsaved changes?"}
        </h3>
        <div className="admin-dialog-actions">
          {/* The safe answer has the focus: Enter keeps the draft. */}
          <button type="button" className="ghost" onClick={onCancel} autoFocus>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button type="button" className="admin-dialog-danger" onClick={onDiscard}>
            {de ? "Verwerfen" : "Discard"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectionPickers({
  roles,
  selection,
  disabled,
  language,
  onPick,
}: {
  roles: readonly string[];
  selection: Selection;
  disabled: boolean;
  language: Language;
  onPick: (next: Selection) => void;
}) {
  const de = language === "de";
  return (
    <div style={PICKERS_STYLE}>
      <label className="admin-invite-field" style={PICKER_STYLE}>
        <span className="admin-invite-field-label">{de ? "Rolle" : "Role"}</span>
        <select
          className="admin-invite-input"
          value={selection.role}
          disabled={disabled}
          onChange={(event) => onPick({ ...selection, role: event.target.value })}
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {roleLabel(role, language)}
            </option>
          ))}
        </select>
      </label>
      <label className="admin-invite-field" style={PICKER_STYLE}>
        <span className="admin-invite-field-label">{de ? "Gerät" : "Device"}</span>
        <select
          className="admin-invite-input"
          value={selection.device}
          disabled={disabled}
          onChange={(event) => onPick({ ...selection, device: event.target.value as DashboardDevice })}
        >
          {DASHBOARD_DEVICES.map((device) => (
            <option key={device} value={device}>
              {de ? DEVICE_LABELS[device].de : DEVICE_LABELS[device].en}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function AdminDashboardDefaultsPanel() {
  const { token, language } = useAppContext();
  const { data, setData, failed, retry } = useRoleDefaults(token);
  const [picked, setPicked] = useState<Selection | null>(null);
  // null = untouched: the stored layout of the selection is what shows.
  const [draft, setDraft] = useState<DashboardWidgetItem[] | null>(null);
  const [pending, setPending] = useState<Selection | null>(null);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const de = language === "de";
  const selection: Selection | null =
    picked ?? (data ? { role: data.roles[0] ?? "employee", device: INITIAL_DEVICE } : null);
  const current = data && selection ? findDefault(data, selection) : null;
  const stored = useMemo(() => knownWidgets(current?.widgets ?? []), [current]);
  const widgets = draft ?? stored;
  const dirty = draft !== null && !sameWidgets(draft, stored);

  const availableIds = useMemo(() => availableIdsOf(data?.catalog ?? []), [data]);
  const defaultSizes = useMemo(() => defaultSizesOf(data?.catalog ?? []), [data]);
  const hiddenIds = useMemo(() => hiddenIdsForRole(data, selection?.role ?? null), [data, selection?.role]);

  const applySelection = useCallback((next: Selection) => {
    setPicked(next);
    setDraft(null);
    setPending(null);
    setFeedback(null);
  }, []);

  const pick = (next: Selection) => {
    if (selection && next.role === selection.role && next.device === selection.device) return;
    if (dirty) {
      setPending(next);
      return;
    }
    applySelection(next);
  };

  const changeDraft = (next: DashboardWidgetItem[]) => {
    setDraft(next);
    setFeedback(null);
  };

  const write = async (kind: "save" | "reset") => {
    if (!selection || busy) return;
    const sent = widgets;
    setBusy(kind);
    setFeedback(null);
    try {
      const answer =
        kind === "save"
          ? await saveDashboardRoleDefault(token, selection.role, selection.device, { version: 1, widgets: sent })
          : await resetDashboardRoleDefault(token, selection.role, selection.device);
      // The answer is the new baseline (and carries the new hidden list). The
      // editor stays live during a save, so a tile moved meanwhile is a newer
      // draft and survives; a reset means "throw the draft away" either way.
      setData((prev) => replaceDefault(prev, answer));
      setDraft((prev) => (kind === "save" && prev !== null && !sameWidgets(prev, sent) ? prev : null));
      setFeedback({ ok: true, text: de ? "Gespeichert." : "Saved." });
    } catch (error) {
      setFeedback({ ok: false, text: saveErrorText(error, de) });
    } finally {
      setBusy(null);
    }
  };

  const customised = current?.source === "role";

  return (
    <div className="admin-page-card" style={{ minWidth: 0 }}>
      <h2 className="admin-page-card-title">{de ? "Standard-Startseiten je Rolle" : "Default start pages per role"}</h2>
      <p className="admin-tools-desc">
        {de
          ? "Neue und zurückgesetzte Startseiten beginnen mit diesem Stand. Wer seine Startseite schon angepasst hat, behält sie."
          : "New and reset start pages begin with this layout. Anyone who has already customised their start page keeps it."}
      </p>

      {!data && !failed && <p className="admin-page-muted">{de ? "Lade…" : "Loading…"}</p>}

      {!data && failed && (
        <div className="admin-settings-status">
          <span className="admin-settings-status-dot" />
          {de ? "Standard-Startseiten konnten nicht geladen werden." : "Default start pages could not be loaded."}
          <button type="button" className="admin-invite-submit admin-invite-submit--secondary" onClick={retry}>
            {de ? "Erneut versuchen" : "Try again"}
          </button>
        </div>
      )}

      {data && selection && (
        <>
          <SelectionPickers
            roles={data.roles}
            selection={selection}
            disabled={busy !== null}
            language={language}
            onPick={pick}
          />

          <div style={STATUS_ROW_STYLE}>
            <span className="admin-badge" style={customised ? BADGE_STYLE.custom : BADGE_STYLE.factory}>
              {customised ? (de ? "Angepasst" : "Customised") : de ? "Werkseinstellung" : "Factory default"}
            </span>
            <div className="admin-settings-form-actions">
              <button
                type="button"
                className="admin-invite-submit"
                disabled={!dirty || busy !== null}
                onClick={() => void write("save")}
              >
                {busy === "save" ? (de ? "Speichern…" : "Saving…") : de ? "Speichern" : "Save"}
              </button>
              <button
                type="button"
                className="admin-invite-submit admin-invite-submit--secondary"
                disabled={!customised || busy !== null}
                onClick={() => void write("reset")}
              >
                {de ? "Auf Werkseinstellung zurücksetzen" : "Reset to factory default"}
              </button>
            </div>
          </div>

          <div role="status" aria-live="polite" className={feedback ? "admin-settings-status" : undefined}>
            {feedback && (
              <>
                <span
                  className={`admin-settings-status-dot${feedback.ok ? " admin-settings-status-dot--ok" : ""}`}
                />
                {feedback.text}
              </>
            )}
          </div>

          <div className="admin-dashboard-preview-scroll" style={PREVIEW_SCROLL_STYLE}>
            <div
              className="admin-dashboard-preview"
              data-device={selection.device}
              role="group"
              aria-label={`${de ? "Vorschau" : "Preview"}: ${
                de ? DEVICE_LABELS[selection.device].de : DEVICE_LABELS[selection.device].en
              }, ${PREVIEW_WIDTH_PX[selection.device]} px`}
              style={{ ...PREVIEW_FRAME_STYLE, width: PREVIEW_WIDTH_PX[selection.device] }}
            >
              <DashboardEditor
                device={selection.device}
                widgets={widgets}
                onChange={changeDraft}
                availableIds={availableIds}
                defaultSizes={defaultSizes}
                hiddenIds={hiddenIds}
                language={language}
              />
            </div>
          </div>
        </>
      )}

      {pending && (
        <DiscardDialog language={language} onCancel={() => setPending(null)} onDiscard={() => applySelection(pending)} />
      )}
    </div>
  );
}
