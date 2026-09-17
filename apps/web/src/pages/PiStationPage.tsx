/**
 * PiStationPage — admin surface for the Raspberry Pi scan station.
 *
 * The station is a Pi in the office with a barcode scanner, a Brother
 * PT-P710BT and an SD card reader for Benning/Metrel device exports. It runs
 * `tools/label_agent/server.py`. This page is the only place inside SMPL where
 * that box is visible: is it up, what is plugged into it, what has it counted,
 * and how do I get a new one on the network.
 *
 * Two things shape the surface:
 *
 *  1. **The Pi can be absent.** It is a box on a shelf that can be unplugged,
 *     and one that has not been updated yet has no address the API can call.
 *     Each panel therefore resolves into a *statement* — "not reachable",
 *     "address unknown", "nothing recorded" — never an endless spinner.
 *     `stationApi` time-boxes every request so a silent Pi cannot hang one.
 *
 *  2. **It is a monitoring surface, not a marketing page.** Dense rows, real
 *     numbers, and the failure reason spelled out where the failure is.
 *
 * This file is the *data owner* and nothing else: it polls, it fetches, it
 * holds the selection, and it hands plain values to four presentational cards
 * in `components/station/`. Those cards fetch nothing. Keeping every request in
 * one file is what makes the poll back-off, the hidden-tab skip and the
 * "reload after any action" rule visible in a single place instead of four.
 *
 * The stylesheet is imported here rather than appended to `styles.css`: this
 * page was built alongside concurrent edits to that file, and a separate sheet
 * is the one change that could not conflict.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "../context/AppContext";
import { StationPairingCard } from "../components/station/StationPairingCard";
import type { StationEditDraft, StationEditField } from "../components/station/StationEditForm";
import {
  IMPORT_TARGET_NEW,
  StationSessionsCard,
  type ImportTarget,
  type StationSessionState,
} from "../components/station/StationSessionsCard";
import { StationSetupCard } from "../components/station/StationSetupCard";
import {
  StationStatusCard,
  type StationActionKind,
  type StationEditState,
  type StationListState,
} from "../components/station/StationStatusCard";
import type { Feedback } from "../components/station/StationPrimitives";
import { createStationT, formatAge } from "../components/station/stationText";
import {
  approvePairing,
  describeStationError,
  fallbackSetupScript,
  denyPairing,
  firstSelectableStation,
  getSetupScript,
  importStationSession,
  isStationApiMissing,
  isStationRetired,
  listOpenInventorySessions,
  listStationSessions,
  listStations,
  patchStation,
  printTestLabel,
  refreshStation,
  restartStationAgent,
  listPendingPairings,
  unpairStation,
  type InventorySessionSummary,
  type Station,
  type StationPairingRequest,
  type StationSession,
} from "../utils/stationApi";
import "../styles/pi-station.css";

/** Status poll interval while the tab is visible and healthy. */
const POLL_MS = 20_000;
/** Backed-off interval after repeated failures — a dead Pi stays dead. */
const POLL_MS_SLOW = 90_000;
const POLL_FAILURES_BEFORE_BACKOFF = 3;
/** How often to ask whether an outstanding pairing code has been claimed. */
const PAIRING_POLL_MS = 4_000;

const EMPTY_DRAFT: StationEditDraft = { name: "", location: "", agentUrl: "" };

