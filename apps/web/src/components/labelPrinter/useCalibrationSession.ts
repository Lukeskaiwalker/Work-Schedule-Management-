/**
 * The calibration session's lifecycle on the client
 * (docs/LABEL_PRINTER_CALIBRATION.md §5.1, §6.2, §7.2, §7.5).
 *
 * One hook owns the session id, so the quick flow and the wizard cannot drift
 * apart on the rules that matter:
 *   * a heartbeat every 60 s keeps the server lock (TTL 600 s) while a person
 *     reads the checklist;
 *   * polling every 1.5 s while the printer senses, the first poll at once; a
 *     final "done" verifies by itself;
 *   * on unmount the session is ended. DELETE is idempotent on the server, so
 *     ending after `save` (which already released it) answers 204 and changes
 *     nothing — errors there are swallowed on purpose: a closing sheet has
 *     nowhere to show them, and a stale lock expires anyway;
 *   * a start still in flight when `end` runs or the sheet unmounts is ended
 *     the moment it answers. Nothing else would ever release that lock: no id
 *     to DELETE yet, no heartbeat later — and for its 600 s every workshop
 *     print is refused;
 *   * `latestRevision` is the highest configuration revision seen in ANY
 *     response (settings GET/PUT, every session call incl. `activate`). The
 *     wizard sends it with each PUT, so a PUT after `activate` is not stale;
 *   * `verifyWithoutSensing` is the switch-material mode: set only by
 *     [Auf „X“ umstellen], cleared by any auto-sense start and by `resense`.
 *     The server needs no flag — verify judges the latched measurement.
 *
 * Actions return their result and THROW on failure; the panel that called
 * them decides how to show the error code.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ApplyResult,
  AutosenseResult,
  CalibrationRecord,
  CalibrationSaveIn,
  CalibrationSession,
  CalibrationVerdict,
  PatternResult,
  SensePoll,
  SessionMode,
} from "../../types/labelPrinter";
import { apiErrorCode } from "../../utils/labelCalibration";
import {
  activateMaterial,
  applyMaterialSettings,
  endCalibrationSession,
  heartbeatSession,
  pollSensing,
  printMeasuringPattern,
  saveCalibration,
  startAutosense,
  startCalibrationSession,
  verifyMeasurement,
} from "../../utils/labelPrinterApi";

/** Mutable so tests can shorten the waits; the app never changes them. */
export const CALIBRATION_TIMING = { pollIntervalMs: 1500, heartbeatMs: 60_000 };

/** Errors after which polling simply tries again (a busy I/O lock, a dropped connection). */
function isTransient(err: unknown): boolean {
  if (apiErrorCode(err) === "printer_busy") return true;
  return (err as { status?: unknown } | null)?.status === 0;
}

/** Sensing may start once settings for THIS material were applied (§6.2). */
export function canStartSensing(session: CalibrationSession | null): boolean {
  return !!session && session.applied && ["applied", "sensed", "judged"].includes(session.phase);
}

/**
 * Whether the printer may still be moving media (§4.6, critique S2):
 * "measuring" while the poll reports a running sense; "unknown" when nothing
 * says it stopped — a silent STATUS (button method), a failed poll, or a poll
 * that timed out before a verdict. Ending the setup frees the lock, so the
 * cancel dialog waits out "measuring" and repeats the stop hint for both.
 */
export type FeedState = "measuring" | "unknown" | null;

export function feedState(session: CalibrationSession | null, polling: boolean, poll: SensePoll | null): FeedState {
  if (polling) return "measuring";
  if (session?.phase === "sensing") return "unknown";
  if (session?.phase === "sensed" && poll?.phase === "timeout") return "unknown";
  return null;
}

export interface UseCalibrationSessionOptions {
  token: string | null;
  initialRevision?: number;
  /** Called with every verdict, also the one verify produces after a "done" poll. */
  onVerdict?: (verdict: CalibrationVerdict) => void;
}

