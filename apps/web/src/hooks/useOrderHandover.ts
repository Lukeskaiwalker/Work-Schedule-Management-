/**
 * useOrderHandover — getting an order out of the building, from the page.
 *
 * Everything on the Orders page that SENDS lives here: the punchout tab, the
 * CSV / clipboard export, the 409 that refuses a short basket and the
 * "Trotzdem übergeben" that overrides it, and the two writes that put a
 * supplier's article number where it belongs. Extracted from
 * `WerkstattOrdersPage` so the page stays a list plus a drawer; the hook
 * borrows the page's state setters rather than owning copies of `busy` and
 * `error`, because the drawer's other mutations share those.
 */
import { useCallback, useState } from "react";

import type { SendConflict, SendRoute } from "../components/werkstatt/BestellungVersandLeiste";
import type { WerkstattOrder, WerkstattOrderLine } from "../types/werkstatt";
import type { OrderResolutionAlternative } from "../types/werkstattProcurement";
import {
  addArticleSupplierLink,
  updateArticleSupplierLink,
} from "../utils/werkstattArticlesApi";
import {
  exportOrder,
  getOrder,
  submitOrderToShop,
  unresolvedLinesConflict,
  updateOrderLine,
} from "../utils/werkstattOrdersApi";

// Excel opens a UTF-8 CSV with umlauts intact only when it starts with a BOM.
const CSV_BOM = "﻿";

/**
 * Copy text that is still being fetched.
 *
 * WebKit — Safari, and every browser on the office iPads — allows a clipboard
 * write only inside the user gesture; `writeText` after an awaited fetch is
 * refused with NotAllowedError, and the export the server had already stamped
 * as handed over then never reached the clipboard. A ClipboardItem whose
 * `text/plain` is a PROMISE is the sanctioned way round that: the item is
 * handed to the clipboard synchronously, inside the click, and the bytes
 * arrive when they arrive. Chromium accepts the same shape. Where
 * ClipboardItem does not exist the plain write is tried after the fetch (it
 * works inside Chromium's activation window), and `false` tells the caller
 * to show the text instead of pretending it was copied.
 *
 * Must be called synchronously from the click handler — before any await —
 * with the promise created in that same tick.
 */
export async function copyTextFromPromise(textPromise: Promise<string>): Promise<boolean> {
  // Observed here, so a refused export (409) never surfaces as an unhandled
  // rejection from a promise nobody awaited; the caller awaits the original.
  textPromise.catch(() => undefined);
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) return false;
  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    try {
      const item = new ClipboardItem({
        "text/plain": textPromise.then((text) => new Blob([text], { type: "text/plain" })),
      });
      await clipboard.write([item]);
      return true;
    } catch {
      /* Not supported here, or refused: try the plain write below. */
    }
  }
  if (typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(await textPromise);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export interface OrderHandoverDeps {
  token: string | null;
  de: boolean;
  activeOrder: WerkstattOrder | null;
  setActiveOrder: (order: WerkstattOrder | null) => void;
  refresh: () => Promise<void>;
  runMutation: (action: () => Promise<WerkstattOrder | null>) => Promise<void>;
  reportError: (err: unknown) => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string | null) => void;
  setBlockedShopUrl: (url: string | null) => void;
  /**
   * The exported article numbers when the clipboard refused them. The page
   * shows them in a selectable box under the notice, so a hand-over the
   * server has already stamped is never lost between response and paste.
   */
  setClipboardFallback: (text: string | null) => void;
}

