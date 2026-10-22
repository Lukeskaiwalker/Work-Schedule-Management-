import { Suspense, useEffect, useRef, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import { useDashboardDevice } from "../../hooks/useDashboardDevice";
import { useDashboardLayouts, type DashboardLayoutsState } from "../../hooks/useDashboardLayouts";
import {
  DASHBOARD_WIDGET_IDS,
  type DashboardDevice,
  type DashboardWidgetId,
  type DashboardWidgetItem,
} from "../../types/dashboard";
import { dashboardErrorDetail } from "../../utils/dashboardApi";
import { clearDraft, rememberDraft, takeDraft } from "../../utils/dashboardDrafts";
import { pruneWidgets, sameLayout } from "../../utils/dashboardLayout";
import { onDashboardResourceForbidden } from "../../utils/dashboardResourceStore";
// Type only: the edit mode itself stays in its own lazy chunk.
import type { DashboardEditModeProps } from "./DashboardEditMode";
import { DashboardGrid, DashboardGridItem } from "./DashboardGrid";
import { DashboardLoadBoundary } from "./DashboardLoadBoundary";
import { DashboardWidgetBoundary } from "./DashboardWidgetBoundary";
import { DashboardWidgetFrame } from "./DashboardWidgetFrame";
import { retryableLazy } from "./retryableLazy";
import { DASHBOARD_DEVICE_LABEL, DASHBOARD_WIDGET_META } from "./widgetMeta";
import { getLazyWidget } from "./widgetRegistry";
import "../../styles/dashboard.css";

/**
 * The personal start page (docs/DASHBOARD.md §8, §9.1).
 *
 * Live mode renders the layout of the device this screen is (D9) in the grid
 * of that device (D10), each widget lazy and inside its own error boundary.
 * „Anpassen“ loads the edit mode as its own chunk and freezes the device:
 * the draft keeps saving into the layout it started on whatever the window
 * does meanwhile, so rotating a tablet mid-edit cannot overwrite the desktop
 * layout. A draft left behind by navigating away is kept in memory and
 * reopened on return (dashboardDrafts.ts). An edit-mode chunk that fails to
 * download stays a notice on this page, with a retry that downloads it again.
 */
const getDashboardEditMode = retryableLazy<DashboardEditModeProps>(() =>
  import("./DashboardEditMode").then((module) => ({ default: module.DashboardEditMode })),
);

type EditSession = { device: DashboardDevice; draft: DashboardWidgetItem[]; restored: boolean };

const KNOWN_IDS: ReadonlySet<DashboardWidgetId> = new Set(DASHBOARD_WIDGET_IDS);

/** What this build can show as a tile. An id from a newer server has no metadata and is left out of the draft. */
function knownWidgets(widgets: readonly DashboardWidgetItem[]): DashboardWidgetItem[] {
  return pruneWidgets(widgets, KNOWN_IDS);
}

function restoredSession(userId: number | null, device: DashboardDevice): EditSession | null {
  if (userId === null) return null;
  const draft = takeDraft(userId, device);
  return draft ? { device, draft: knownWidgets(draft), restored: true } : null;
}

function titleOf(id: DashboardWidgetId, de: boolean): string {
  const meta = DASHBOARD_WIDGET_META[id];
  if (!meta) return id;
  return de ? meta.title.de : meta.title.en;
}

/**
 * Keeps a dirty draft for a return visit; a clean one is not worth reopening.
 *
 * Only while the session is live and the server has confirmed the layout the
 * draft is compared with. When the session ends the host renders once or
 * twice more before it unmounts — without a token (no layouts), or with the
 * old one and a layouts entry re-seeded from localStorage — and remembering
 * the draft then would hand it to the next sign-in on a shared tablet after
 * the session end had cleared it.
 */
function useDraftMemory(
  userId: number | null,
  token: string | null,
  editing: EditSession | null,
  layouts: Pick<DashboardLayoutsState, "state" | "confirmed">,
): void {
  const { state, confirmed } = layouts;
  useEffect(() => {
    if (userId === null || !token || !editing || !state || !confirmed) return;
    const loaded = knownWidgets(state.layouts[editing.device].widgets);
    if (sameLayout(editing.draft, loaded)) clearDraft(userId, editing.device);
    else rememberDraft(userId, editing.device, editing.draft);
  }, [userId, token, editing, state, confirmed]);
}

/**
 * A widget whose data answers 403 shows „Keine Berechtigung.“; the layouts
 * are then fetched again, once per visit, which normally removes it (§8.1).
 */
function useRefetchOnForbidden(userId: number | null, reload: () => Promise<unknown>): void {
  const refetched = useRef(false);
  useEffect(() => {
    if (userId === null) return undefined;
    return onDashboardResourceForbidden(userId, () => {
      if (refetched.current) return;
      refetched.current = true;
      void reload();
    });
  }, [userId, reload]);
}

function WidgetSlot({ item, device, de }: { item: DashboardWidgetItem; device: DashboardDevice; de: boolean }) {
  // Bumped by „Erneut versuchen“: remounts the boundary and asks the registry
  // again, which builds a fresh lazy component if the download had failed.
  const [attempt, setAttempt] = useState(0);
  const Widget = getLazyWidget(item.id);
  const title = titleOf(item.id, de);
  if (!Widget) return null;
  return (
    <DashboardWidgetBoundary
      key={attempt}
      widgetId={item.id}
      title={title}
      onRetry={() => setAttempt((count) => count + 1)}
    >
      <Suspense fallback={<DashboardWidgetFrame title={title} state={{ loading: true, error: null }} />}>
        <Widget size={item.size} settings={item.settings ?? null} device={device} />
      </Suspense>
    </DashboardWidgetBoundary>
  );
}

export function DashboardHost(): JSX.Element {
  const { token, user, language } = useAppContext();
  const userId = user?.id ?? null;
  const de = language === "de";
  const liveDevice = useDashboardDevice();
  const layouts = useDashboardLayouts(token, userId);
  const [editing, setEditing] = useState<EditSession | null>(() => restoredSession(userId, liveDevice));
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [savedFor, setSavedFor] = useState<DashboardDevice | null>(null);
  // Bumped by „Erneut versuchen“ after the edit-mode chunk failed: remounts
  // its boundary, and the render asks retryableLazy for a fresh component.
  const [editorAttempt, setEditorAttempt] = useState(0);
  // The session as the latest render holds it. The editor stays usable while
  // „Fertig“ saves, and an edit made meanwhile lands here, after the save's
  // closure captured its draft.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useDraftMemory(userId, token, editing, layouts);
  useRefetchOnForbidden(userId, layouts.reload);

  const { state, confirmed } = layouts;
  const saveFailed = de
    ? "Startseite konnte nicht gespeichert werden. Bitte erneut versuchen."
    : "The start page could not be saved. Please try again.";
  const deviceName = (device: DashboardDevice) => (de ? DASHBOARD_DEVICE_LABEL[device].de : DASHBOARD_DEVICE_LABEL[device].en);

  const leaveEditing = (device: DashboardDevice) => {
    if (userId !== null) clearDraft(userId, device);
    setEditing(null);
    setEditError(null);
  };

  const startEditing = () => {
    if (!state || !confirmed) return;
    // A draft still kept for this device class reopens: the editor could not
    // load last time („Schließen“ keeps it), or the window has changed size
    // class since the page mounted.
    setEditing(
      restoredSession(userId, liveDevice) ?? {
        device: liveDevice,
        draft: knownWidgets(state.layouts[liveDevice].widgets),
        restored: false,
      },
    );
    setEditError(null);
    setRoleError(null);
    setSavedFor(null);
  };

  /** §8.2 save errors. Stays in edit mode in every case. */
  const explainSaveError = async (error: unknown): Promise<string> => {
    const detail = dashboardErrorDetail(error);
    if (detail?.code === "unknown_widget") {
      // The server's catalog changed under the draft (a widget was retired):
      // drop what it no longer knows, so the next „Fertig“ can succeed.
      const fresh = await layouts.reload();
      const unknown = new Set(detail.ids);
      const catalog = fresh ? new Set(Object.keys(fresh.default_sizes)) : null;
      const keep = new Set(DASHBOARD_WIDGET_IDS.filter((id) => !unknown.has(id) && (catalog === null || catalog.has(id))));
      setEditing((current) => (current ? { ...current, draft: pruneWidgets(current.draft, keep) } : current));
      return de
        ? "Einige Widgets gibt es nicht mehr. Wir haben sie aus deinem Entwurf entfernt – bitte prüfe ihn und speichere erneut."
        : "Some widgets no longer exist. We removed them from your draft – please check it and save again.";
    }
    return detail ? detail.message : saveFailed;
  };

  const finishEditing = async () => {
    if (!editing || !state || busy) return;
    const { device, draft } = editing;
    if (sameLayout(draft, knownWidgets(state.layouts[device].widgets))) {
      leaveEditing(device);
      return;
    }
    setBusy(true);
    setEditError(null);
    try {
      await layouts.save(device, draft);
      // Changed while saving (as the admin panel handles it): stay in edit
      // mode with the newer draft, which the next „Fertig“ saves. Leaving
      // would drop it without a word.
      const latest = editingRef.current;
      if (latest && !sameLayout(latest.draft, draft)) return;
      leaveEditing(device);
      setSavedFor(device);
    } catch (error) {
      setEditError(await explainSaveError(error));
    } finally {
      setBusy(false);
    }
  };

  const resetEditing = async () => {
    if (!editing || busy) return;
    const { device } = editing;
    setBusy(true);
    setEditError(null);
    try {
      await layouts.reset(device);
      leaveEditing(device);
    } catch {
      setEditError(
        de
          ? "Startseite konnte nicht zurückgesetzt werden. Bitte erneut versuchen."
          : "The start page could not be reset. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const liveLayout = state?.layouts[liveDevice] ?? null;

  /** „Übernehmen“ (DELETE) or „Behalten“ (PUT, which re-stamps the role) after a role change (D22). */
  const answerRoleChange = async (adopt: boolean) => {
    if (!liveLayout || busy) return;
    setBusy(true);
    setRoleError(null);
    try {
      if (adopt) await layouts.reset(liveDevice);
      else await layouts.save(liveDevice, liveLayout.widgets);
    } catch {
      setRoleError(saveFailed);
    } finally {
      setBusy(false);
    }
  };

  /** Back to the page without the editor; unlike „Abbrechen“ the draft stays kept for the next „Anpassen“. */
  const closeBrokenEditor = () => {
    setEditing(null);
    setEditError(null);
  };

  const hostClass = `dashboard-host${editing ? " dashboard-host--editing" : ""}`;

  if (editing) {
    const DashboardEditMode = getDashboardEditMode();
    const loadFailedNotice = (
      <div className="dashboard-notice dashboard-notice--error" role="alert">
        <span>{de ? "Editor konnte nicht geladen werden." : "The editor could not be loaded."}</span>
        <span className="dashboard-notice__actions">
          <button
            type="button"
            className="dashboard-button dashboard-button--primary"
            onClick={() => setEditorAttempt((count) => count + 1)}
          >
            {de ? "Erneut versuchen" : "Try again"}
          </button>
          <button type="button" className="dashboard-button" onClick={closeBrokenEditor}>
            {de ? "Schließen" : "Close"}
          </button>
        </span>
      </div>
    );
    return (
      <section className={hostClass} aria-label={de ? "Startseite" : "Start page"}>
        {state ? (
          <DashboardLoadBoundary key={editorAttempt} name="edit-mode" fallback={loadFailedNotice}>
            <Suspense fallback={<p className="dashboard-host__status">{de ? "Editor wird geladen …" : "Loading the editor …"}</p>}>
              <DashboardEditMode
                device={editing.device}
                layout={state.layouts[editing.device]}
                state={state}
                draft={editing.draft}
                onDraftChange={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
                onCancel={() => leaveEditing(editing.device)}
                onDone={() => void finishEditing()}
                onReset={() => void resetEditing()}
                busy={busy}
                error={editError}
                restored={editing.restored}
                language={language}
              />
            </Suspense>
          </DashboardLoadBoundary>
        ) : (
          <p className="dashboard-host__status">{de ? "Startseite wird geladen …" : "Loading the start page …"}</p>
        )}
      </section>
    );
  }

  const visible = (liveLayout?.widgets ?? []).filter((item) => getLazyWidget(item.id) !== null);
  const loadFailed = layouts.error !== null && !confirmed;

  return (
    <section className={hostClass} aria-label={de ? "Startseite" : "Start page"}>
      <div className="dashboard-host__toolbar">
        <button
          type="button"
          className="dashboard-button"
          aria-label={de ? "Startseite anpassen" : "Customise start page"}
          disabled={!state || !confirmed}
          onClick={startEditing}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <path d="M2 4h7M12 4h2M2 12h2M7 12h7M10.5 2v4M5.5 10v4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          {de ? "Anpassen" : "Customise"}
        </button>
      </div>

      {loadFailed ? (
        <div className="dashboard-notice dashboard-notice--error" role="alert">
          <span>{de ? "Startseite konnte nicht geladen werden." : "The start page could not be loaded."}</span>
          <button type="button" className="dashboard-button" onClick={() => void layouts.reload()}>
            {de ? "Erneut versuchen" : "Try again"}
          </button>
        </div>
      ) : null}

      {savedFor !== null && savedFor !== liveDevice ? (
        <p className="dashboard-notice dashboard-notice--success" role="status">
          {de ? `Für ${deviceName(savedFor)} gespeichert.` : `Saved for ${deviceName(savedFor)}.`}
        </p>
      ) : null}

      {confirmed && liveLayout?.role_changed ? (
        <div className="dashboard-notice" role="status">
          <span>
            {de
              ? "Deine Rolle wurde geändert. Möchtest du die Startseite deiner neuen Rolle übernehmen?"
              : "Your role has changed. Do you want to use your new role's start page?"}
          </span>
          <span className="dashboard-notice__actions">
            <button type="button" className="dashboard-button dashboard-button--primary" disabled={busy} onClick={() => void answerRoleChange(true)}>
              {de ? "Übernehmen" : "Use it"}
            </button>
            <button type="button" className="dashboard-button" disabled={busy} onClick={() => void answerRoleChange(false)}>
              {de ? "Behalten" : "Keep mine"}
            </button>
          </span>
          {roleError ? <span className="dashboard-notice__error">{roleError}</span> : null}
        </div>
      ) : null}

      {!state ? (
        layouts.loading ? (
          <div className="dashboard-host__placeholder" aria-busy="true">
            <span className="visually-hidden">{de ? "Startseite wird geladen …" : "Loading the start page …"}</span>
          </div>
        ) : null
      ) : visible.length === 0 ? (
        <p className="dashboard-host__empty">
          {de
            ? "Deine Startseite ist leer. Über „Anpassen“ fügst du Widgets hinzu."
            : "Your start page is empty. Use “Customise” to add widgets."}
        </p>
      ) : (
        <DashboardGrid device={liveDevice}>
          {visible.map((item) => (
            <DashboardGridItem key={item.id} size={item.size} device={liveDevice}>
              <WidgetSlot item={item} device={liveDevice} de={de} />
            </DashboardGridItem>
          ))}
        </DashboardGrid>
      )}
    </section>
  );
}
