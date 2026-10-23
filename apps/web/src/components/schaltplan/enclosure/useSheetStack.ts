/**
 * The Schrank tab's one sheet stack (docs/PANEL_ENCLOSURE.md §11).
 *
 * RailSheet → DeviceInspector → Palette / RailPicker open on top of each
 * other (as does the terminal close-up → RailSheet), and closing one
 * returns to the one below — the fitter who tapped a rail, fixed a breaker
 * and closed the inspector wants the rail again, not the bare drawing. So
 * there is exactly one stack, the tab renders its top sheet only, behind
 * exactly one backdrop (`SheetBackdrop`), and every way
 * out — the sheet's ‹ button, Escape, a tap on the backdrop — goes back one
 * step (`back`). × closes the stack.
 *
 * One step is usually one sheet. A sheet with a step of its own — the
 * catalogue admin's form, whose ‹ returns to its list — sets a back handler
 * while it is mounted, and ‹, Escape and the backdrop then all take that
 * step, so none of them throws the sheet away under a half-typed entry.
 * Only the top sheet is mounted, so only it can have one.
 *
 * Escape typed into a text field belongs to the field (a search box clears
 * itself, an IME or an autocomplete closes); it never takes the sheet away.
 *
 * "Back" is the sheet's ‹ button, not the browser's: the app keeps no
 * history entries for its views, and a pushed entry per sheet would leave
 * the browser's back button walking through sheets long closed.
 *
 * This module also carries the contract between the sheets and the tab:
 * a sheet never edits the document itself. It hands an `EnclosureOp` to
 * `onOp`, and the tab runs it on the current document — a refusal becomes
 * its message, `regrouped` opens RegroupConfirm first, `pinned` a toast —
 * and calls `then` once the op is applied (never when refused or cancelled).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CatalogIndex } from "../../../utils/enclosureCatalog";
import type { OpResult } from "../../../utils/enclosureOps";
import type { Regroup } from "../../../utils/enclosureFeeds";
import type { DeviceKind, PanelDocument } from "../../../types/schaltplan";

// ── The sheets ↔ tab contract ────────────────────────────────────────────────

/** A cabinet op, run by the tab on the document as it is when it runs. */
export type EnclosureOp = (document: PanelDocument, index: CatalogIndex) => OpResult;
export type AppliedOp = Extract<OpResult, { ok: true }>;
/** Run an op; `then` follows once it is applied — after the regroup confirm, if one was needed. */
export type RunEnclosureOp = (op: EnclosureOp, then?: (result: AppliedOp) => void) => void;
/** A plain edit that moves no row (meter number, labels): the editor's `mutate`. */
export type EditDocument = (recipe: (document: PanelDocument) => PanelDocument) => void;

/** "+ Gerät": the tab opens the palette for `label`, pops it, then calls `pick` with the chosen kind. */
export interface DeviceChoiceRequest {
  label: string;
  pick: (kind: DeviceKind) => void;
}

/**
 * The module picker's two switches. Kept in its stack entry, not in the
 * sheet: only the top sheet is mounted, so a sheet pushed on top (the
 * catalogue admin, the regroup question) would otherwise reset them.
 */
export interface PickerSwitches {
  /** "Vorhandene Geräte übernehmen" — on by default. */
  claim: boolean;
  /** "Vorhandene Reihen übernehmen" — off by default. */
  adopt: boolean;
}

export const DEFAULT_PICKER_SWITCHES: PickerSwitches = Object.freeze({ claim: true, adopt: false });

