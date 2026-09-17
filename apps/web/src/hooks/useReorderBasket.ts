/**
 * useReorderBasket — the Nachbestellen basket, shared by both reorder screens.
 *
 * One endpoint feeds two pages (desktop table, phone accordion), and both do
 * the same three things: read `GET /werkstatt/reorder/suggestions`, let the
 * buyer change quantities, and send ONE supplier's basket through
 * `POST /werkstatt/reorder/submit`. Keeping that here means the two screens
 * cannot drift on the part that spends money.
 *
 * The submit is not a plain POST. It creates the draft, runs the pre-send
 * resolution and transitions the order to `sent` in a single transaction — so
 * a 409 `unresolved_lines` means NOTHING was created and nothing was sent.
 * That refusal is kept per supplier as a `conflict` state carrying the
 * server's own positions and warnings, and the pages offer the same
 * "Trotzdem übergeben" the Bestellungen drawer offers (see
 * `hooks/useOrderHandover.ts` and `components/werkstatt/BestellungVersandLeiste.tsx`),
 * which re-submits with `allow_unresolved`.
 *
 * A group that HAS been sent keeps its order on screen and drops out of the
 * basket totals, and it keeps both ACROSS a reload of the list: the suggestion
 * engine does not look at open orders, so the same shortfall comes back in
 * full and a second click would create a second order for it. Only the buyer
 * dismissing the panel unblocks that supplier again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAppContext } from "../context/AppContext";
import { createRequestSequence } from "../utils/latestRequest";
import { unresolvedLinesConflict } from "../utils/werkstattOrdersApi";
import {
  sendStatesAcrossReload,
  submitFailureOutcome,
  type ReorderSendState,
} from "../utils/reorderSendState";
import {
  basketTotals,
  groupTotals,
  quantityOf,
  submitLinesFor,
  withQuantity,
  type ReorderBasketTotals,
  type ReorderGroupTotals,
  type ReorderQuantities,
} from "../utils/reorderBasket";
import {
  listReorderSuggestions,
  submitReorder,
  type ReorderSuggestionGroup,
  type ReorderSuggestionLine,
} from "../utils/werkstattReorderApi";

// The state machine itself lives in utils/reorderSendState.ts — it is pure,
// and two of its rules (what a failed send proves, what survives a reload)
// are money decisions worth testing without React. Re-exported because the
// two group components read it from here.
export type { ReorderSendState } from "../utils/reorderSendState";

export interface ReorderBasket {
  /**
   * True from the moment the tab becomes active until a response has arrived —
   * the request itself has not been issued yet on the first frame. Nothing
   * numeric may be rendered while this is true.
   */
  loading: boolean;
  /** Set when the list could not be read. The pages must then show NO numbers. */
  loadError: string | null;
  groups: readonly ReorderSuggestionGroup[];
  reload: () => void;
  /** True while any supplier's submission is in flight. */
  busy: boolean;
  /** `werkstatt:manage` — the permission POST /reorder/submit enforces. */
  canManage: boolean;
  quantityFor: (group: ReorderSuggestionGroup, line: ReorderSuggestionLine) => number;
  setQuantity: (supplierId: number, articleId: number, quantity: number) => void;
  stepQuantity: (supplierId: number, line: ReorderSuggestionLine, delta: number) => void;
  totals: ReorderBasketTotals;
  totalsFor: (group: ReorderSuggestionGroup) => ReorderGroupTotals;
  sendStateFor: (supplierId: number) => ReorderSendState | null;
  /** Resolves once this supplier's attempt has settled, so a caller can
   *  send several suppliers one after another. */
  submitGroup: (group: ReorderSuggestionGroup, allowUnresolved: boolean) => Promise<void>;
  /**
   * Drop one supplier's panel without sending anything. For a `sent` or an
   * unknown-outcome state this is also the ONLY way back to the order button,
   * which is the point: re-ordering that supplier has to be a decision.
   */
  dismissSendState: (supplierId: number) => void;
}