export function useOrderHandover({
  token,
  de,
  activeOrder,
  setActiveOrder,
  refresh,
  runMutation,
  reportError,
  setBusy,
  setError,
  setNotice,
  setBlockedShopUrl,
  setClipboardFallback,
}: OrderHandoverDeps) {
  // The last refused hand-over (409 unresolved_lines), until dismissed or
  // overridden with "Trotzdem übergeben".
  const [conflict, setConflict] = useState<SendConflict | null>(null);

  /**
   * Open a punchout hand-over.
   *
   * A NEW TAB, never this one: the URL serves a form that posts itself to the
   * wholesaler, so navigating in place would replace the app. The tab is
   * opened synchronously from the click and its location set once the token
   * arrives — opening it after the await would be swallowed by the popup
   * blocker, which only trusts a window opened during a user gesture.
   *
   * `noopener` must NOT go in the feature string, however much it looks like it
   * belongs there. The HTML spec says window.open returns null when noopener is
   * set — deliberately, since noopener exists to sever the very handle it would
   * return. This previously read `window.open("", "_blank", "noopener,...")`,
   * so `tab` was null on every call, control fell through to
   * `window.location.assign`, and the buyer's own tab was navigated to the shop
   * while the blank tab just opened was orphaned. Exporting a cart therefore
   * meant leaving SMPL, and a buyer who then decided not to order had no way
   * back. The opener link is cut on the handle instead, which achieves the same
   * protection and keeps the reference.
   *
   * When the popup is blocked outright we now say so rather than navigating in
   * place. Hijacking the tab is worse than not opening the shop: the buyer
   * loses their order view either way, but silently.
   */
  const openHandoff = useCallback(
    async (
      request: () => Promise<{ handoff_url: string; warnings?: string[] }>,
      route: SendRoute | null = null,
    ) => {
      const tab = window.open("", "_blank");
      if (tab) {
        try {
          // Reverse-tabnabbing guard, applied while the tab is still
          // about:blank and reachable. Survives the navigation to the shop.
          tab.opener = null;
        } catch {
          /* Some embedded webviews refuse the assignment; not worth failing the
             hand-over over, and the shop is a known origin. */
        }
      }
      setBusy(true);
      setError(null);
      setBlockedShopUrl(null);
      setClipboardFallback(null);
      try {
        const handoff = await request();
        // Resolve against our own origin explicitly. The server returns a
        // relative path — the handoff page is ours, and hard-coding an
        // absolute base is what previously sent everyone to https://localhost.
        // The target tab is still `about:blank` at this point, and relying on
        // it to inherit the opener's base URL for a relative href is subtle
        // enough to be worth not relying on.
        const target = new URL(handoff.handoff_url, window.location.origin).toString();
        const warned = handoff.warnings?.length ? `${handoff.warnings.join(" · ")} — ` : "";

        if (tab && !tab.closed) {
          tab.location.href = target;
          const opened = de
            ? "Shop im neuen Tab geöffnet. Dieses Fenster bleibt offen."
            : "Shop opened in a new tab. This window stays open.";
          setNotice(`${warned}${opened}`);
        } else {
          // Blocked, or closed again before the token arrived. Hand the buyer a
          // link instead of moving them: a real anchor clicked by them is a
          // fresh user gesture that no blocker refuses.
          setBlockedShopUrl(target);
          setNotice(
            warned +
              (de
                ? "Der Browser hat das Shop-Fenster blockiert — bitte über den Link unten öffnen."
                : "The browser blocked the shop window — please use the link below."),
          );
        }
      } catch (err) {
        // The tab was opened before the request (popup-blocker rule above);
        // on any failure it must go, or the buyer is left with a blank tab.
        tab?.close();
        const refused = unresolvedLinesConflict(err);
        if (refused && route) {
          // Not an error: the server is asking a question. The drawer shows
          // the positions and offers "Trotzdem übergeben".
          setConflict({ route, detail: refused });
        } else {
          reportError(err);
        }
      } finally {
        setBusy(false);
      }
    },
    [de, reportError, setBlockedShopUrl, setBusy, setClipboardFallback, setError, setNotice],
  );

  /**
   * The manual-channel hand-over: CSV to a file, or article numbers to the
   * clipboard. One server call returns both; `format` picks which the buyer
   * asked for. The 409 lands in the same conflict panel as the shop route.
   *
   * Runs synchronously from the click up to the clipboard hand-off: the
   * export promise is created and given to the clipboard before the first
   * await, which is what keeps WebKit's gesture rule satisfied (see
   * `copyTextFromPromise`). When the clipboard still refuses, the numbers
   * are shown in a box instead — the server has stamped the order as handed
   * over by then, and that must not be the moment the list gets lost.
   */
  const exportActiveOrder = useCallback(
    async (format: "csv" | "text", allowUnresolved: boolean) => {
      if (!activeOrder) return;
      const order = activeOrder;
      setBusy(true);
      setError(null);
      setClipboardFallback(null);
      const exportPromise = exportOrder(token, order.id, { allowUnresolved });
      const copied =
        format === "text"
          ? copyTextFromPromise(exportPromise.then((result) => result.text))
          : Promise.resolve(false);
      try {
        const result = await exportPromise;
        if (format === "csv") {
          const blob = new Blob([CSV_BOM + result.csv], { type: "text/csv;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = result.filename;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
        }
        const onClipboard = format === "text" && (await copied);
        if (format === "text" && !onClipboard) setClipboardFallback(result.text);
        const warned = result.warnings.length ? `${result.warnings.join(" · ")} — ` : "";
        const done =
          format === "csv"
            ? de
              ? `${result.filename} heruntergeladen (${result.sent_positions} Positionen).`
              : `${result.filename} downloaded (${result.sent_positions} lines).`
            : onClipboard
              ? de
                ? `${result.sent_positions} Artikelnummern in die Zwischenablage kopiert.`
                : `${result.sent_positions} article numbers copied to the clipboard.`
              : de
                ? `Die Zwischenablage war nicht erreichbar — die ${result.sent_positions} Artikelnummern stehen unten zum Kopieren bereit.`
                : `The clipboard was not available — the ${result.sent_positions} article numbers are below, ready to copy.`;
        setNotice(`${warned}${done}`);
        setConflict(null);
        // submitted_at moved; the drawer shows it.
        setActiveOrder(await getOrder(token, order.id));
        await refresh();
      } catch (err) {
        const refused = unresolvedLinesConflict(err);
        if (refused) setConflict({ route: { kind: "export", format }, detail: refused });
        else reportError(err);
      } finally {
        setBusy(false);
      }
    },
    [
      activeOrder,
      de,
      refresh,
      reportError,
      setActiveOrder,
      setBusy,
      setClipboardFallback,
      setError,
      setNotice,
      token,
    ],
  );

  const sendActiveOrder = useCallback(
    (route: SendRoute, allowUnresolved: boolean) => {
      if (!activeOrder) return;
      setConflict(null);
      if (route.kind === "shop") {
        void openHandoff(
          () => submitOrderToShop(token, activeOrder.id, { allowUnresolved }),
          route,
        );
      } else {
        void exportActiveOrder(route.format, allowUnresolved);
      }
    },
    [activeOrder, exportActiveOrder, openHandoff, token],
  );

  /**
   * The buyer typed what the supplier calls this line.
   *
   * Written twice on purpose: onto the line (this order) and onto the
   * article↔supplier link (every future order), so the number is asked for
   * once. A stocked line that knows its link patches it; one that does not
   * — drafted before the link existed, or with no link yet — POSTs, and the
   * server upserts on the (article, supplier) pair, so an existing link is
   * updated rather than refused. A free line has no article to remember it
   * on. The link write failing must not lose the line write, so it is
   * reported separately.
   */
  const setSupplierNo = useCallback(
    (line: WerkstattOrderLine, supplierArticleNo: string) => {
      if (!activeOrder) return;
      const order = activeOrder;
      void runMutation(async () => {
        const updated = await updateOrderLine(token, order.id, line.id, {
          supplier_article_no: supplierArticleNo,
        });
        if (line.article_id !== null) {
          try {
            if (line.article_supplier_id !== null) {
              await updateArticleSupplierLink(token, line.article_id, line.article_supplier_id, {
                supplier_article_no: supplierArticleNo,
              });
            } else {
              await addArticleSupplierLink(token, line.article_id, {
                supplier_id: order.supplier_id,
                supplier_article_no: supplierArticleNo,
              });
            }
          } catch (err) {
            setNotice(
              de
                ? `Nummer auf der Position gespeichert, aber nicht am Artikel: ${err instanceof Error ? err.message : String(err)}`
                : `Saved on the line but not on the article: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        return updated;
      });
    },
    [activeOrder, de, runMutation, setNotice, token],
  );

  const pickAlternative = useCallback(
    (line: WerkstattOrderLine, alternative: OrderResolutionAlternative) => {
      if (!activeOrder || !alternative.article_no) return;
      const order = activeOrder;
      void runMutation(() =>
        updateOrderLine(token, order.id, line.id, {
          supplier_article_no: alternative.article_no,
        }),
      );
    },
    [activeOrder, runMutation, token],
  );

  return {
    conflict,
    clearConflict: useCallback(() => setConflict(null), []),
    openHandoff,
    sendActiveOrder,
    setSupplierNo,
    pickAlternative,
  };
}