export function useCalibrationSession({ token, initialRevision = 0, onVerdict }: UseCalibrationSessionOptions) {
  const [session, setSession] = useState<CalibrationSession | null>(null);
  const [latestRevision, setLatestRevision] = useState(initialRevision);
  const [verifyWithoutSensing, setVerifyWithoutSensing] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [autosense, setAutosense] = useState<AutosenseResult | null>(null);
  const [poll, setPoll] = useState<SensePoll | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollError, setPollError] = useState<unknown>(null);
  const [verdict, setVerdict] = useState<CalibrationVerdict | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const sidRef = useRef<string | null>(null);
  const endedRef = useRef(false);
  /** Starts awaiting their answer; `end` marks them abandoned. */
  const startsInFlight = useRef(new Set<{ abandoned: boolean }>());
  const mountedRef = useRef(true);
  const tokenRef = useRef(token);
  const pollTimer = useRef<number | null>(null);
  const onVerdictRef = useRef(onVerdict);
  tokenRef.current = token;
  onVerdictRef.current = onVerdict;

  const noteRevision = useCallback((revision: number | null | undefined) => {
    if (typeof revision === "number") setLatestRevision((previous) => Math.max(previous, revision));
  }, []);

  const adopt = useCallback(
    (next: CalibrationSession) => {
      sidRef.current = next.session_id;
      if (mountedRef.current) setSession(next);
      noteRevision(next.config_revision);
    },
    [noteRevision],
  );

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
    if (mountedRef.current) setPolling(false);
  }, []);

  /** Wraps an action: marks it busy, requires a session id, rethrows failures. */
  const run = useCallback(async <T,>(name: string, action: (sid: string) => Promise<T>): Promise<T> => {
    const sid = sidRef.current;
    if (!sid) throw new Error("Keine Einrichtung aktiv");
    setBusy(name);
    try {
      return await action(sid);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, []);

  const verify = useCallback(async () => {
    const result = await run("verify", (sid) => verifyMeasurement(tokenRef.current, sid));
    adopt(result.session);
    if (mountedRef.current) setVerdict(result);
    onVerdictRef.current?.(result);
    return result;
  }, [adopt, run]);

  const tick = useCallback(async () => {
    const sid = sidRef.current;
    pollTimer.current = null;
    if (!sid || !mountedRef.current) return;
    try {
      const result = await pollSensing(tokenRef.current, sid);
      if (!mountedRef.current) return;
      setPoll(result);
      adopt(result.session);
      if (result.phase === "sensing") {
        pollTimer.current = window.setTimeout(() => void tick(), CALIBRATION_TIMING.pollIntervalMs);
        return;
      }
      setPolling(false);
      if (result.phase === "done") await verify();
    } catch (err) {
      if (!mountedRef.current) return;
      if (isTransient(err)) {
        pollTimer.current = window.setTimeout(() => void tick(), CALIBRATION_TIMING.pollIntervalMs);
        return;
      }
      setPollError(err);
      setPolling(false);
    }
  }, [adopt, verify]);

  /** Resolves to null when the setup was ended (or the sheet closed) before the server answered. */
  const start = useCallback(
    async (mode: SessionMode, materialId: string, takeover = false): Promise<CalibrationSession | null> => {
      const attempt = { abandoned: false };
      startsInFlight.current.add(attempt);
      setBusy("start");
      try {
        const next = await startCalibrationSession(tokenRef.current, {
          mode,
          material_id: materialId,
          ...(takeover ? { takeover: true } : {}),
        });
        if (attempt.abandoned || !mountedRef.current) {
          endCalibrationSession(tokenRef.current, next.session_id).catch(() => undefined);
          return null;
        }
        endedRef.current = false;
        adopt(next);
        setApplyResult(null);
        setAutosense(null);
        setPoll(null);
        setVerdict(null);
        return next;
      } finally {
        startsInFlight.current.delete(attempt);
        if (mountedRef.current) setBusy(null);
      }
    },
    [adopt],
  );

  const activate = useCallback(
    async (materialId: string) => {
      const next = await run("activate", (sid) => activateMaterial(tokenRef.current, sid, materialId));
      adopt(next);
      // A new apply → sense/verify cycle starts; the server keeps the measurement
      // itself (latch), the panels must not keep showing the last run's state.
      setApplyResult(null);
      setAutosense(null);
      setPoll(null);
      setPollError(null);
      setVerdict(null);
      return next;
    },
    [adopt, run],
  );

  const apply = useCallback(async () => {
    const result = await run("apply", (sid) => applyMaterialSettings(tokenRef.current, sid));
    adopt(result.session);
    setApplyResult(result);
    return result;
  }, [adopt, run]);

  const startSense = useCallback(
    async (method: "command" | "button") => {
      setVerifyWithoutSensing(false);
      stopPolling();
      const result = await run("autosense", (sid) => startAutosense(tokenRef.current, sid, method));
      adopt(result.session);
      setAutosense(result);
      setPoll(null);
      setPollError(null);
      setVerdict(null);
      // A silent STATUS (button method) makes polling useless: the panel shows
      // [Ergebnis abfragen] instead (§4.6, §7.4).
      if (result.status_answered) {
        setPolling(true);
        pollTimer.current = window.setTimeout(() => void tick(), 0);
      }
      return result;
    },
    [adopt, run, stopPolling, tick],
  );

  const printPattern = useCallback(async (): Promise<PatternResult> => {
    const result = await run("pattern", (sid) => printMeasuringPattern(tokenRef.current, sid));
    adopt(result.session);
    return result;
  }, [adopt, run]);

  const save = useCallback(
    async (body: CalibrationSaveIn): Promise<CalibrationRecord> =>
      run("save", (sid) => saveCalibration(tokenRef.current, sid, body)),
    [run],
  );

  const end = useCallback(async () => {
    stopPolling();
    startsInFlight.current.forEach((attempt) => {
      attempt.abandoned = true;
    });
    const sid = sidRef.current;
    if (!sid || endedRef.current) return;
    endedRef.current = true;
    try {
      await endCalibrationSession(tokenRef.current, sid);
    } catch {
      // Idempotent on the server; a failure here leaves a lock that expires.
    }
  }, [stopPolling]);

  const sessionId = session?.session_id ?? null;
  useEffect(() => {
    if (!sessionId) return undefined;
    const timer = window.setInterval(() => {
      heartbeatSession(tokenRef.current, sessionId)
        .then((next) => adopt(next))
        .catch(() => undefined); // the next real action reports a lost session
    }, CALIBRATION_TIMING.heartbeatMs);
    return () => window.clearInterval(timer);
  }, [sessionId, adopt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      const sid = sidRef.current;
      if (sid && !endedRef.current) {
        endedRef.current = true;
        endCalibrationSession(tokenRef.current, sid).catch(() => undefined);
      }
    };
  }, []);

  return {
    session,
    latestRevision,
    noteRevision,
    verifyWithoutSensing,
    setVerifyWithoutSensing,
    applyResult,
    autosense,
    poll,
    polling,
    pollError,
    feed: feedState(session, polling, poll),
    verdict,
    busy,
    start,
    activate,
    apply,
    startSense,
    stopPolling,
    verify,
    printPattern,
    save,
    end,
  };
}

export type CalibrationSessionApi = ReturnType<typeof useCalibrationSession>;
