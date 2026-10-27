/**
 * The Verteilerplan editor's document, its autosave and every edit to it.
 *
 * Autosave, not a Save button
 * ---------------------------
 * Every edit lands in local state immediately and is sent to the server
 * after a short idle. A worker up a ladder does not tap Save, and a lost
 * Verteiler is an hour of re-typing. The trade-off is that a failed save
 * must be *visible*: the page's chip reports "Gespeichert / Speichert… /
 * Nicht gespeichert", and a failure says whether the server refused the
 * board (its reason) or the connection dropped (try again) — the two need
 * different action from the fitter.
 *
 * Whatever reads the board from the server — the Materialliste, a PDF, the
 * label printer, a copy — calls `settleSaves` first, so it never reads the
 * board as it was before the last edit.
 *
 * Every edit is an immutable recipe over the whole document and spreads
 * what it does not touch, so keys this client has no type for (a newer
 * client's additions) survive the next save untouched.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { normalizeEnclosure } from "../utils/enclosureOps";
import { followPosition } from "../utils/enclosureOpsDrag";
import { newBreaker, newId } from "../utils/schaltplanDevices";
import {
  duplicateDevice as duplicateDeviceInDocument,
  removeDevices,
  rowFromTemplate,
  setTerminalsEverywhere,
  type RowTemplateId,
} from "../utils/schaltplanDocumentOps";
import { setTerminalLabel } from "../utils/schaltplanTerminals";
import { updatePanel } from "../utils/schaltplanApi";
import type { DeviceKind, PanelDevice, PanelDocument, PanelPlan, PanelRow, PanelSupply } from "../types/schaltplan";

export type SaveState = "clean" | "pending" | "saving" | "error";

export const AUTOSAVE_DELAY_MS = 900;
export const SAVE_CONNECTION_HINT = "Änderungen konnten nicht gespeichert werden. Prüfe die Verbindung.";
/** A save of the panel open before this one failed: its edit is gone, so it is said — as that panel's. */
export const OTHER_PANEL_NOT_SAVED = "Vorher geöffneter Verteiler nicht gespeichert";

const NEW_ROW_SLOTS = 12;
const MIN_ROW_SLOTS = 1;
const MAX_ROW_SLOTS = 96;

/** A document and the panel it belongs to — an edit is always saved to the panel it was made on. */
export type LoadedDocument = { panelId: number; document: PanelDocument };

export interface PanelDocumentEditorOptions {
  token: string | null;
  readOnly: boolean;
  /** A save landed. The answer carries the server's derived values (revision, counters) — never adopt its document. */
  onSaved: (saved: PanelPlan) => void;
  setError: (message: string) => void;
}

export interface PanelDocumentEditor {
  document: PanelDocument | null;
  saveState: SaveState;
  /** Show another panel's document (or none) without saving it; edits still waiting go to their own panel first. */
  load(target: LoadedDocument | null): void;
  /** Apply an edit and queue the save. A recipe that returns its input unchanged saves nothing. */
  mutate(recipe: (current: PanelDocument) => PanelDocument): void;
  /** Send the waiting edit now. True when nothing waited or it landed. */
  flush(): Promise<boolean>;
  /** Bring the server up to date: wait for the save in flight, then send the rest. False = the latest edits are not on the server. */
  settleSaves(): Promise<boolean>;
  /** Returns the new device's id (null read-only), so the caller can open it. */
  addDevice(rowId: string, kind: DeviceKind): string | null;
  patchDevice(deviceId: string, patch: Partial<PanelDevice>): void;
  removeDevice(deviceId: string): void;
  /** Returns the copy's id, or null when nothing was copied. */
  duplicateDevice(deviceId: string): string | null;
  moveDevice(deviceId: string, direction: -1 | 1): void;
  addRow(): void;
  addRowFromTemplate(templateId: RowTemplateId): void;
  removeRow(rowId: string): void;
  renameRow(rowId: string, label: string): void;
  changeSlots(rowId: string, slots: number): void;
  patchSupply(patch: Partial<PanelSupply>): void;
  setAllTerminals(flag: boolean): void;
  editTerminalLabel(key: string, value: string | null): void;
}

// ── Why a save failed ────────────────────────────────────────────────────────

/**
 * A 4xx is the server refusing this board — saying "check the connection"
 * there sends the fitter looking for a problem that does not exist, and the
 * same edit fails again. Read by shape, not `instanceof ApiError`, so a test
 * that mocks the API client does not change the wording.
 */
