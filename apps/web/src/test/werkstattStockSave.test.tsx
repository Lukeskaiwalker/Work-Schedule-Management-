/**
 * The Bestand page actually saves — and says so honestly when it does not.
 *
 * Both dialogs on this page used to end at `setNotice("… (API folgt)")` and a
 * TODO. Every stock correction and every checkout made here since the page
 * shipped was silently discarded, while the workshop was told in green text
 * that it had been booked. That is the failure mode these pin shut: a green
 * notice must mean a 200, and a rejection must stay on screen with the user's
 * input still in the form.
 *
 * They also pin the other half of the report — "the displayed number per items
 * is not always true to what the actual amount says when we click to edit".
 * The dialogs were handed the literal constants 3 and 4, so all 250 articles
 * in production claimed to hold four.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { WerkstattInventarPage } from "../pages/werkstatt/WerkstattInventarPage";

/** 12 owned, 9 on the shelf, 3 out with a colleague. */
const ARTICLE = {
  id: 7,
  article_number: "SP-0042",
  ean: "4001234567890",
  internal_code: null,
  item_name: "Bohrer SDS-Plus 8mm",
  manufacturer: "Bosch",
  category_name: "Werkzeug",
  location_name: "Regal B2",
  stock_available: 9,
  stock_total: 12,
  stock_status: "available",
  image_url: null,
  next_expected_delivery_at: null,
  // No unit of its own, so row and dialog both fall back to the interface
  // language's abbreviation — "pcs" here, "Stk" in the German UI. One word in
  // both places: the row used to print "Stk" beside a dialog printing "St.".
  unit: null,
};

type Call = { method: string; url: string; body: unknown };

/**
 * GET the list; answer the first POST with `writeResponse`.
 *
 * `listAfterWrite` is what later GETs return — the list as it looks once
 * somebody else has touched it. Defaults to the same single row.
 */
function stubApi(
  writeResponse: { status: number; payload: unknown },
  listAfterWrite?: unknown[],
) {
  const calls: Call[] = [];
  let written = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === "POST") {
        written = true;
        return new Response(JSON.stringify(writeResponse.payload), {
          status: writeResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      const rows = written && listAfterWrite ? listAfterWrite : [ARTICLE];
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

/** The endpoint behind "Bestand anpassen" is gated on `werkstatt:manage`, and
 *  so is the button that opens it. */
const STOCK_MANAGER = { id: 1, effective_permissions: ["werkstatt:manage"] };

function renderPage(setNotice: () => void, extra: Record<string, unknown> = {}) {
  return render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            mainView: "werkstatt",
            werkstattTab: "inventar",
            language: "en",
            token: "test-token",
            projects: [],
            user: STOCK_MANAGER,
            setNotice,
            ...extra,
          },
        }) as never
      }
    >
      <WerkstattInventarPage />
    </AppContext.Provider>,
  );
}

/** Open "Bestand anpassen" on the one row, once the list has loaded. */
async function openAdjustDialog(setNotice: () => void, extra: Record<string, unknown> = {}) {
  renderPage(setNotice, extra);
  await screen.findByText("Bohrer SDS-Plus 8mm");
  fireEvent.click(screen.getByRole("button", { name: "Adjust stock" }));
  return screen.getByRole("dialog", { name: "Adjust stock" });
}

const writeCalls = (calls: Call[]) => calls.filter((c) => c.method === "POST");

