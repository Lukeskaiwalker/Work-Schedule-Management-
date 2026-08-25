/**
 * PiStationPage — admin surface for the Raspberry Pi scan station.
 *
 * The station is a Pi in the office with a barcode scanner, a Brother
 * PT-P710BT and (later) an SD card reader for Benning/Metrel device exports.
 * It runs `tools/label_agent/server.py`. This page is the only place inside
 * SMPL where that box is visible: is it up, what is plugged into it, what has
 * it counted, and how do I get a new one on the network.
 *
 * Two things shape the whole file:
 *
 *  1. **Everything here can be absent.** The station API is being written in
 *     parallel with this page, and the Pi itself is a box on a shelf that can
 *     be unplugged. Each panel therefore owns its own load state and resolves
 *     into a *statement* — "not available yet", "not reachable", "nothing
 *     recorded" — never an endless spinner. `stationApi` time-boxes every
 *     request so a silent Pi cannot hang one.
 *
 *  2. **It is a monitoring surface, not a marketing page.** Dense rows, real
 *     numbers, and the failure reason spelled out where the failure is.
 *
 * The stylesheet is imported here rather than appended to `styles.css`: this
 * page was built alongside concurrent edits to that file, and a separate sheet
 * is the one change that could not conflict.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "../context/AppContext";
import { parseServerDateTime } from "../utils/dates";
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
  stationStatus,
  unpairStation,
  type Station,
  type StationPairingRequest,
  type StationSession,
  type StationStatus,
} from "../utils/stationApi";
import "../styles/pi-station.css";

/** Status poll interval while the tab is visible and healthy. */
const POLL_MS = 20_000;
/** Backed-off interval after repeated failures — a dead Pi stays dead. */
const POLL_MS_SLOW = 90_000;
const POLL_FAILURES_BEFORE_BACKOFF = 3;
/** How often to ask whether an outstanding pairing code has been claimed. */
const PAIRING_POLL_MS = 4_000;

type Feedback = { ok: boolean; text: string };

// ── Copy ─────────────────────────────────────────────────────────────────

