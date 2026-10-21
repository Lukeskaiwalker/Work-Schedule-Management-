/**
 * useKistenQtyWrites — how a crate line's new count reaches the server.
 *
 * A − / + tap and a typed number (KistenQtyControl) both land here: the line
 * shows the new count at once, and one PATCH per line goes out after a short
 * pause with the latest value (DELETE at 0). Writes run one at a time, and
 * each ends by showing what the server now holds — a failed one snaps back.
 *
 * Lifted out of WerkstattKistenPage, where it was a timer map, a promise chain
 * and an overlay, because three bugs lived where those met the rest of the
 * page:
 *
 *   - Nothing waited for a count still in its pause. "Übergabe buchen" right
 *     after typing booked the stock out at the old count and the typed one
 *     was refused afterwards. Crate actions now `flush` first.
 *   - Every write ended by opening its crate, so one landing after "← Alle
 *     Kisten" or another crate was tapped brought the crate back. What to
 *     show afterwards is the page's `onSettled`, which knows what is open.
 *   - A finished write dropped the line's shown count even when a newer one
 *     had been entered meanwhile, and that one was never sent. The waiting
 *     value now travels with its own timer, and the shown count goes only
 *     while it is still this write's.
 */
import { useCallback, useRef, useState } from "react";

import { ApiError, apiFetch } from "../../api/client";
import { commitFocusedQuantity } from "./KistenQtyControl";

/** Pause after the last tap or entry before a line's count is sent. */
export const QTY_DEBOUNCE_MS = 350;

type Line = { id: number; quantity: number };

/** A count not sent yet: its crate, the value, and the timer that will send it. */
type Waiting = { boxId: number; target: number; timer: number };

export interface KistenQtyWritesOptions {
  token: string | null;
  /** After a write landed or failed: show what the server now holds. */
  onSettled: (boxId: number) => Promise<void>;
  onError: (message: string) => void;
}

export interface KistenQtyWrites {
  /** The count to show for a line: the one waiting or under way, if any. */
  quantityOf: (line: Line) => number;
  /** A new count for a line of crate `boxId`. 0 removes the line. */
  setQuantity: (boxId: number, line: Line, requested: number) => void;
  /**
   * Commit a number still in its field, send every waiting count now, and
   * resolve once all writes under way have finished: true when every one
   * landed. Crate actions await it, so they never run ahead of a count.
   */
  flush: () => Promise<boolean>;
}

function without<T>(record: Record<number, T>, key: number): Record<number, T> {
  const rest = { ...record };
  delete rest[key];
  return rest;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function writeLine(token: string | null, boxId: number, itemId: number, target: number) {
  const url = `/werkstatt/boxes/${boxId}/items/${itemId}`;
  if (target > 0) {
    await apiFetch(url, token, { method: "PATCH", body: JSON.stringify({ quantity: target }) });
    return;
  }
  try {
    await apiFetch(url, token, { method: "DELETE" });
  } catch (err: unknown) {
    // Already gone is the outcome we wanted — only a real failure deserves a banner.
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
}

export function useKistenQtyWrites({ token, onSettled, onError }: KistenQtyWritesOptions): KistenQtyWrites {
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const waitingRef = useRef<Record<number, Waiting>>({});
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  /** Writes that failed so far; `flush` compares before and after. */
  const failuresRef = useRef(0);
  // A timer fires after later renders: it must reach the page's current callbacks.
  const callbacksRef = useRef({ token, onSettled, onError });
  callbacksRef.current = { token, onSettled, onError };

  const send = useCallback((boxId: number, itemId: number, target: number) => {
    const run = async () => {
      const current = callbacksRef.current;
      try {
        await writeLine(current.token, boxId, itemId, target);
      } catch (err: unknown) {
        failuresRef.current += 1;
        current.onError(messageOf(err));
      }
      try {
        await current.onSettled(boxId);
      } catch (err: unknown) {
        current.onError(messageOf(err));
      }
      // A newer count entered while this one was under way stays on screen:
      // its own timer sends it.
      setOverrides((prev) => (prev[itemId] === target ? without(prev, itemId) : prev));
    };
    // Never rejects (run catches), so one failed write cannot stall the next.
    queueRef.current = queueRef.current.then(run);
  }, []);

  const setQuantity = useCallback(
    (boxId: number, line: Line, requested: number) => {
      // Compare against what is waiting or shown, never the last-fetched list:
      // the control steps from the shown count, so rapid taps compound, and a
      // number equal to what the line already shows sends nothing.
      const current = waitingRef.current[line.id]?.target ?? overridesRef.current[line.id] ?? line.quantity;
      const next = Math.max(0, requested);
      if (next === current) return;
      setOverrides((prev) => ({ ...prev, [line.id]: next }));

      const earlier = waitingRef.current[line.id];
      if (earlier) window.clearTimeout(earlier.timer);
      const timer = window.setTimeout(() => {
        const due = waitingRef.current[line.id];
        // Sent by a flush already, or replaced by a later count with its own timer.
        if (due?.timer !== timer) return;
        waitingRef.current = without(waitingRef.current, line.id);
        send(due.boxId, line.id, due.target);
      }, QTY_DEBOUNCE_MS);
      waitingRef.current = { ...waitingRef.current, [line.id]: { boxId, target: next, timer } };
    },
    [send],
  );

  const flush = useCallback(async () => {
    // Synchronous up to the await: the commit lands in waitingRef before it is read.
    commitFocusedQuantity();
    const failuresBefore = failuresRef.current;
    const waiting = Object.entries(waitingRef.current);
    waitingRef.current = {};
    for (const [itemId, entry] of waiting) {
      window.clearTimeout(entry.timer);
      send(entry.boxId, Number(itemId), entry.target);
    }
    await queueRef.current;
    return failuresRef.current === failuresBefore;
  }, [send]);

  const quantityOf = useCallback((line: Line) => overrides[line.id] ?? line.quantity, [overrides]);

  return { quantityOf, setQuantity, flush };
}