describe("Bestand anpassen — real numbers, real save", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("shows the article's own stock, not the constant 4", async () => {
    stubApi({ status: 200, payload: {} });
    const dialog = await openAdjustDialog(() => undefined);
    // The list column prints AVAILABLE; this dialog moves the TOTAL. Both
    // figures are named, so neither can be mistaken for the other.
    expect(dialog).toHaveTextContent("12 pcs");
    expect(dialog).toHaveTextContent("9 of them available");
  });

  it("books the typed amount and the kind, and reports what came back", async () => {
    const calls = stubApi({
      status: 200,
      payload: { id: 7, stock_total: 15, stock_available: 12, stock_status: "available" },
    });
    const setNotice = vi.fn();
    await openAdjustDialog(setNotice);

    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Reason \/ reference/ }), {
      target: { value: "LS-2024-0157" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save adjustment" }));

    await waitFor(() => expect(writeCalls(calls)).toHaveLength(1));
    const [write] = writeCalls(calls);
    expect(write.url).toBe("/api/werkstatt/articles/7/movements");
    // Positive quantity plus the kind — never a signed delta, and never a
    // stock counter the browser worked out for itself.
    //
    // And NO `expected_total`. Three boxes arrived; that is true whatever the
    // shelf did while this tablet sat open. The list is fetched on mount and
    // on search — no polling, no SSE — so sending the displayed total as a
    // lock refused a whole morning's deliveries on figures that were merely
    // old. The lock belongs to the stock-take, where the number IS a claim
    // about a specific observed total.
    expect(write.body).toEqual({
      kind: "intake",
      quantity: 3,
      reason: "LS-2024-0157",
    });
    expect(write.body).not.toHaveProperty("expected_total");

    // The notice quotes the SERVER's figures for the totals, and the amount
    // the user actually entered for the change. Pinned whole: this sentence is
    // the only account of the booking most of the workshop ever reads.
    await waitFor(() =>
      expect(setNotice).toHaveBeenCalledWith(
        "Intake +3 · Bohrer SDS-Plus 8mm — now 15 total, 12 available",
      ),
    );
    // And the row behind the dialog moves with it: it shows available stock.
    await waitFor(() => expect(screen.getByText("12 pcs")).toBeInTheDocument());
  });

  it("reports the amount booked, not the drift since the list was fetched", async () => {
    // The list is fetched on mount and on search. A tablet left open on the
    // bench all morning shows 12 while the article has long since moved to 37
    // — so "server total − displayed total" would announce a Wareneingang of
    // +28 for three boxes. Nobody booked 28.
    stubApi({
      status: 200,
      payload: { id: 7, stock_total: 40, stock_available: 37, stock_status: "available" },
    });
    const setNotice = vi.fn();
    await openAdjustDialog(setNotice);

    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), {
      target: { value: "3" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Reason \/ reference/ }), {
      target: { value: "LS-2024-0157" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save adjustment" }));

    // +3 is what the endpoint booked — it adds exactly the quantity sent — and
    // 40 / 37 is where that left the article. Both true, neither guessed.
    await waitFor(() =>
      expect(setNotice).toHaveBeenCalledWith(
        "Intake +3 · Bohrer SDS-Plus 8mm — now 40 total, 37 available",
      ),
    );
  });

  it("reports a stock-take as the delta the server itself confirmed", async () => {
    // The count carries `expected_total: 12`, so a 200 means the server had 12
    // before booking: 8 − 12 = −4 is a delta with the server's own word behind
    // both ends of it, not the browser's.
    stubApi({
      status: 200,
      payload: { id: 7, stock_total: 8, stock_available: 5, stock_status: "low" },
    });
    const setNotice = vi.fn();
    await openAdjustDialog(setNotice);

    submitStockTake("5");

    await waitFor(() =>
      expect(setNotice).toHaveBeenCalledWith(
        "Inventory adjust −4 · Bohrer SDS-Plus 8mm — now 8 total, 5 available",
      ),
    );
  });

  it("keeps the dialog and the typed input when the server refuses", async () => {
    const calls = stubApi({
      status: 400,
      payload: { detail: "Bestand darf nicht negativ werden" },
    });
    const setNotice = vi.fn();
    await openAdjustDialog(setNotice);

    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Reason \/ reference/ }), {
      target: { value: "Zählfehler" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save adjustment" }));

    // The server's own words, because the fix differs per message.
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Bestand darf nicht negativ werden");
    // Never a success notice for a request that failed.
    expect(setNotice).not.toHaveBeenCalled();
    // Still open, still holding what was typed — re-entering the form to read
    // the reason would have lost it.
    expect(screen.getByRole("dialog", { name: "Adjust stock" })).toBeInTheDocument();
    expect((screen.getByRole("textbox", { name: "Amount" }) as HTMLInputElement).value).toBe("4");
    expect(writeCalls(calls)).toHaveLength(1);
    // The list still shows what the server still holds.
    expect(screen.getByText("9 pcs")).toBeInTheDocument();
  });

  it("sends a stock-take as the SHELF count plus what is out", async () => {
    const calls = stubApi({
      status: 200,
      payload: { id: 7, stock_total: 8, stock_available: 5, stock_status: "low" },
    });
    await openAdjustDialog(() => undefined);

    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    // The worker at the shelf counts five. They cannot see the three that are
    // out with a colleague, and are not being asked to.
    fireEvent.change(screen.getByRole("textbox", { name: "Counted on shelf" }), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Reason \/ reference/ }), {
      target: { value: "Inventur 2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save adjustment" }));

    await waitFor(() => expect(writeCalls(calls)).toHaveLength(1));
    // 5 counted + 3 out = 8 owned. Sending the bare 5 as the target would book
    // inventory_minus 7 and write off three drills that are on a job.
    //
    // A target rather than a delta because the server subtracts the current
    // total itself; `expected_total` because a count IS a claim about one
    // observed total, so it must be refused if that total moved underneath it.
    expect(writeCalls(calls)[0].body).toEqual({
      kind: "inventory",
      target_total: 8,
      reason: "Inventur 2026",
      expected_total: 12,
    });
  });

  /** Fill in a stock-take — the one kind that carries the optimistic lock —
   *  and press Save. */
  function submitStockTake(counted: string) {
    fireEvent.click(screen.getByRole("radio", { name: /Inventory adjust/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Counted on shelf" }), {
      target: { value: counted },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Reason \/ reference/ }), {
      target: { value: "Inventur 2026" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save adjustment" }));
  }

  it("refetches on a 409 and says what to do about it, once", async () => {
    // The article moved while the dialog stood open. The server says so; the
    // dialog would otherwise keep showing the number it just called wrong.
    //
    // Verbatim from apps/api/app/routers/workflow_werkstatt_article_stock.py,
    // closing sentence included — that sentence is the reason this test exists.
    const calls = stubApi({
      status: 409,
      payload: {
        detail:
          "Der Bestand hat sich inzwischen geändert: angezeigt waren 12 Stk, " +
          "aktuell sind es 15 Stk. Bitte den Dialog neu öffnen und die Buchung prüfen.",
      },
    });
    const setNotice = vi.fn();
    await openAdjustDialog(setNotice);
    const listCallsBefore = calls.filter((c) => c.method === "GET").length;

    submitStockTake("5");

    const alert = await screen.findByRole("alert");
    // Both totals survive — they are the whole point of the message.
    expect(alert).toHaveTextContent(
      "Der Bestand hat sich inzwischen geändert: angezeigt waren 12 Stk, aktuell sind es 15 Stk.",
    );
    // The dialog is NOT closed here; it is refreshed underneath the user. So
    // the server's instruction to reopen it goes, and one instruction — the
    // one true of this client — is left standing. The toast told the user to
    // reopen the dialog and that there was no need to, in one breath.
    expect(alert).not.toHaveTextContent(/neu öffnen/);
    expect(alert).toHaveTextContent(
      "The figures above have just been refreshed — check your entry against them and save again.",
    );
    expect(setNotice).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(listCallsBefore),
    );
    // And the claim the message makes is true: the dialog is still there, now
    // showing what the refetch brought back.
    expect(screen.getByRole("dialog", { name: "Adjust stock" })).toBeInTheDocument();
  });

  it("survives a refetch that no longer contains the article", async () => {
    // The dialog's row is looked up by id in the current list, and the 409
    // path refetches. If that list comes back without this article — a search
    // narrowed by a stray scan, a colleague archiving the row — the dialog
    // used to unmount mid-edit, taking the count, the Beleg number and the
    // error message explaining the refusal with it.
    stubApi({ status: 409, payload: { detail: "Der Bestand hat sich inzwischen geändert" } }, []);
    await openAdjustDialog(() => undefined);

    submitStockTake("5");
    await screen.findByRole("alert");

    // Still open, still holding the count and the reason.
    await waitFor(() => expect(screen.queryByText("Bohrer SDS-Plus 8mm")).not.toBeNull());
    const dialog = screen.getByRole("dialog", { name: "Adjust stock" });
    expect(dialog).toBeInTheDocument();
    expect(
      (screen.getByRole("textbox", { name: "Counted on shelf" }) as HTMLInputElement).value,
    ).toBe("5");
    expect(
      (screen.getByRole("textbox", { name: /Reason \/ reference/ }) as HTMLTextAreaElement).value,
    ).toBe("Inventur 2026");
  });
});