const TEXT = {
  // Matches the sidebar label from constants/index.ts — a page whose heading
  // disagrees with the item that opened it reads as the wrong page.
  title: { de: "Scan-Station", en: "Scan Station" },
  intro: {
    de: "Raspberry Pi im Büro: Barcode-Scanner, Etikettendrucker und Geräte-Import (Benning/Metrel). Hier wird der Pi mit SMPL gekoppelt und überwacht.",
    en: "Raspberry Pi in the office: barcode scanner, label printer and device import (Benning/Metrel). Pair and monitor the Pi from here.",
  },
  reload: { de: "Aktualisieren", en: "Refresh" },
  reloading: { de: "Lädt…", en: "Loading…" },
  updatedAt: { de: "Stand", en: "Updated" },
  loading: { de: "Stationen werden geladen…", en: "Loading stations…" },
  stationsTitle: { de: "Stationen", en: "Stations" },
  noStations: {
    de: "Noch keine Station gekoppelt. Erzeuge rechts einen Kopplungscode und gib ihn auf dem Pi ein.",
    en: "No station paired yet. Create a pairing code on the right and enter it on the Pi.",
  },
  statusOnline: { de: "Online", en: "Online" },
  statusStale: { de: "Verzögert", en: "Delayed" },
  statusOffline: { de: "Offline", en: "Offline" },
  statusUnknown: { de: "Unbekannt", en: "Unknown" },
  version: { de: "Agent-Version", en: "Agent version" },
  uptime: { de: "Laufzeit", en: "Uptime" },
  lastSeen: { de: "Zuletzt gesehen", en: "Last seen" },
  address: { de: "Adresse", en: "Address" },
  pairedAt: { de: "Gekoppelt", en: "Paired" },
  hardware: { de: "Hardware", en: "Hardware" },
  printer: { de: "Etikettendrucker", en: "Label printer" },
  scanner: { de: "Barcode-Scanner", en: "Barcode scanner" },
  printerOk: { de: "verbunden", en: "connected" },
  printerMissing: { de: "nicht verbunden", en: "not connected" },
  scannerOk: { de: "erkannt", en: "detected" },
  scannerMissing: { de: "nicht erkannt", en: "not detected" },
  simulated: {
    de: "Simulationsmodus — Druckaufträge werden gerendert, aber nicht gedruckt.",
    en: "Simulation mode — print jobs are rendered but never printed.",
  },
  tape: { de: "Band", en: "Tape" },
  testPrint: { de: "Testetikett drucken", en: "Print test label" },
  testPrinting: { de: "Druckt…", en: "Printing…" },
  recheck: { de: "Hardware prüfen", en: "Re-check hardware" },
  rechecking: { de: "Prüft…", en: "Checking…" },
  restart: { de: "Agent neu starten", en: "Restart agent" },
  restarting: { de: "Startet neu…", en: "Restarting…" },
  restartConfirm: {
    de: "Wirklich neu starten? Laufende Zählungen bleiben gespeichert, ein Druckauftrag bricht ab.",
    en: "Really restart? Recorded counts survive, a running print job is aborted.",
  },
  restartYes: { de: "Ja, neu starten", en: "Yes, restart" },
  cancel: { de: "Abbrechen", en: "Cancel" },
  unpair: { de: "Entkoppeln", en: "Unpair" },
  unpairConfirm: {
    de: "Station entkoppeln? Der Pi verliert den Zugang und muss neu gekoppelt werden.",
    en: "Unpair the station? The Pi loses access and has to be paired again.",
  },
  sessionsTitle: { de: "Aufgezeichnete Sitzungen", en: "Recorded sessions" },
  sessionsIntro: {
    de: "Zählungen, die lokal auf dem Pi liegen. Übernehmen schreibt sie in eine Werkstatt-Inventur.",
    en: "Counts held locally on the Pi. Importing writes them into a workshop inventory.",
  },
  sessionsEmpty: { de: "Die Station hat noch nichts aufgezeichnet.", en: "The station has not recorded anything yet." },
  colSession: { de: "Sitzung", en: "Session" },
  colArticles: { de: "Artikel", en: "Articles" },
  colQty: { de: "Menge", en: "Qty" },
  colScans: { de: "Scans", en: "Scans" },
  colLast: { de: "Letzter Scan", en: "Last scan" },
  importAction: { de: "Übernehmen", en: "Import" },
  importing: { de: "Übernimmt…", en: "Importing…" },
  imported: { de: "Übernommen", en: "Imported" },
  importAgain: { de: "Erneut übernehmen", en: "Import again" },
  pairingTitle: { de: "Neue Station koppeln", en: "Pair a new station" },
  pairingIntro: {
    de: "Der Code ist wenige Minuten gültig und wird einmalig verwendet. Am Pi eintippen — kein Passwort nötig.",
    en: "The code is valid for a few minutes and can be used once. Type it on the Pi — no password needed.",
  },
  pairingCreate: { de: "Kopplungscode erzeugen", en: "Create pairing code" },
  pairingCreating: { de: "Wird erzeugt…", en: "Creating…" },
  pairingName: { de: "Name der Station (optional)", en: "Station name (optional)" },
  pairingLocation: { de: "Standort (optional)", en: "Location (optional)" },
  pairingValidFor: { de: "Gültig noch", en: "Valid for" },
  pairingExpired: { de: "Code abgelaufen — bitte neu erzeugen.", en: "Code expired — create a new one." },
  pairingWaiting: { de: "Warte auf den Pi…", en: "Waiting for the Pi…" },
  pairingClaimed: { de: "Station gekoppelt.", en: "Station paired." },
  pairingRevoke: { de: "Code verwerfen", en: "Discard code" },
  pairingUrl: { de: "Oder diese Adresse am Pi öffnen bzw. QR scannen:", en: "Or open this address on the Pi, or scan the QR:" },
  setupTitle: { de: "Neuen Pi einrichten", en: "Set up a fresh Pi" },
  setupIntro: {
    de: "Einmalig auf einem frischen Raspberry Pi OS ausführen. Danach den Kopplungscode eintragen.",
    en: "Run once on a fresh Raspberry Pi OS. Then enter the pairing code.",
  },
  copy: { de: "Kopieren", en: "Copy" },
  copied: { de: "Kopiert", en: "Copied" },
  copyFailed: {
    de: "Kopieren nicht möglich — bitte manuell markieren.",
    en: "Copy failed — please select manually.",
  },
  apiMissingTitle: { de: "Schnittstelle noch nicht verfügbar", en: "API not available yet" },
  apiMissingBody: {
    de: "Dieser Server kennt die Stations-Endpunkte noch nicht. Die Einrichtungsanleitung unten funktioniert trotzdem.",
    en: "This server does not expose the station endpoints yet. The setup instructions below still apply.",
  },
} as const;

