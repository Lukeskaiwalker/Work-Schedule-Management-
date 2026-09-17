/**
 * Getting the article numbers out of the building on an iPad.
 *
 * The report: "Artikelnummern kopieren" wrote to the clipboard after an
 * awaited fetch. WebKit refuses a clipboard write outside the user gesture,
 * so on Safari and every iPad browser the buyer saw an English error banner,
 * nothing was on the clipboard — and the server had already stamped the
 * order as handed over. These pin the fix: the clipboard is handed a
 * ClipboardItem whose text is the export PROMISE, inside the click; when the
 * clipboard still refuses, the numbers are shown in a box instead; and the
 * drawer's supplier-number write POSTs an upsert when the line has no link.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useOrderHandover, type OrderHandoverDeps } from "../hooks/useOrderHandover";
import type { WerkstattOrder, WerkstattOrderLine } from "../types/werkstatt";

const LINE: WerkstattOrderLine = {
  id: 13,
  order_id: 1,
  article_id: 5,
  article_number: "SP-0005",
  article_name: "Unbekannte Klemme",
  article_supplier_id: null,
  supplier_article_no: null,
  description: "Unbekannte Klemme",
  manufacturer: null,
  ean: null,
  unit: null,
  source_import_id: null,
  is_stocked: true,
  quantity_ordered: 1,
  quantity_received: 0,
  unit_price_cents: null,
  currency: "EUR",
  line_status: "pending",
  received_at: null,
  notes: null,
  created_at: "2026-09-18T08:00:00Z",
  updated_at: "2026-09-18T08:00:00Z",
};

const ORDER: WerkstattOrder = {
  id: 1,
  order_number: "BST-2026-0042",
  supplier_id: 7,
  supplier_name: "Rexel",
  status: "draft",
  total_amount_cents: null,
  currency: "EUR",
  ordered_at: null,
  expected_delivery_at: null,
  delivered_at: null,
  delivery_reference: null,
  notes: null,
  created_by: 1,
  created_by_name: null,
  line_count: 1,
  lines: [LINE],
  title: null,
  is_template: false,
  template_name: null,
  task_id: null,
  task_title: null,
  project_id: null,
  project_name: null,
  source: "manual",
  external_reference: null,
  merged_into_order_id: null,
  merged_at: null,
  submitted_at: null,
  supplier_has_shop: false,
  created_at: "2026-09-18T08:00:00Z",
  updated_at: "2026-09-18T08:00:00Z",
};

const EXPORT = {
  order_id: 1,
  order_number: "BST-2026-0042",
  filename: "BST-2026-0042.csv",
  identifier: "supplier_no",
  csv: "Artikelnummer;Menge;Einheit;Bezeichnung\n11102138;10;MTR;NYY-J 5x6",
  text: "11102138\t10\n01004771\t1",
  warnings: [],
  sent_positions: 2,
  dropped_positions: 0,
  submitted_at: "2026-09-18T09:00:00Z",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The page's slice of state, as plain spies. */
function deps(): OrderHandoverDeps & {
  setNotice: Mock;
  setClipboardFallback: Mock;
  setError: Mock;
} {
  return {
    token: "test-token",
    de: true,
    activeOrder: ORDER,
    setActiveOrder: vi.fn(),
    refresh: vi.fn(async () => undefined),
    runMutation: vi.fn(async (action: () => Promise<WerkstattOrder | null>) => {
      await action();
    }),
    reportError: vi.fn(),
    setBusy: vi.fn(),
    setError: vi.fn(),
    setNotice: vi.fn(),
    setBlockedShopUrl: vi.fn(),
    setClipboardFallback: vi.fn(),
  };
}

function Harness({ handover }: { handover: OrderHandoverDeps }) {
  const { sendActiveOrder, setSupplierNo, conflict } = useOrderHandover(handover);
  return (
    <div>
      <button type="button" onClick={() => sendActiveOrder({ kind: "export", format: "text" }, false)}>
        kopieren
      </button>
      <button type="button" onClick={() => setSupplierNo(LINE, "01004771")}>
        nummer
      </button>
      {conflict && <p role="alert">{conflict.detail.message}</p>}
    </div>
  );
}

/** A ClipboardItem that just remembers what it was given. */
class FakeClipboardItem {
  constructor(public readonly items: Record<string, Promise<string | Blob>>) {}
}

type ClipboardStub = { write: Mock; writeText: Mock };