function saveErrorMessage(error: unknown, openPanel: boolean): string {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  const refused = typeof status === "number" && status >= 400 && status < 500;
  if (!openPanel) {
    return refused
      ? `${OTHER_PANEL_NOT_SAVED}: ${refusalDetail(error as { detail?: unknown; message?: unknown }, status)}`
      : `${OTHER_PANEL_NOT_SAVED}. Prüfe die Verbindung.`;
  }
  if (!refused) return SAVE_CONNECTION_HINT;
  return `Nicht gespeichert: ${refusalDetail(error as { detail?: unknown; message?: unknown }, status)}`;
}

function refusalDetail(error: { detail?: unknown; message?: unknown }, status: number): string {
  const { detail, message } = error;
  if (typeof detail === "string" && detail.trim()) return detail;
  // FastAPI's validation answer (422): a list of {loc, msg, type}.
  if (Array.isArray(detail)) {
    const first = detail.find((entry) => typeof (entry as { msg?: unknown } | null)?.msg === "string");
    if (first) return (first as { msg: string }).msg;
  }
  if (typeof message === "string" && message.trim()) return message;
  return `HTTP ${status}`;
}

// ── Edits (pure, immutable) ──────────────────────────────────────────────────

function mapRows(document: PanelDocument, change: (row: PanelRow) => PanelRow): PanelDocument {
  return { ...document, rows: document.rows.map(change) };
}


function appendDevice(document: PanelDocument, rowId: string, device: PanelDevice): PanelDocument {
  return mapRows(document, (row) => (row.id === rowId ? { ...row, devices: [...row.devices, device] } : row));
}

function patchDeviceIn(document: PanelDocument, deviceId: string, patch: Partial<PanelDevice>): PanelDocument {
  return mapRows(document, (row) => ({
    ...row,
    devices: row.devices.map((device) => (device.id === deviceId ? { ...device, ...patch } : device)),
  }));
}

/**
 * Move a device one slot. At a rail's edge it hops to the neighbouring rail,
 * because "move left" should mean the same thing at position 0 as anywhere
 * else — order is continuous across the whole board, and so is the
 * protection grouping it drives.
 *
 * The moved circuit then follows its position (`followPosition`, R10 of
 * docs/PANEL_ENCLOSURE_R2.md), exactly like a drag: a step inside a run
 * keeps a deliberate cross-feed, a step past another head clears it.
 */
export function moveDeviceIn(document: PanelDocument, deviceId: string, direction: -1 | 1): PanelDocument {
  const moved = swapOrHop(document, deviceId, direction);
  return moved === document ? document : followPosition(document, moved, deviceId);
}

function swapOrHop(document: PanelDocument, deviceId: string, direction: -1 | 1): PanelDocument {
  const rowIndex = document.rows.findIndex((row) => row.devices.some((device) => device.id === deviceId));
  if (rowIndex < 0) return document;
  const row = document.rows[rowIndex];
  const index = row.devices.findIndex((device) => device.id === deviceId);
  const target = index + direction;

  if (target >= 0 && target < row.devices.length) {
    const devices = [...row.devices];
    [devices[index], devices[target]] = [devices[target], devices[index]];
    return { ...document, rows: document.rows.map((candidate, at) => (at === rowIndex ? { ...candidate, devices } : candidate)) };
  }

  const neighbourIndex = rowIndex + direction;
  if (neighbourIndex < 0 || neighbourIndex >= document.rows.length) return document;
  const device = row.devices[index];
  const rows = document.rows.map((candidate, at) => {
    if (at === rowIndex) return { ...candidate, devices: candidate.devices.filter((entry) => entry.id !== deviceId) };
    if (at !== neighbourIndex) return candidate;
    return { ...candidate, devices: direction === -1 ? [...candidate.devices, device] : [device, ...candidate.devices] };
  });
  return { ...document, rows };
}

function patchRow(document: PanelDocument, rowId: string, patch: Partial<PanelRow>): PanelDocument {
  return mapRows(document, (row) => (row.id === rowId ? { ...row, ...patch } : row));
}

function appendEmptyRow(document: PanelDocument): PanelDocument {
  const row: PanelRow = { id: newId("row"), label: `Reihe ${document.rows.length + 1}`, slots: NEW_ROW_SLOTS, devices: [] };
  return { ...document, rows: [...document.rows, row] };
}

// ── The hook ─────────────────────────────────────────────────────────────────

