/**
 * PiStationPage — admin surface for the Raspberry Pi scan station.
 *
 * The station is a Pi in the office with a barcode scanner, a Brother
 * PT-P710BT and (later) an SD card reader for Benning/Metrel device exports.
 * It runs `tools/label_agent/server.py`. This page is the only place inside
 * SMPL where that box is visible: is it up, what is plugged into it, what has
 * it counted, and how do I get a new one on the network.
 *
 * Two things shape the surface:
 *
 *  1. **Everything here can be absent.** The station API is being written in
 *     parallel with this page, and the Pi itself is a box on a shelf that can
 *     be unplugged. Each panel therefore resolves into a *statement* — "not
 *     available yet", "not reachable", "nothing recorded" — never an endless
 *     spinner. `stationApi` time-boxes every request so a silent Pi cannot
 *     hang one.
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
import {
  StationSessionsCard,
  type StationSessionState,
} from "../components/station/StationSessionsCard";
import { StationSetupCard } from "../components/station/StationSetupCard";
import {
  StationStatusCard,
  type StationActionKind,
  type StationListState,
} from "../components/station/StationStatusCard";
import type { Feedback } from "../components/station/StationPrimitives";
import { createStationT, formatAge } from "../components/station/stationText";
import {
  approvePairing,
  describeStationError,
  fallbackSetupScript,
  denyPairing,
  getSetupScript,
  importStationSession,
  isStationApiMissing,
  listStationSessions,
  listStations,
  printTestLabel,
  refreshStation,
  restartStationAgent,
  listPendingPairings,
  unpairStation,
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
      const result = await listStations(token);
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
  }, [token, de]);

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

  // Keep the selection pointing at something that still exists.
  useEffect(() => {
    if (stations.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !stations.some((s) => s.id === selectedId)) {
      setSelectedId(stations[0].id);
    }
  }, [stations, selectedId]);

  const selected = useMemo(
    () => stations.find((s) => s.id === selectedId) ?? null,
    [stations, selectedId],
  );

  // -- pairing -------------------------------------------------------------
  const [pending, setPending] = useState<StationPairingRequest[]>([]);
  const [pairingNames, setPairingNames] = useState<Record<string, string>>({});
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // A second while any code is counting down, 30 s otherwise — see useNow.
  const pairingActive = pending.length > 0;
  const now = useNow(pairingActive ? 1_000 : 30_000);

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
        text: result.detail || (de ? "Neustart ausgelöst." : "Restart triggered."),
      };
    });
  }, [selected, token, de, runAction]);

  const doUnpair = useCallback(() => {
    if (!selected) return;
    if (!window.confirm(t("unpairConfirm"))) return;
    void runAction("unpair", async () => {
      await unpairStation(token, selected.id);
      return { ok: true, text: de ? "Station entkoppelt." : "Station unpaired." };
    });
  }, [selected, token, de, runAction, t]);

  // -- sessions ------------------------------------------------------------
  const [sessions, setSessions] = useState<StationSession[]>([]);
  const [sessionState, setSessionState] = useState<StationSessionState>("idle");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [importingName, setImportingName] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<Feedback | null>(null);

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

  useEffect(() => {
    setImportFeedback(null);
    if (selectedId == null) {
      setSessions([]);
      setSessionState("idle");
      return;
    }
    void loadSessions(selectedId);
  }, [selectedId, loadSessions]);

  const doImport = useCallback(
    (session: StationSession) => {
      if (selectedId == null) return;
      const stationId = selectedId;
      setImportingName(session.name);
      setImportFeedback(null);
      void (async () => {
        try {
          const result = await importStationSession(token, stationId, session.name);
          if (!mountedRef.current) return;
          const unmatched = result.unmatched?.length ?? 0;
          const summary =
            result.detail ||
            (de
              ? `${result.imported} übernommen, ${result.updated} aktualisiert`
              : `${result.imported} imported, ${result.updated} updated`);
          setImportFeedback({
            ok: result.ok !== false,
            text: unmatched
              ? de
                ? `${summary} — ${unmatched} Code(s) ohne Artikel-Zuordnung.`
                : `${summary} — ${unmatched} code(s) matched no article.`
              : summary,
          });
          void loadSessions(stationId);
        } catch (error: unknown) {
          if (mountedRef.current) {
            setImportFeedback({ ok: false, text: describeStationError(error, de) });
          }
        } finally {
          if (mountedRef.current) setImportingName(null);
        }
      })();
    },
    [selectedId, token, de, loadSessions],
  );

  const reloadSessions = useCallback(() => {
    if (selectedId == null) return;
    void loadSessions(selectedId);
  }, [selectedId, loadSessions]);

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
        // Expected until the endpoint exists — the fallback below is complete.
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
            stations={stations}
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