function installClipboard(stub: ClipboardStub) {
  Object.defineProperty(navigator, "clipboard", { value: stub, configurable: true });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useOrderHandover — Artikelnummern kopieren", () => {
  beforeEach(() => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("hands the clipboard the export promise inside the click, before the server has answered", async () => {
    let answer: (response: Response) => void = () => undefined;
    const exportResponse = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/export")) return exportResponse;
        return Promise.resolve(json(ORDER));
      }),
    );
    const clipboard: ClipboardStub = {
      write: vi.fn(async () => undefined),
      writeText: vi.fn(async () => undefined),
    };
    installClipboard(clipboard);
    const handover = deps();
    render(<Harness handover={handover} />);

    fireEvent.click(screen.getByRole("button", { name: "kopieren" }));
    // Synchronously: the gesture is still alive here, and that is the only
    // moment WebKit accepts the write.
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    const [items] = clipboard.write.mock.calls[0] as [FakeClipboardItem[]];
    expect(items[0]).toBeInstanceOf(FakeClipboardItem);
    expect(clipboard.writeText).not.toHaveBeenCalled();

    answer(json(EXPORT));
    await flush();

    const blob = await items[0].items["text/plain"];
    expect(blob).toBeInstanceOf(Blob);
    expect(await (blob as Blob).text()).toBe(EXPORT.text);
    expect(handover.setNotice).toHaveBeenLastCalledWith(
      "2 Artikelnummern in die Zwischenablage kopiert.",
    );
    expect(handover.setClipboardFallback).not.toHaveBeenCalledWith(EXPORT.text);
    expect(handover.reportError).not.toHaveBeenCalled();
  });

  it("falls back to writeText where ClipboardItem does not exist", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/export") ? json(EXPORT) : json(ORDER),
      ),
    );
    const clipboard: ClipboardStub = {
      write: vi.fn(async () => undefined),
      writeText: vi.fn(async () => undefined),
    };
    installClipboard(clipboard);
    const handover = deps();
    render(<Harness handover={handover} />);

    fireEvent.click(screen.getByRole("button", { name: "kopieren" }));
    await flush();

    expect(clipboard.write).not.toHaveBeenCalled();
    expect(clipboard.writeText).toHaveBeenCalledWith(EXPORT.text);
    expect(handover.setNotice).toHaveBeenLastCalledWith(
      "2 Artikelnummern in die Zwischenablage kopiert.",
    );
  });

  it("shows the numbers in a box when the clipboard refuses, instead of an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/export") ? json(EXPORT) : json(ORDER),
      ),
    );
    const refused = new DOMException("The request is not allowed by the user agent", "NotAllowedError");
    const clipboard: ClipboardStub = {
      write: vi.fn(async () => {
        throw refused;
      }),
      writeText: vi.fn(async () => {
        throw refused;
      }),
    };
    installClipboard(clipboard);
    const handover = deps();
    render(<Harness handover={handover} />);

    fireEvent.click(screen.getByRole("button", { name: "kopieren" }));
    await flush();

    expect(handover.setClipboardFallback).toHaveBeenLastCalledWith(EXPORT.text);
    expect(handover.setNotice).toHaveBeenLastCalledWith(
      expect.stringContaining("Die Zwischenablage war nicht erreichbar"),
    );
    // Not an error: the server did its part, and the numbers are on screen.
    expect(handover.reportError).not.toHaveBeenCalled();
    expect(handover.setError).not.toHaveBeenCalledWith(expect.stringContaining("not allowed"));
  });

  it("lands a refused export in the conflict panel without a stray clipboard write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/export")
          ? json(
              {
                detail: {
                  code: "unresolved_lines",
                  message: "1 Position ohne Lieferanten-Artikelnummer",
                  warnings: ["Position 1 (Unbekannte Klemme) hat keine Artikelnummer für Rexel"],
                  unresolved_positions: [1],
                },
              },
              409,
            )
          : json(ORDER),
      ),
    );
    const clipboard: ClipboardStub = {
      write: vi.fn(async (items: FakeClipboardItem[]) => {
        // What a real clipboard does with a rejected data promise.
        await items[0].items["text/plain"];
      }),
      writeText: vi.fn(async () => undefined),
    };
    installClipboard(clipboard);
    const handover = deps();
    render(<Harness handover={handover} />);

    fireEvent.click(screen.getByRole("button", { name: "kopieren" }));
    await flush();

    expect(screen.getByRole("alert")).toHaveTextContent("1 Position ohne Lieferanten-Artikelnummer");
    expect(handover.reportError).not.toHaveBeenCalled();
    expect(handover.setClipboardFallback).not.toHaveBeenCalledWith(expect.any(String));
  });
});

describe("useOrderHandover — the supplier number from the red badge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("patches the line and POSTs the link as an upsert when the line has none", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return json(String(input).includes("/suppliers") ? { id: 99 } : ORDER);
      }),
    );
    const handover = deps();
    render(<Harness handover={handover} />);

    fireEvent.click(screen.getByRole("button", { name: "nummer" }));
    await flush();

    expect(calls.map((call) => `${call.method} ${call.url.replace(/^.*\/api/, "")}`)).toEqual([
      "PATCH /werkstatt/orders/1/lines/13",
      "POST /werkstatt/articles/5/suppliers",
    ]);
    expect(calls[1].body).toEqual({ supplier_id: 7, supplier_article_no: "01004771" });
    // Both writes succeeded: nothing to report beside the refreshed drawer.
    expect(handover.setNotice).not.toHaveBeenCalled();
  });
});