/** The sheets of the Schrank tab. The tab may use its own union; this one names every sheet §11 lists. */
export type EnclosureSheet =
  | { kind: "enclosure-picker" }
  | { kind: "module-picker"; field: number; unit: number | null; switches?: PickerSwitches }
  | { kind: "module"; moduleId: string }
  | { kind: "rail"; moduleId: string; railKey: string; deviceId: string | null }
  | { kind: "inspector"; deviceId: string }
  | { kind: "palette"; request: DeviceChoiceRequest }
  | { kind: "rail-picker"; deviceId: string }
  /** The close-up of a field's terminal rails (R2 §7.2); `stripId` = the selected strip. */
  | { kind: "terminals"; field: number; stripId: string | null }
  | { kind: "regroup"; before: PanelDocument; after: PanelDocument; regrouped: Regroup[]; apply: () => void }
  | { kind: "catalog-admin" };

// ── The stack ────────────────────────────────────────────────────────────────

export interface SheetStack<T> {
  /** Bottom → top. A new array on every change; never edited in place. */
  entries: readonly T[];
  top: T | null;
  depth: number;
  push(entry: T): void;
  /** Close the top sheet. The stack's own move: never intercepted. */
  pop(): void;
  /** What ‹, Escape and the backdrop do: the top sheet's own back step when it set one, else `pop`. */
  back(): void;
  /** The top sheet's own back step while it is mounted; null when it has none again. */
  setBackHandler(handler: (() => void) | null): void;
  /** Put `entry` in place of the top sheet (or open it, when nothing is open). */
  replaceTop(entry: T): void;
  /** Close everything, then open `entry` when given. */
  reset(entry?: T): void;
  /** Close everything (×). */
  close(): void;
  /** Drop the sheets whose target is gone (a removed module, a deleted device). */
  removeWhere(predicate: (entry: T) => boolean): void;
}

export interface SheetStackOptions {
  /** Pop on Escape while a sheet is open. Default true. */
  escape?: boolean;
}

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["", "text", "search", "email", "tel", "url", "number", "password", "date", "datetime-local", "month", "time", "week"]);

/** A field the Escape key means something in: text inputs, text areas, selects, editable content. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editable = target.getAttribute("contenteditable");
  if (target.isContentEditable || (editable !== null && editable !== "false")) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type.toLowerCase());
}

export function useSheetStack<T = EnclosureSheet>(options: SheetStackOptions = {}): SheetStack<T> {
  const [entries, setEntries] = useState<readonly T[]>([]);
  const backHandler = useRef<(() => void) | null>(null);
  const listenToEscape = options.escape !== false && entries.length > 0;

  const push = useCallback((entry: T) => setEntries((current) => [...current, entry]), []);
  const pop = useCallback(() => setEntries((current) => (current.length === 0 ? current : current.slice(0, -1))), []);
  const back = useCallback(() => {
    if (backHandler.current) backHandler.current();
    else pop();
  }, [pop]);
  const setBackHandler = useCallback((handler: (() => void) | null) => {
    backHandler.current = handler;
  }, []);
  const replaceTop = useCallback((entry: T) => setEntries((current) => [...current.slice(0, -1), entry]), []);
  const reset = useCallback((entry?: T) => setEntries(entry === undefined ? [] : [entry]), []);
  const close = useCallback(() => setEntries((current) => (current.length === 0 ? current : [])), []);
  const removeWhere = useCallback(
    (predicate: (entry: T) => boolean) =>
      setEntries((current) => {
        const kept = current.filter((entry) => !predicate(entry));
        return kept.length === current.length ? current : kept;
      }),
    [],
  );

  useEffect(() => {
    if (!listenToEscape) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // Someone closer to the focus took it, or an IME is choosing a word.
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // Typed into a field, Escape is the field's — never a reason to drop what is in it.
      if (isTextEntry(event.target)) return;
      event.preventDefault();
      back();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [listenToEscape, back]);

  return useMemo(
    () => ({
      entries,
      top: entries.length > 0 ? entries[entries.length - 1] : null,
      depth: entries.length,
      push,
      pop,
      back,
      setBackHandler,
      replaceTop,
      reset,
      close,
      removeWhere,
    }),
    [entries, push, pop, back, setBackHandler, replaceTop, reset, close, removeWhere],
  );
}