type PendingSave = { panelId: number; document: PanelDocument };
type InFlightSave = { panelId: number; request: Promise<boolean> };

export function usePanelDocumentEditor(options: PanelDocumentEditorOptions): PanelDocumentEditor {
  const [document, setDocument] = useState<PanelDocument | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("clean");

  // The latest options, read by the callbacks below so they keep their
  // identity: the page memoises on them, and an effect that lists a fresh
  // callback every render re-runs every render.
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  // Refs, not state, for what an edit reads: two edits from one handler must
  // apply on top of each other, and React double-invokes state updaters in
  // StrictMode — scheduling a save from in there sent every edit twice.
  const documentRef = useRef<PanelDocument | null>(null);
  const panelIdRef = useRef<number | null>(null);
  const pending = useRef<PendingSave | null>(null);
  const timer = useRef<number | null>(null);
  // The save on the wire and the panel it is for: settleSaves judges only the open panel by it.
  const inFlight = useRef<InFlightSave | null>(null);
  const saveSeq = useRef(0);

  const clearTimer = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const save = useCallback(async (target: PendingSave, seq: number): Promise<boolean> => {
    try {
      const saved = await updatePanel(latest.current.token, target.panelId, { document: target.document });
      latest.current.onSaved(saved);
      // A newer save queued behind this one owns the chip.
      if (seq === saveSeq.current) setSaveState(pending.current ? "pending" : "clean");
      return true;
    } catch (error) {
      const open = target.panelId === panelIdRef.current;
      // Keep the edit for the next flush or settle — unless newer edits
      // replaced it, or the panel it belongs to is no longer open.
      if (seq === saveSeq.current && !pending.current && open) {
        pending.current = target;
      }
      // The chip is the open panel's; a panel left behind is only named in the message.
      if (open) setSaveState("error");
      latest.current.setError(saveErrorMessage(error, open));
      return false;
    }
  }, []);

  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    const target = pending.current;
    if (!target) return Promise.resolve(true);
    pending.current = null;
    setSaveState("saving");
    saveSeq.current += 1;
    const seq = saveSeq.current;
    const previous = inFlight.current?.request;
    // One PATCH at a time, in edit order: two in flight can land out of
    // order and leave the older document on the server.
    const request = previous ? previous.then(() => save(target, seq)) : save(target, seq);
    const entry: InFlightSave = { panelId: target.panelId, request };
    inFlight.current = entry;
    void request.finally(() => {
      if (inFlight.current === entry) inFlight.current = null;
    });
    return request;
  }, [clearTimer, save]);

  /**
   * Wait until nothing for the open panel is waiting or on the wire. A loop,
   * not one look: while it waits, the timer or the page going hidden (the
   * PDF tab coming to the front) can flush a newer edit behind the awaited
   * request, and the server holds the latest edits only once that one has
   * landed too. A save of the panel left behind is waited for (one PATCH at
   * a time) but says nothing about this one. A failed flush ends the wait:
   * the edit stays queued for the next try, not retried here in a loop.
   */
  const settleSaves = useCallback(async (): Promise<boolean> => {
    clearTimer();
    let ok = true;
    let awaited: InFlightSave | null = null;
    for (;;) {
      const current = inFlight.current;
      if (current && current !== awaited) {
        awaited = current;
        const landed = await current.request;
        if (current.panelId === panelIdRef.current) ok = landed;
        continue;
      }
      if (!pending.current) return ok;
      clearTimer();
      if (!(await flush())) return false;
      ok = true;
    }
  }, [clearTimer, flush]);

  const scheduleSave = useCallback(
    (next: PanelDocument) => {
      const panelId = panelIdRef.current;
      if (panelId == null) return;
      pending.current = { panelId, document: next };
      setSaveState("pending");
      clearTimer();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        void flush();
      }, AUTOSAVE_DELAY_MS);
    },
    [clearTimer, flush],
  );

  // Flush when the page is hidden and on unmount — a worker switching apps or
  // locking the tablet is the most common way an edit would otherwise be lost.
  useEffect(() => {
    const onVisibility = () => {
      if (window.document.visibilityState === "hidden" && pending.current) void flush();
    };
    window.document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.document.removeEventListener("visibilitychange", onVisibility);
      clearTimer();
      if (pending.current) void flush();
    };
  }, [clearTimer, flush]);

  const load = useCallback(
    (target: LoadedDocument | null) => {
      if (pending.current) void flush();
      clearTimer();
      panelIdRef.current = target?.panelId ?? null;
      documentRef.current = target?.document ?? null;
      setDocument(documentRef.current);
      setSaveState("clean");
    },
    [clearTimer, flush],
  );

  const mutate = useCallback(
    (recipe: (current: PanelDocument) => PanelDocument) => {
      const current = documentRef.current;
      if (latest.current.readOnly || !current) return;
      const edited = recipe(current);
      // Nothing changed: a PATCH would still bump the printed revision.
      if (edited === current) return;
      // A cabinet board goes out normalised (§10.2): a duplicate module id or
      // a row on two rails — a stale tab can leave either — is a 422 on every
      // save. A clean document comes back as is.
      const next = edited.enclosure ? normalizeEnclosure(edited) : edited;
      documentRef.current = next;
      setDocument(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  const ops = useDocumentOps(mutate);

  return { document, saveState, load, mutate, flush, settleSaves, ...ops };
}

/** The named edits, each one recipe through `mutate`. */
function useDocumentOps(mutate: PanelDocumentEditor["mutate"]) {
  const addDevice = useCallback(
    (rowId: string, kind: DeviceKind): string | null => {
      let created: string | null = null;
      mutate((current) => {
        // Breakers get the next free Stromkreis-Nr. (always filled in, nobody wants to look it up) and their phase.
        const device = newBreaker(current, current.rows.find((row) => row.id === rowId), kind);
        created = device.id;
        return appendDevice(current, rowId, device);
      });
      return created;
    },
    [mutate],
  );

  const duplicateDevice = useCallback(
    (deviceId: string): string | null => {
      let copyId: string | null = null;
      mutate((current) => {
        const result = duplicateDeviceInDocument(current, deviceId);
        if (!result.deviceId) return current;
        copyId = result.deviceId;
        return result.document;
      });
      return copyId;
    },
    [mutate],
  );

  const patchDevice = useCallback(
    (deviceId: string, patch: Partial<PanelDevice>) => mutate((current) => patchDeviceIn(current, deviceId, patch)),
    [mutate],
  );
  const removeDevice = useCallback(
    (deviceId: string) => mutate((current) => removeDevices(current, [deviceId])),
    [mutate],
  );
  const moveDevice = useCallback(
    (deviceId: string, direction: -1 | 1) => mutate((current) => moveDeviceIn(current, deviceId, direction)),
    [mutate],
  );
  const addRow = useCallback(() => mutate(appendEmptyRow), [mutate]);
  const addRowFromTemplate = useCallback(
    (templateId: RowTemplateId) =>
      mutate((current) => ({ ...current, rows: [...current.rows, rowFromTemplate(current, templateId)] })),
    [mutate],
  );
  const removeRow = useCallback(
    (rowId: string) => mutate((current) => ({ ...current, rows: current.rows.filter((row) => row.id !== rowId) })),
    [mutate],
  );
  const renameRow = useCallback(
    (rowId: string, label: string) => mutate((current) => patchRow(current, rowId, { label })),
    [mutate],
  );
  const changeSlots = useCallback(
    (rowId: string, slots: number) =>
      mutate((current) => patchRow(current, rowId, { slots: Math.max(MIN_ROW_SLOTS, Math.min(MAX_ROW_SLOTS, slots)) })),
    [mutate],
  );
  const patchSupply = useCallback(
    (patch: Partial<PanelSupply>) => mutate((current) => ({ ...current, supply: { ...current.supply, ...patch } })),
    [mutate],
  );
  /** "Reihenklemme am Abgang" on or off on the whole board — see `setTerminalsEverywhere`. */
  const setAllTerminals = useCallback(
    (flag: boolean) => mutate((current) => setTerminalsEverywhere(current, flag)),
    [mutate],
  );
  /**
   * One Reihenklemmen marker text overridden in the document. Lives on the
   * document, not the device: the print dialog and the inspector both edit
   * it, and the printer reads it from the saved document.
   */
  const editTerminalLabel = useCallback(
    (key: string, value: string | null) => mutate((current) => setTerminalLabel(current, key, value)),
    [mutate],
  );

  return {
    addDevice,
    patchDevice,
    removeDevice,
    duplicateDevice,
    moveDevice,
    addRow,
    addRowFromTemplate,
    removeRow,
    renameRow,
    changeSlots,
    patchSupply,
    setAllTerminals,
    editTerminalLabel,
  };
}