type TextKey = keyof typeof TEXT;

// ── Formatting ───────────────────────────────────────────────────────────

function formatUptime(seconds: number | null, de: boolean): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return de ? `${days} T ${hours} Std` : `${days}d ${hours}h`;
  if (hours > 0) return de ? `${hours} Std ${minutes} Min` : `${hours}h ${minutes}m`;
  if (minutes > 0) return de ? `${minutes} Min` : `${minutes}m`;
  return de ? `${total} s` : `${total}s`;
}

/**
 * "vor 12 s" up to a day, an absolute timestamp beyond it.
 *
 * An ops page lives on the recent past: for anything inside the last hour the
 * age is the whole message, and for anything older the exact moment matters
 * more than the arithmetic.
 */
function formatAge(iso: string | null, de: boolean, now: number): string {
  const parsed = parseServerDateTime(iso);
  if (!parsed) return "—";
  const seconds = Math.max(0, Math.round((now - parsed.getTime()) / 1000));
  if (seconds < 60) return de ? `vor ${seconds} s` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return de ? `vor ${minutes} Min` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return de ? `vor ${hours} Std` : `${hours}h ago`;
  return parsed.toLocaleString(de ? "de-DE" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatStamp(iso: string | null, de: boolean): string {
  const parsed = parseServerDateTime(iso);
  if (!parsed) return "—";
  return parsed.toLocaleString(de ? "de-DE" : "en-US", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}

function statusKey(status: StationStatus): TextKey {
  switch (status) {
    case "online":
      return "statusOnline";
    case "stale":
      return "statusStale";
    case "offline":
      return "statusOffline";
    default:
      return "statusUnknown";
  }
}

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

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Falls through: a denied permission is not an error worth throwing.
  }
  return false;
}

// ── Small presentational pieces ──────────────────────────────────────────

function StatusPill({ status, label }: { status: StationStatus; label: string }) {
  return (
    <span className={`pi-station-pill pi-station-pill--${status}`}>
      <span className="pi-station-pill-dot" />
      {label}
    </span>
  );
}

function MetaItem({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="pi-station-meta-item">
      <dt>{label}</dt>
      <dd className={mono ? "pi-station-mono" : undefined}>{value}</dd>
    </div>
  );
}

function FeedbackLine({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  return (
    <p className={`pi-station-feedback${feedback.ok ? "" : " pi-station-feedback--bad"}`}>
      {feedback.text}
    </p>
  );
}

/**
 * QR of the enrolment URL, drawn locally.
 *
 * `@zxing/browser` is already a dependency (the camera scanner reads with it)
 * and ships an SVG writer, so no image service and no CDN is involved — which
 * the app's CSP would block anyway. Loaded dynamically and failure-tolerant:
 * the typed code below it is the real mechanism, the QR is a shortcut.
 */
function PairingQr({ value }: { value: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host || !value) return undefined;
    host.replaceChildren();
    setFailed(false);

    void (async () => {
      try {
        const { BrowserQRCodeSvgWriter } = await import("@zxing/browser");
        if (cancelled) return;
        const svg = new BrowserQRCodeSvgWriter().write(value, 168, 168);
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-hidden", "true");
        if (!cancelled && hostRef.current) hostRef.current.replaceChildren(svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      host.replaceChildren();
    };
  }, [value]);

  if (failed) return null;
  return <div className="pi-station-qr" ref={hostRef} />;
}

// ── Page ─────────────────────────────────────────────────────────────────

export function PiStationPage() {
  const { token, language } = useAppContext();
  const de = language === "de";
  const t = useCallback((key: TextKey) => (de ? TEXT[key].de : TEXT[key].en), [de]);

  // -- station list + polling ---------------------------------------------
  const [stations, setStations] = useState<Station[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error" | "missing">("loading");
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

  const [actionBusy, setActionBusy] = useState<"print" | "recheck" | "restart" | "unpair" | null>(
    null,
  );
  const [actionFeedback, setActionFeedback] = useState<Feedback | null>(null);
  const [restartArmed, setRestartArmed] = useState(false);

  // Disarm the restart confirmation when the admin looks at another station.
  useEffect(() => {
    setRestartArmed(false);
    setActionFeedback(null);
  }, [selectedId]);

  const runAction = useCallback(
    async (
      kind: "print" | "recheck" | "restart" | "unpair",
      run: () => Promise<Feedback>,
    ) => {
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
  const [sessionState, setSessionState] = useState<"idle" | "loading" | "ready" | "error">("idle");
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

  // -- setup block ---------------------------------------------------------
  const baseUrl = typeof window !== "undefined" ? window.location.origin : "";
  const [setupScript, setSetupScript] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

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

  const effectiveScript =
    setupScript ?? fallbackSetupScript(baseUrl, null);

  const doCopy = useCallback(() => {
    void (async () => {
      const ok = await copyText(effectiveScript);
      if (!mountedRef.current) return;
      setCopied(ok ? "ok" : "fail");
      window.setTimeout(() => {
        if (mountedRef.current) setCopied("idle");
      }, 2_500);
    })();
  }, [effectiveScript]);

  // -- render --------------------------------------------------------------
  const busy = actionBusy !== null;

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
          {/* ── Status ─────────────────────────────────────────────────── */}
          <div className="admin-page-card">
            <h2 className="admin-page-card-title">{t("stationsTitle")}</h2>

            {listState === "loading" && <p className="admin-page-muted">{t("loading")}</p>}

            {listState === "missing" && (
              <div className="pi-station-notice">
                <strong>{t("apiMissingTitle")}</strong>
                <span>{t("apiMissingBody")}</span>
              </div>
            )}

            {listState === "error" && (
              <div className="pi-station-notice pi-station-notice--bad">
                <strong>{listError}</strong>
                <span>
                  {de
                    ? "Die Anzeige aktualisiert sich weiter im Hintergrund."
                    : "The page keeps retrying in the background."}
                </span>
              </div>
            )}

            {listState === "ready" && stations.length === 0 && (
              <p className="admin-page-muted">{t("noStations")}</p>
            )}

            {stations.length > 1 && (
              <div className="pi-station-switcher">
                {stations.map((station) => (
                  <button
                    key={station.id}
                    type="button"
                    aria-pressed={station.id === selectedId}
                    className={`pi-station-switcher-btn${
                      station.id === selectedId ? " pi-station-switcher-btn--active" : ""
                    }`}
                    onClick={() => setSelectedId(station.id)}
                  >
                    <StatusPill
                      status={stationStatus(station, now)}
                      label={t(statusKey(stationStatus(station, now)))}
                    />
                    {station.name}
                  </button>
                ))}
              </div>
            )}

            {selected && (
              <div className="pi-station-detail">
                <div className="pi-station-detail-head">
                  <div>
                    <h3 className="pi-station-name">{selected.name}</h3>
                    {selected.location && (
                      <p className="pi-station-sub">{selected.location}</p>
                    )}
                  </div>
                  <StatusPill
                    status={stationStatus(selected, now)}
                    label={t(statusKey(stationStatus(selected, now)))}
                  />
                </div>

                <dl className="pi-station-meta">
                  <MetaItem label={t("version")} value={selected.agent_version ?? "—"} mono />
                  <MetaItem label={t("uptime")} value={formatUptime(selected.uptime_seconds, de)} />
                  <MetaItem
                    label={t("lastSeen")}
                    value={formatAge(selected.last_seen_at, de, now)}
                  />
                  <MetaItem
                    label={t("address")}
                    value={
                      selected.host
                        ? `${selected.host}${selected.port ? `:${selected.port}` : ""}`
                        : "—"
                    }
                    mono
                  />
                  <MetaItem
                    label={t("pairedAt")}
                    value={
                      selected.paired_at
                        ? `${formatStamp(selected.paired_at, de)}${
                            selected.paired_by_name ? ` · ${selected.paired_by_name}` : ""
                          }`
                        : "—"
                    }
                  />
                </dl>

                <h4 className="pi-station-subhead">{t("hardware")}</h4>
                <ul className="pi-station-hw">
                  <li className="pi-station-hw-row">
                    <span
                      className={`pi-station-dot${
                        selected.hardware?.printer_connected ? " pi-station-dot--ok" : " pi-station-dot--bad"
                      }`}
                    />
                    <span className="pi-station-hw-label">{t("printer")}</span>
                    <span className="pi-station-hw-value">
                      {selected.hardware?.printer_connected
                        ? [
                            selected.hardware.printer_model ?? "Brother PT-P710BT",
                            t("printerOk"),
                            selected.hardware.media_width_mm
                              ? `${t("tape")} ${selected.hardware.media_width_mm} mm`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : selected.hardware?.printer_error ?? t("printerMissing")}
                    </span>
                  </li>
                  <li className="pi-station-hw-row">
                    <span
                      className={`pi-station-dot${
                        selected.hardware?.scanner_present ? " pi-station-dot--ok" : " pi-station-dot--bad"
                      }`}
                    />
                    <span className="pi-station-hw-label">{t("scanner")}</span>
                    <span className="pi-station-hw-value">
                      {selected.hardware?.scanner_present
                        ? [selected.hardware.scanner_name, t("scannerOk")].filter(Boolean).join(" · ")
                        : t("scannerMissing")}
                    </span>
                  </li>
                </ul>

                {selected.hardware?.simulated && (
                  <p className="pi-station-warn">{t("simulated")}</p>
                )}
                {selected.agent_error && (
                  <p className="pi-station-warn pi-station-warn--bad">{selected.agent_error}</p>
                )}

                <div className="pi-station-actions">
                  <button
                    type="button"
                    className="admin-invite-submit admin-invite-submit--secondary"
                    onClick={doTestPrint}
                    disabled={busy}
                  >
                    {actionBusy === "print" ? t("testPrinting") : t("testPrint")}
                  </button>
                  <button
                    type="button"
                    className="admin-invite-submit admin-invite-submit--secondary"
                    onClick={doRecheck}
                    disabled={busy}
                  >
                    {actionBusy === "recheck" ? t("rechecking") : t("recheck")}
                  </button>
                  {restartArmed ? (
                    <>
                      <button
                        type="button"
                        className="pi-station-danger-btn"
                        onClick={doRestart}
                        disabled={busy}
                      >
                        {actionBusy === "restart" ? t("restarting") : t("restartYes")}
                      </button>
                      <button
                        type="button"
                        className="werkstatt-card-action"
                        onClick={() => setRestartArmed(false)}
                      >
                        {t("cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="admin-invite-submit admin-invite-submit--secondary"
                      onClick={() => setRestartArmed(true)}
                      disabled={busy}
                    >
                      {t("restart")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="werkstatt-card-action pi-station-unpair"
                    onClick={doUnpair}
                    disabled={busy}
                  >
                    {t("unpair")}
                  </button>
                </div>

                {restartArmed && <p className="pi-station-warn">{t("restartConfirm")}</p>}
                <FeedbackLine feedback={actionFeedback} />
              </div>
            )}
          </div>

          {/* ── Sessions ───────────────────────────────────────────────── */}
          {selected && (
            <div className="admin-page-card">
              <h2 className="admin-page-card-title">{t("sessionsTitle")}</h2>
              <p className="admin-tools-desc">{t("sessionsIntro")}</p>

              {sessionState === "loading" && <p className="admin-page-muted">{t("reloading")}</p>}

              {sessionState === "error" && (
                <div className="pi-station-notice pi-station-notice--bad">
                  <strong>
                    {sessionError ??
                      (de
                        ? "Die Sitzungen konnten nicht geladen werden."
                        : "Sessions could not be loaded.")}
                  </strong>
                  <button
                    type="button"
                    className="werkstatt-card-action"
                    onClick={() => void loadSessions(selected.id)}
                  >
                    {t("reload")}
                  </button>
                </div>
              )}

              {sessionState === "ready" && sessions.length === 0 && (
                <p className="admin-page-muted">{t("sessionsEmpty")}</p>
              )}

              {sessions.length > 0 && (
                <div className="pi-station-table-wrap">
                  <table className="pi-station-table">
                    <thead>
                      <tr>
                        <th>{t("colSession")}</th>
                        <th className="pi-station-num">{t("colArticles")}</th>
                        <th className="pi-station-num">{t("colQty")}</th>
                        <th className="pi-station-num">{t("colScans")}</th>
                        <th>{t("colLast")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((session) => (
                        <tr key={session.name}>
                          <td>
                            <span className="pi-station-mono">{session.name}</span>
                            {session.imported_at && (
                              <span className="pi-station-tag">
                                {t("imported")} · {formatStamp(session.imported_at, de)}
                              </span>
                            )}
                          </td>
                          <td className="pi-station-num">{session.articles}</td>
                          <td className="pi-station-num">{session.total_qty}</td>
                          <td className="pi-station-num">{session.total_scans}</td>
                          <td>{formatAge(session.last_counted_at ?? session.started_at, de, now)}</td>
                          <td className="pi-station-row-action">
                            <button
                              type="button"
                              className="werkstatt-card-action"
                              onClick={() => doImport(session)}
                              disabled={importingName !== null}
                            >
                              {importingName === session.name
                                ? t("importing")
                                : session.imported_at
                                  ? t("importAgain")
                                  : t("importAction")}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <FeedbackLine feedback={importFeedback} />
            </div>
          )}
        </div>

        <div className="pi-station-column">
          {/* ── Pairing ────────────────────────────────────────────────── */}
          <div className="admin-page-card">
            <h2 className="admin-page-card-title">{t("pairingTitle")}</h2>
            <p className="admin-tools-desc">{t("pairingIntro")}</p>

            {pending.length === 0 && (
              <p className="pi-station-feedback">
                {de
                  ? "Keine offenen Anfragen. Starte den Agent auf dem Pi — er zeigt dort einen Code an, der hier erscheint."
                  : "No pending requests. Start the agent on the Pi — it shows a code there which appears here."}
              </p>
            )}

            {pending.map((row) => (
              <div key={row.user_code} className="pi-station-pairing">
                <output className="pi-station-code">{row.user_code}</output>
                <p className="pi-station-countdown">
                  {row.device_hint ? <b>{row.device_hint}</b> : null}
                  {row.agent_version ? ` · Agent ${row.agent_version}` : ""}
                  {row.requested_ip ? ` · ${row.requested_ip}` : ""}
                  {" · "}
                  {t("pairingValidFor")} <b>{formatCountdown(Math.max(0, row.expires_in))}</b>
                </p>
                <label className="admin-invite-field">
                  <span className="admin-invite-field-label">{t("pairingName")}</span>
                  <input
                    type="text"
                    className="admin-invite-input"
                    value={pairingNames[row.user_code] ?? ""}
                    onChange={(event) =>
                      setPairingNames((prev) => ({ ...prev, [row.user_code]: event.target.value }))
                    }
                    placeholder={row.device_hint ?? (de ? "z. B. Büro-Station" : "e.g. office station")}
                    maxLength={60}
                    autoComplete="off"
                  />
                </label>
                <div className="pi-station-actions">
                  <button
                    type="button"
                    className="admin-invite-submit"
                    onClick={() => void doApprove(row)}
                    disabled={pairingBusy}
                  >
                    {de ? "Freigeben" : "Approve"}
                  </button>
                  <button
                    type="button"
                    className="werkstatt-card-action"
                    onClick={() => void doDeny(row)}
                    disabled={pairingBusy}
                  >
                    {de ? "Ablehnen" : "Deny"}
                  </button>
                </div>
              </div>
            ))}

            {pairingError && (
              <p className="pi-station-feedback pi-station-feedback--bad">{pairingError}</p>
            )}
          </div>

          {/* ── Setup ──────────────────────────────────────────────────── */}
          <div className="admin-page-card">
            <h2 className="admin-page-card-title">{t("setupTitle")}</h2>
            <p className="admin-tools-desc">{t("setupIntro")}</p>
            <pre className="pi-station-pre">{effectiveScript}</pre>
            <div className="pi-station-actions">
              <button
                type="button"
                className="admin-invite-submit admin-invite-submit--secondary"
                onClick={doCopy}
              >
                {copied === "ok" ? t("copied") : t("copy")}
              </button>
              {copied === "fail" && <span className="pi-station-warn">{t("copyFailed")}</span>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