export function useReorderBasket(active: boolean): ReorderBasket {
  const { token, user } = useAppContext();

  const [groups, setGroups] = useState<readonly ReorderSuggestionGroup[]>([]);
  const [fetching, setFetching] = useState(false);
  /** Has a response for the CURRENT visit actually arrived? See `loading`. */
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<ReorderQuantities>(() => new Map());
  const [sendStates, setSendStates] = useState<ReadonlyMap<number, ReorderSendState>>(
    () => new Map(),
  );
  // Bumped by `reload`; the effect below depends on it, so a manual refresh is
  // a re-run of the same code path rather than a second copy of it.
  const [reloadToken, setReloadToken] = useState(0);

  const sequence = useRef(createRequestSequence());
  /** Suppliers with a request in flight. A ref, not state: the guard has to
   *  hold across a sequential "send every supplier" loop, where a stale
   *  closure over `sendStates` would not. */
  const inFlight = useRef<Set<number>>(new Set());
  /** The live quantities for `submitGroup`, which must not be re-created on
   *  every keystroke — the phone screen sends inside an await loop. */
  const quantitiesRef = useRef<ReorderQuantities>(quantities);
  useEffect(() => {
    quantitiesRef.current = quantities;
  }, [quantities]);

  const canManage = (user?.effective_permissions ?? []).includes("werkstatt:manage");

  // Leaving the tab forgets that the list was ever read. Both pages stay
  // mounted and only self-gate on `active`, so without this the first frame
  // after re-entry would render the PREVIOUS visit's numbers as current — and
  // on a first visit it would render the empty state before the GET was even
  // issued, because a passive effect runs after that frame has been painted.
  useEffect(() => {
    if (!active) setHasLoaded(false);
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    const ticket = sequence.current.issue();
    const controller = new AbortController();
    setFetching(true);
    setLoadError(null);
    listReorderSuggestions(token, controller.signal)
      .then((loaded) => {
        if (!sequence.current.isCurrent(ticket)) return;
        setGroups(loaded);
        // A fresh list invalidates the buyer's quantity edits: they were made
        // against lines that may be gone. It does NOT invalidate an order
        // that exists — see `sendStatesAcrossReload`.
        setQuantities(new Map());
        setSendStates(sendStatesAcrossReload);
        setHasLoaded(true);
        setFetching(false);
      })
      .catch((err: unknown) => {
        if (!sequence.current.isCurrent(ticket) || controller.signal.aborted) return;
        // No numbers survive a failed load — an empty list would read as
        // "nothing to order", which is the one wrong answer here.
        setGroups([]);
        setLoadError(err instanceof Error ? err.message : String(err));
        setFetching(false);
      });
    return () => {
      controller.abort();
    };
  }, [active, token, reloadToken]);

  /**
   * "Loading" covers the gap before the request exists, not just the request.
   *
   * The pages gate their empty state and their KPI numbers on `!loading`, and
   * the one wrong answer this page can give is a calm "Nichts nachzubestellen"
   * over a list nobody has read yet.
   */
  const loading = fetching || (active && !hasLoaded && loadError === null);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  const setQuantity = useCallback((supplierId: number, articleId: number, quantity: number) => {
    setQuantities((current) => withQuantity(current, supplierId, articleId, quantity));
  }, []);

  const stepQuantity = useCallback(
    (supplierId: number, line: ReorderSuggestionLine, delta: number) => {
      setQuantities((current) =>
        withQuantity(
          current,
          supplierId,
          line.article_id,
          quantityOf(current, supplierId, line) + delta,
        ),
      );
    },
    [],
  );

  const quantityFor = useCallback(
    (group: ReorderSuggestionGroup, line: ReorderSuggestionLine) =>
      quantityOf(quantities, group.supplier_id, line),
    [quantities],
  );

  const sentSupplierIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [supplierId, state] of sendStates) {
      if (state.kind === "sent") ids.add(supplierId);
    }
    return ids;
  }, [sendStates]);

  const totals = useMemo(
    () => basketTotals(groups, quantities, sentSupplierIds),
    [groups, quantities, sentSupplierIds],
  );

  const totalsFor = useCallback(
    (group: ReorderSuggestionGroup) => groupTotals(group, quantities),
    [quantities],
  );

  const sendStateFor = useCallback(
    (supplierId: number) => sendStates.get(supplierId) ?? null,
    [sendStates],
  );

  const putSendState = useCallback((supplierId: number, state: ReorderSendState | null) => {
    setSendStates((current) => {
      const next = new Map(current);
      if (state === null) next.delete(supplierId);
      else next.set(supplierId, state);
      return next;
    });
  }, []);

  const dismissSendState = useCallback(
    (supplierId: number) => putSendState(supplierId, null),
    [putSendState],
  );

  const submitGroup = useCallback(
    async (group: ReorderSuggestionGroup, allowUnresolved: boolean) => {
      const supplierId = group.supplier_id;
      const lines = submitLinesFor(group, quantitiesRef.current);
      // Nothing to send is not an error: the buyer zeroed every line. The
      // pages disable the button in that state, so this is the double-click
      // guard rather than a message.
      if (lines.length === 0 || inFlight.current.has(supplierId)) return;
      inFlight.current.add(supplierId);
      putSendState(supplierId, { kind: "sending" });
      try {
        const order = await submitReorder(token, {
          supplier_id: supplierId,
          lines,
          notes: null,
          allow_unresolved: allowUnresolved,
        });
        putSendState(supplierId, {
          kind: "sent",
          order,
          allowUnresolved,
          // What went out, kept per article: a reload replaces the list's
          // quantities with fresh suggestions, and the locked numbers under a
          // sent order must stay the ones that were actually ordered.
          orderedQuantities: new Map(lines.map((line) => [line.article_id, line.quantity])),
          carriedOver: false,
        });
      } catch (err: unknown) {
        const refused = unresolvedLinesConflict(err);
        if (refused) {
          // Not an error: the server is asking a question, and nothing was
          // created. The page lists the positions and offers the override.
          putSendState(supplierId, {
            kind: "conflict",
            detail: refused,
            submittedArticleIds: lines.map((line) => line.article_id),
          });
        } else {
          // Not every failure proves the order does not exist: the endpoint
          // commits before it answers, so a connection that dropped leaves
          // the outcome genuinely open. `submitFailureOutcome` decides which
          // sentence the panel is allowed to say.
          putSendState(supplierId, {
            kind: "error",
            outcome: submitFailureOutcome(err),
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        inFlight.current.delete(supplierId);
      }
    },
    [putSendState, token],
  );

  const busy = useMemo(
    () => [...sendStates.values()].some((state) => state.kind === "sending"),
    [sendStates],
  );

  return {
    loading,
    loadError,
    groups,
    reload,
    busy,
    canManage,
    quantityFor,
    setQuantity,
    stepQuantity,
    totals,
    totalsFor,
    sendStateFor,
    submitGroup,
    dismissSendState,
  };
}