/**
 * A ticking clock, so relative timestamps stay honest without a manual reload.
 *
 * The interval is a parameter because the pairing countdown needs seconds and
 * nothing else on the page does — a permanent 1 s re-render of a table would
 * be pure waste.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function draftFor(station: Station): StationEditDraft {
  return {
    name: station.name,
    location: station.location ?? "",
    agentUrl: station.agent_url_override ?? "",
  };
}

export function PiStationPage() {
  const { token, language } = useAppContext();
  const de = language === "de";
  const t = useMemo(() => createStationT(de), [de]);

  // -- station list + polling ---------------------------------------------
  const [stations, setStations] = useState<Station[]>([]);
  const [listState, setListState] = useState<StationListState>("loading");
  const [listError, setListError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [manualReloading, setManualReloading] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // The audit toggle: also fetch revoked/expired rows. Off by default, so an
  // unpaired Pi vanishes from the switcher instead of being auto-selected.
  const [showInactive, setShowInactive] = useState(false);

  const mountedRef = useRef(true);
  const failuresRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStations = useCallback(async () => {
    try {
      const result = await listStations(token, { includeInactive: showInactive });
      if (!mountedRef.current) return;
      failuresRef.current = 0;
      setStations(result.stations);
      setListState("ready");
      setListError(null);
      setLastUpdated(Date.now());
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      failuresRef.current += 1;
      if (isStationApiMissing(error)) {
        setListState("missing");
        setStations([]);
        setListError(null);
      } else {
        setListState("error");
        setListError(describeStationError(error, de));
      }
      setLastUpdated(Date.now());
    }
  }, [token, de, showInactive]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const schedule = () => {
      if (cancelled) return;
      const slow = failuresRef.current >= POLL_FAILURES_BEFORE_BACKOFF;
      timer = window.setTimeout(tick, slow ? POLL_MS_SLOW : POLL_MS);
    };
    const tick = async () => {
      // A hidden tab does not need fresh hardware state, and the Pi does not
      // need the traffic. The next visible tick catches up.
      if (!cancelled && !document.hidden) await loadStations();
      schedule();
    };

    void loadStations();
    schedule();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [loadStations]);

  const reloadNow = useCallback(async () => {
    setManualReloading(true);
    await loadStations();
    if (mountedRef.current) setManualReloading(false);
  }, [loadStations]);

  // -- pairing -------------------------------------------------------------
  const [pending, setPending] = useState<StationPairingRequest[]>([]);
  const [pairingNames, setPairingNames] = useState<Record<string, string>>({});
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // A second while any code is counting down, 30 s otherwise — see useNow.
  const pairingActive = pending.length > 0;
  const now = useNow(pairingActive ? 1_000 : 30_000);

  // Live rows drive the switcher and the detail; retired ones are the audit
  // list. Split here, on the clock, so a token that expires while the page
  // is open moves its row across on the next tick rather than on a reload.
  const activeStations = useMemo(
    () => stations.filter((station) => !isStationRetired(station, now)),
    [stations, now],
  );
  const retiredStations = useMemo(
    () => stations.filter((station) => isStationRetired(station, now)),
    [stations, now],
  );

  // Keep the selection pointing at something that still works: never a
  // retired row (every action on it would answer 409), and nothing at all
  // when only retired rows are left.
  useEffect(() => {
    const stillLive = activeStations.some((s) => s.id === selectedId);
    if (stillLive) return;
    const next = firstSelectableStation(stations, now);
    const nextId = next?.id ?? null;
    if (nextId !== selectedId) setSelectedId(nextId);
  }, [stations, activeStations, selectedId, now]);

  const selected = useMemo(
    () => activeStations.find((s) => s.id === selectedId) ?? null,
    [activeStations, selectedId],
  );

  /**
   * Poll for codes the Pi has requested.
   *
   * The Pi initiates (RFC 8628 device grant): it asks the API for a code and
   * shows it on its own screen. An admin only ever *approves* — nobody can
   * mint a credential for a device that never asked, which is what makes the
   * unauthenticated pair/start endpoint safe to expose.
   */
  const loadPending = useCallback(async () => {
    if (!token) return;
    try {
      setPending(await listPendingPairings(token));
      setPairingError(null);
    } catch (err) {
      // A missing endpoint is not an error worth shouting about; the rest of
      // the page stays useful.
      setPending([]);
      const status = (err as { status?: number } | null)?.status;
      if (status !== 404 && status !== 405 && status !== 501) {
        setPairingError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [token]);

  useEffect(() => {
    void loadPending();
    const timer = window.setInterval(() => {
      if (!document.hidden) void loadPending();
    }, PAIRING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadPending]);

  const setPairingName = useCallback((userCode: string, name: string) => {
    setPairingNames((prev) => ({ ...prev, [userCode]: name }));
  }, []);

  const doApprove = useCallback(
    async (row: StationPairingRequest) => {
      if (!token) return;
      const name = (pairingNames[row.user_code] ?? "").trim() || row.device_hint || row.user_code;
      setPairingBusy(true);
      setPairingError(null);
      try {
        await approvePairing(token, { user_code: row.user_code, name });
        await Promise.all([loadPending(), loadStations()]);
      } catch (err) {
        setPairingError(err instanceof Error ? err.message : String(err));
      } finally {
        setPairingBusy(false);
      }
    },
    [token, pairingNames, loadPending, loadStations],
  );

  const doDeny = useCallback(
    async (row: StationPairingRequest) => {
      if (!token) return;
      setPairingBusy(true);
      try {
        await denyPairing(token, row.user_code);
        await loadPending();
      } catch (err) {
        setPairingError(err instanceof Error ? err.message : String(err));
      } finally {
        setPairingBusy(false);
      }
    },
    [token, loadPending],
  );

  // -- station actions -----------------------------------------------------
  const [actionBusy, setActionBusy] = useState<StationActionKind | null>(null);
  const [actionFeedback, setActionFeedback] = useState<Feedback | null>(null);
  const [restartArmed, setRestartArmed] = useState(false);

  // Disarm the restart confirmation when the admin looks at another station.
  useEffect(() => {
    setRestartArmed(false);
    setActionFeedback(null);
  }, [selectedId]);

  const runAction = useCallback(
    async (kind: StationActionKind, run: () => Promise<Feedback>) => {
      setActionBusy(kind);
      setActionFeedback(null);
      try {
        const feedback = await run();
        if (mountedRef.current) setActionFeedback(feedback);
      } catch (error: unknown) {
        if (mountedRef.current) {
          setActionFeedback({ ok: false, text: describeStationError(error, de) });
        }
      } finally {
        if (mountedRef.current) setActionBusy(null);
        void loadStations();
      }
    },
    [de, loadStations],
  );

  const doTestPrint = useCallback(() => {
    if (!selected) return;
    void runAction("print", async () => {
      const result = await printTestLabel(token, selected.id, {
        text: de ? "SMPL Testetikett" : "SMPL test label",
      });
      return {
        ok: result.ok !== false,
        text: result.detail || (de ? "Testetikett gesendet." : "Test label sent."),
      };
    });
  }, [selected, token, de, runAction]);

  const doRecheck = useCallback(() => {
    if (!selected) return;
    void runAction("recheck", async () => {
      await refreshStation(token, selected.id);
      return { ok: true, text: de ? "Hardware neu geprüft." : "Hardware re-checked." };
    });
  }, [selected, token, de, runAction]);

  const doRestart = useCallback(() => {
    if (!selected) return;
    setRestartArmed(false);
    void runAction("restart", async () => {
      const result = await restartStationAgent(token, selected.id);
      return {
        ok: result.ok !== false,
        text: result.detail || t("restartTriggered"),
      };
    });
  }, [selected, token, runAction, t]);

  const doUnpair = useCallback(() => {
    if (!selected) return;
    if (!window.confirm(t("unpairConfirm"))) return;
    void runAction("unpair", async () => {
      await unpairStation(token, selected.id);
      return { ok: true, text: de ? "Station entkoppelt." : "Station unpaired." };
    });
  }, [selected, token, de, runAction, t]);

  // -- inline edit ---------------------------------------------------------
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState<StationEditDraft>(EMPTY_DRAFT);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // A different station means a different form; never carry a draft across.
  useEffect(() => {
    setEditing(false);
    setEditError(null);
  }, [selectedId]);

  const startEdit = useCallback(() => {
    if (!selected) return;
    setEditDraft(draftFor(selected));
    setEditError(null);
    setEditing(true);
  }, [selected]);

  const changeEdit = useCallback((field: StationEditField, value: string) => {
    setEditDraft((prev) => ({ ...prev, [field]: value }));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setEditError(null);
  }, []);

  const saveEdit = useCallback(() => {
    if (!selected) return;
    const stationId = selected.id;
    const draft = editDraft;
    setEditBusy(true);
    setEditError(null);
    void (async () => {
      try {
        await patchStation(token, stationId, {
          name: draft.name.trim(),
          location: draft.location.trim() || null,
          agent_url: draft.agentUrl.trim() || null,
        });
        if (!mountedRef.current) return;
        setEditing(false);
        setActionFeedback({ ok: true, text: t("saved") });
        await loadStations();
      } catch (error: unknown) {
        if (mountedRef.current) setEditError(describeStationError(error, de));
      } finally {
        if (mountedRef.current) setEditBusy(false);
      }
    })();
  }, [selected, editDraft, token, de, t, loadStations]);

  const edit: StationEditState = { editing, draft: editDraft, busy: editBusy, error: editError };

  // -- sessions ------------------------------------------------------------
  const [sessions, setSessions] = useState<StationSession[]>([]);
  const [sessionState, setSessionState] = useState<StationSessionState>("idle");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [importingName, setImportingName] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<Feedback | null>(null);
  const [openInventories, setOpenInventories] = useState<InventorySessionSummary[]>([]);
  const [importTarget, setImportTarget] = useState<ImportTarget>(IMPORT_TARGET_NEW);

  const loadSessions = useCallback(
    async (stationId: number) => {
      setSessionState("loading");
      setSessionError(null);
      try {
        const result = await listStationSessions(token, stationId);
        if (!mountedRef.current) return;
        setSessions(result.sessions);
        setSessionState(result.ok ? "ready" : "error");
        setSessionError(result.ok ? null : result.error);
      } catch (error: unknown) {
        if (!mountedRef.current) return;
        setSessions([]);
        setSessionState("error");
        setSessionError(describeStationError(error, de));
      }
    },
    [token, de],
  );

  /**
   * The open Werkstatt inventories for the target select. A failure here
   * costs nothing but the select's extra options: "Neue Inventur anlegen"
   * needs no list, so the import stays usable.
   */
  const loadOpenInventories = useCallback(async () => {
    try {
      const rows = await listOpenInventorySessions(token);
      if (mountedRef.current) setOpenInventories(rows);
    } catch {
      if (mountedRef.current) setOpenInventories([]);
    }
  }, [token]);

  useEffect(() => {
    setImportFeedback(null);
    setImportTarget(IMPORT_TARGET_NEW);
    if (selectedId == null) {
      setSessions([]);
      setSessionState("idle");
      return;
    }
    void loadSessions(selectedId);
    void loadOpenInventories();
  }, [selectedId, loadSessions, loadOpenInventories]);

  // A target that vanished (finalized meanwhile) falls back to "new" rather
  // than earning a 409 on the next click.
  useEffect(() => {
    if (importTarget !== IMPORT_TARGET_NEW && !openInventories.some((row) => row.id === importTarget)) {
      setImportTarget(IMPORT_TARGET_NEW);
    }
  }, [openInventories, importTarget]);

  const doImport = useCallback(
    (session: StationSession) => {
      if (selectedId == null) return;
      const stationId = selectedId;
      const target = importTarget;
      setImportingName(session.name);
      setImportFeedback(null);
      void (async () => {
        try {
          const result = await importStationSession(
            token,
            stationId,
            session.name,
            typeof target === "number" ? { target_session_id: target } : {},
          );
          if (!mountedRef.current) return;
          const unmatched = result.unmatched?.length ?? 0;
          const summary =
            result.detail ||
            (de
              ? `${result.imported} übernommen, ${result.updated} aktualisiert → Inventur „${result.session_name}“`
              : `${result.imported} imported, ${result.updated} updated → inventory “${result.session_name}”`);
          setImportFeedback({
            ok: result.ok !== false,
            text: unmatched
              ? de
                ? `${summary} — ${unmatched} Code(s) ohne Artikel-Zuordnung.`
                : `${summary} — ${unmatched} code(s) matched no article.`
              : summary,
          });
          void loadSessions(stationId);
          void loadOpenInventories();
          void loadStations();
        } catch (error: unknown) {
          if (mountedRef.current) {
            setImportFeedback({ ok: false, text: describeStationError(error, de) });
          }
        } finally {
          if (mountedRef.current) setImportingName(null);
        }
      })();
    },
    [selectedId, importTarget, token, de, loadSessions, loadOpenInventories, loadStations],
  );

  const reloadSessions = useCallback(() => {
    if (selectedId == null) return;
    void loadSessions(selectedId);
    void loadOpenInventories();
  }, [selectedId, loadSessions, loadOpenInventories]);

  // -- setup script --------------------------------------------------------
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const [setupScript, setSetupScript] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await getSetupScript(token);
        if (!cancelled && result?.script) setSetupScript(result.script);
      } catch {
        // The fallback below is the same documented path, minus the pinned tag.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const effectiveScript = setupScript ?? fallbackSetupScript(baseUrl);

  // -- render --------------------------------------------------------------

  return (
    <section className="admin-page pi-station">
      <header className="pi-station-header">
        <div className="pi-station-header-text">
          <h1 className="admin-page-title">{t("title")}</h1>
          <p className="admin-tools-desc">{t("intro")}</p>
        </div>
        <div className="pi-station-header-actions">
          {lastUpdated != null && (
            <span className="pi-station-updated">
              {t("updatedAt")}: {formatAge(new Date(lastUpdated).toISOString(), de, now)}
            </span>
          )}
          <button
            type="button"
            className="admin-invite-submit admin-invite-submit--secondary"
            onClick={() => void reloadNow()}
            disabled={manualReloading}
          >
            {manualReloading ? t("reloading") : t("reload")}
          </button>
        </div>
      </header>

      <div className="pi-station-layout">
        <div className="pi-station-column">
          <StationStatusCard
            t={t}
            de={de}
            now={now}
            stations={activeStations}
            retired={retiredStations}
            showInactive={showInactive}
            onShowInactiveChange={setShowInactive}
            listState={listState}
            listError={listError}
            selected={selected}
            selectedId={selectedId}
            onSelect={setSelectedId}
            actionBusy={actionBusy}
            actionFeedback={actionFeedback}
            restartArmed={restartArmed}
            onArmRestart={setRestartArmed}
            onTestPrint={doTestPrint}
            onRecheck={doRecheck}
            onRestart={doRestart}
            onUnpair={doUnpair}
            edit={edit}
            onEditStart={startEdit}
            onEditChange={changeEdit}
            onEditCancel={cancelEdit}
            onEditSave={saveEdit}
          />

          {selected && (
            <StationSessionsCard
              t={t}
              de={de}
              now={now}
              sessions={sessions}
              sessionState={sessionState}
              sessionError={sessionError}
              importingName={importingName}
              importFeedback={importFeedback}
              openInventories={openInventories}
              importTarget={importTarget}
              onImportTargetChange={setImportTarget}
              onReload={reloadSessions}
              onImport={doImport}
            />
          )}
        </div>

        <div className="pi-station-column">
          <StationPairingCard
            t={t}
            pending={pending}
            pairingNames={pairingNames}
            pairingBusy={pairingBusy}
            pairingError={pairingError}
            onNameChange={setPairingName}
            onApprove={(row) => void doApprove(row)}
            onDeny={(row) => void doDeny(row)}
          />

          <StationSetupCard t={t} script={effectiveScript} />
        </div>
      </div>
    </section>
  );
}
