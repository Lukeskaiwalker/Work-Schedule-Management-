import type { StockAdjustmentKind } from "../../utils/werkstattArticlesApi";

/**
 * What the Bestand page says after a stock booking — and after the one
 * rejection whose wording it has to finish itself.
 *
 * Pure and out of the page for the same reason the arithmetic is (see
 * stockAdjustment.ts): these sentences are the only account most of the
 * workshop ever reads of what went into the ledger, so they are worth pinning
 * in a test of their own rather than re-reading off a rendered component.
 *
 * ── Why the delta is not simply "server total − displayed total" ──────────
 *
 * That subtraction is a lie whenever the displayed total is old, and on this
 * page it usually is: the list is fetched on mount and on search, with no
 * polling and no SSE, so a tablet left open on the bench all morning holds
 * figures from hours ago. Booking a Wareneingang of 20 against a row that had
 * meanwhile moved by 20 elsewhere announced "+40" — a quantity nobody booked,
 * in the same green notice that is supposed to be the proof it worked.
 *
 * So each kind reports the one figure it can stand behind:
 *
 *   intake / defect  the amount the user entered. These are RELATIVE
 *                    bookings — the endpoint adds or subtracts exactly that
 *                    quantity — so a 200 means precisely that was booked,
 *                    whatever the shelf did in the meantime.
 *   inventory        after − before, with `before` the total the SERVER
 *                    confirmed. The stock-take is the one kind that sends
 *                    `expected_total`, and the endpoint answers 409 unless
 *                    that number equals its own `stock_total`; a 200 therefore
 *                    certifies the before-figure. Without that certificate the
 *                    notice asserts no delta at all rather than inventing one.
 *
 * The totals in the message are always the server's own, unchanged.
 */

/** Names the three kinds by what the workshop calls them, so the notice reads
 *  like the card the user picked. Mirrors `_KIND_LABELS` in
 *  apps/api/app/routers/workflow_werkstatt_article_stock.py. */
const ADJUSTMENT_LABELS = {
  de: { intake: "Wareneingang", defect: "Schwund / Defekt", inventory: "Inventur-Korrektur" },
  en: { intake: "Intake", defect: "Loss / defect", inventory: "Inventory adjust" },
} as const;

/** "+3" / "−3" / "±0" — an unsigned number in a stock notice is ambiguous. */
export function signed(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return "±0";
}

export interface StockAdjustmentNoticeInput {
  kind: StockAdjustmentKind;
  itemName: string;
  /** What the user entered: pieces for intake/defect, the counted SHELF figure
   *  for a stock-take. Always positive — the kind carries the direction, and
   *  for `inventory` it is not a delta at all. */
  amount: number;
  /**
   * The total the server verified before booking, or null when nothing
   * verified it.
   *
   * This is the value that was sent as `expected_total`: passing it means the
   * endpoint compared it against its own `stock_total` and would have answered
   * 409 on a mismatch, so on success it is the server's before-figure and not
   * merely this browser's. Null for every request that carried no lock.
   */
  confirmedTotalBefore: number | null;
  /** Straight from the response. */
  totalAfter: number;
  availableAfter: number;
}

/**
 * The signed change to `stock_total` this booking can honestly claim, or null
 * when it can claim none.
 */
function bookedDelta(input: StockAdjustmentNoticeInput): number | null {
  if (input.kind === "intake") return input.amount;
  if (input.kind === "defect") return -input.amount;
  return input.confirmedTotalBefore === null
    ? null
    : input.totalAfter - input.confirmedTotalBefore;
}

/** The green notice after a successful stock adjustment. */
export function stockAdjustmentNotice(input: StockAdjustmentNoticeInput, de: boolean): string {
  const label = ADJUSTMENT_LABELS[de ? "de" : "en"][input.kind];
  const delta = bookedDelta(input);
  const head =
    delta === null ? (de ? `${label} gebucht` : `${label} booked`) : `${label} ${signed(delta)}`;
  const totals = de
    ? `neuer Bestand ${input.totalAfter} gesamt, ${input.availableAfter} verfügbar`
    : `now ${input.totalAfter} total, ${input.availableAfter} available`;
  return `${head} · ${input.itemName} — ${totals}`;
}

/**
 * The sentence of the endpoint's 409 detail that this dialog contradicts.
 *
 * apps/api/app/routers/workflow_werkstatt_article_stock.py closes its conflict
 * detail with it. It describes a client that closes the dialog on a stale
 * total; this one does the opposite — it keeps the dialog open, refetches the
 * list and looks the row up again by id, so the figures in front of the user
 * are replaced in place while the count and the Beleg number they typed stay
 * put. Carrying the server's "please reopen" and this page's "no need to
 * reopen" in one toast told the user two opposite things about the dialog they
 * were looking at, so the half that is not true of this client is dropped.
 *
 * The endpoint has since stopped sending this sentence, so on a current server
 * the strip below matches nothing. It stays for the rollout window — during a
 * deploy a new bundle talks to the old api for a few seconds — and as a guard
 * for any other client of this endpoint. Safe to delete once no deployed api
 * emits it.
 */
const SERVER_REOPEN_SENTENCE = "Bitte den Dialog neu öffnen und die Buchung prüfen.";

/**
 * The 409 shown in the still-open dialog: the server's account of the
 * conflict, minus its instruction to reopen, plus what to actually do here.
 *
 * Everything else in the detail is kept verbatim — it names both totals, and
 * those numbers are the whole point of the message.
 */
export function staleStockMessage(detail: string, de: boolean): string {
  const withoutReopen = detail.split(SERVER_REOPEN_SENTENCE).join(" ").replace(/\s+/g, " ").trim();
  const advice = de
    ? "Die Zahlen oben sind soeben aktualisiert worden — bitte die Eingabe dagegen prüfen und erneut speichern."
    : "The figures above have just been refreshed — check your entry against them and save again.";
  return withoutReopen ? `${withoutReopen} ${advice}` : advice;
}