describe("Bestand anpassen — who is offered it", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("is not offered without werkstatt:manage", async () => {
    // The endpoint requires the permission. Letting an apprentice fill in the
    // whole dialog only to collect a 403 is a worse answer than no button.
    stubApi({ status: 200, payload: {} });
    renderPage(() => undefined, { user: { id: 2, effective_permissions: ["werkstatt:view"] } });
    await screen.findByText("Bohrer SDS-Plus 8mm");
    expect(screen.queryByRole("button", { name: "Adjust stock" })).toBeNull();
  });
});

describe("Neuer Artikel — no green tick for a save that did not happen", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("reports that nothing was stored, because nothing was", async () => {
    // POST /werkstatt/articles does not exist yet. Next to two dialogs that
    // now genuinely book stock, "gespeichert (API folgt)" in the success toast
    // is a claim the user has no way to check.
    stubApi({ status: 200, payload: {} });
    const setNotice = vi.fn();
    const setError = vi.fn();
    renderPage(setNotice, { setError });
    await screen.findByText("Bohrer SDS-Plus 8mm");

    fireEvent.click(screen.getByRole("button", { name: /New item/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Save article" }));

    expect(setNotice).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith(expect.stringContaining("NOT saved"));
  });
});

describe("Entnehmen — real numbers, real save", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("checks out against the row's own availability", async () => {
    const calls = stubApi({
      status: 200,
      payload: { id: 7, stock_total: 12, stock_available: 7, stock_status: "available" },
    });
    const setNotice = vi.fn();
    renderPage(setNotice);
    await screen.findByText("Bohrer SDS-Plus 8mm");

    fireEvent.click(screen.getByText("Bohrer SDS-Plus 8mm"));
    const dialog = await screen.findByRole("dialog", { name: "Check out item" });
    expect(dialog).toHaveTextContent("9 / 12 available");

    fireEvent.change(screen.getByRole("textbox", { name: "Quantity" }), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm checkout/ }));

    await waitFor(() => expect(writeCalls(calls)).toHaveLength(1));
    const [write] = writeCalls(calls);
    expect(write.url).toBe("/api/werkstatt/mobile/checkout");
    expect(write.body).toMatchObject({ article_id: 7, quantity: 2, project_id: null });

    await waitFor(() => expect(screen.getByText("7 pcs")).toBeInTheDocument());
  });

  it("shows the refusal instead of a success notice", async () => {
    stubApi({ status: 400, payload: { detail: "Not enough stock available" } });
    const setNotice = vi.fn();
    renderPage(setNotice);
    await screen.findByText("Bohrer SDS-Plus 8mm");

    fireEvent.click(screen.getByText("Bohrer SDS-Plus 8mm"));
    await screen.findByRole("dialog", { name: "Check out item" });
    fireEvent.click(screen.getByRole("button", { name: /Confirm checkout/ }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Not enough stock available");
    expect(setNotice).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Check out item" })).toBeInTheDocument();
  });
});
