/**
 * Seeing a short basket before pressing anything.
 *
 * The report: the buyer learned that a line would be missing from the shop's
 * basket only AFTER "Im Shop bestellen", as a warning string. These pin the
 * drawer's answer — a badge per line from the resolution fixture, a summary
 * in the header, the shop button still clickable while a line is red (the
 * gate is the server's 409, and the click has to reach it), and the 409's
 * "Trotzdem übergeben" path.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BestellungDetailPanel } from "../components/werkstatt/BestellungDetailPanel";
import {
  resolutionText,
  resolutionTone,
} from "../components/werkstatt/BestellungPositionZeile";
import type { WerkstattOrder, WerkstattOrderLine } from "../types/werkstatt";
import type { OrderLineResolution, OrderResolution } from "../types/werkstattProcurement";

function line(id: number, name: string, extra: Partial<WerkstattOrderLine> = {}): WerkstattOrderLine {
  return {
    id,
    order_id: 1,
    article_id: null,
    article_number: null,
    article_name: name,
    article_supplier_id: null,
    supplier_article_no: null,
    description: name,
    manufacturer: null,
    ean: null,
    unit: null,
    source_import_id: null,
    is_stocked: false,
    quantity_ordered: 1,
    quantity_received: 0,
    unit_price_cents: null,
    currency: "EUR",
    line_status: "pending",
    received_at: null,
    notes: null,
    created_at: "2026-09-18T08:00:00Z",
    updated_at: "2026-09-18T08:00:00Z",
    ...extra,
  };
}

const ORDER: WerkstattOrder = {
  id: 1,
  order_number: "BST-2026-0042",
  supplier_id: 7,
  supplier_name: "Unielektro",
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
  line_count: 3,
  lines: [
    line(11, "NYY-J 5x6", { supplier_article_no: "11102138" }),
    line(12, "Reihenklemme", { ean: "4011234567890" }),
    line(13, "Unbekannte Klemme", { article_id: 5, is_stocked: true }),
  ],
  title: "Baustelle Müller",
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
  supplier_has_shop: true,
  created_at: "2026-09-18T08:00:00Z",
  updated_at: "2026-09-18T08:00:00Z",
};

function resolved(
  line_id: number,
  position: number,
  extra: Partial<OrderLineResolution> = {},
): OrderLineResolution {
  return {
    line_id,
    position,
    supplier_article_no: null,
    matched_by: "unresolved",
    is_resolved: false,
    ean: null,
    catalog_item_id: null,
    ambiguous_alternatives: 0,
    alternatives: [],
    will_send: null,
    warning: null,
    ...extra,
  };
}

const RESOLUTION: OrderResolution = {
  order_id: 1,
  supplier_id: 7,
  identifier: "supplier_no",
  channel: "ids",
  line_count: 3,
  ready_count: 2,
  lines: [
    resolved(11, 1, {
      supplier_article_no: "11102138",
      matched_by: "line_snapshot",
      is_resolved: true,
      will_send: "11102138",
    }),
    resolved(12, 2, {
      supplier_article_no: "11102139",
      matched_by: "catalog_ean",
      is_resolved: true,
      will_send: "11102139",
      ean: "4011234567890",
      ambiguous_alternatives: 1,
      alternatives: [{ catalog_item_id: 77, article_no: "11102140", item_name: "Trommel" }],
    }),
    resolved(13, 3),
  ],
  warnings: ["Position 3 (Unbekannte Klemme) hat keine Artikelnummer für Unielektro"],
};

function mount(extra: Partial<Parameters<typeof BestellungDetailPanel>[0]> = {}) {
  const props = {
    language: "de" as const,
    token: "test-token",
    order: ORDER,
    tasks: [],
    canManage: true,
    resolution: RESOLUTION,
    conflict: null,
    onClose: vi.fn(),
    onAddLine: vi.fn(),
    onUpdateLine: vi.fn(),
    onDeleteLine: vi.fn(),
    onSetSupplierNo: vi.fn(),
    onPickAlternative: vi.fn(),
    onSend: vi.fn(),
    onDismissConflict: vi.fn(),
    onMarkSent: vi.fn(),
    onMarkDelivered: vi.fn(),
    onCancel: vi.fn(),
    onMerge: vi.fn(),
    onSaveAsTemplate: vi.fn(),
    onApplyTemplate: vi.fn(),
    onAttachTask: vi.fn(),
    onShopAgain: vi.fn(),
    ...extra,
  };
  render(<BestellungDetailPanel {...props} />);
  return props;
}

describe("resolution badges", () => {
  it("maps the resolver's answer onto three tones", () => {
    expect(resolutionTone(RESOLUTION.lines[0])).toBe("ok");
    expect(resolutionTone(RESOLUTION.lines[1])).toBe("warn");
    expect(resolutionTone(RESOLUTION.lines[2])).toBe("missing");
    expect(resolutionText(RESOLUTION.lines[0], true)).toBe("Lieferanten-Nr. 11102138 (Position)");
    expect(resolutionText(RESOLUTION.lines[1], true)).toBe(
      "aus EAN aufgelöst: 11102139 · 1 weitere Treffer",
    );
    expect(resolutionText(RESOLUTION.lines[2], true)).toBe(
      "Keine Lieferanten-Nr. — wird nicht übergeben",
    );
  });

  it("renders a badge per line and the summary in the header", () => {
    mount();
    expect(screen.getByText("2 von 3 Positionen übergabefähig")).toBeInTheDocument();
    expect(screen.getByText("Lieferanten-Nr. 11102138 (Position)")).toBeInTheDocument();
    expect(screen.getByText("aus EAN aufgelöst: 11102139 · 1 weitere Treffer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keine Lieferanten-Nr. — wird nicht übergeben" }),
    ).toBeInTheDocument();
    // The alternative is offered as a pick.
    expect(screen.getByRole("button", { name: "11102140 · Trommel" })).toBeInTheDocument();
  });

  it("keeps the shop button clickable while a line is red, and says why in the title", () => {
    // The gate is server-side: only the 409 mounts the panel that carries
    // "Trotzdem übergeben". A greyed button made that override unreachable.
    const props = mount();
    const shop = screen.getByRole("button", { name: "Im Shop bestellen" });
    expect(shop).toBeEnabled();
    expect(shop).toHaveAttribute("title", expect.stringContaining("1 Position(en)"));
    fireEvent.click(shop);
    expect(props.onSend).toHaveBeenCalledWith({ kind: "shop" }, false);
  });

  it("shows the short label on a red badge and keeps the server's sentence in the title", () => {
    const sentence =
      "Position 3 (Unbekannte Klemme) hat keine Lieferanten-Artikelnummer und kann nicht an den Lieferanten übergeben werden";
    const withWarning: OrderResolution = {
      ...RESOLUTION,
      channel: "manual",
      lines: [RESOLUTION.lines[0], RESOLUTION.lines[1], resolved(13, 3, { warning: sentence })],
    };
    expect(resolutionText(withWarning.lines[2], true)).toBe(
      "Keine Lieferanten-Nr. — wird nicht übergeben",
    );
    mount({ resolution: withWarning });
    const badge = screen.getByRole("button", { name: "Keine Lieferanten-Nr. — wird nicht übergeben" });
    expect(badge).toHaveAttribute("title", expect.stringContaining(sentence));
    expect(badge).toHaveAttribute("title", expect.stringContaining("Lieferanten-Artikelnummer eintragen"));
  });

  it("lets the buyer type the number from the red badge", () => {
    const props = mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Keine Lieferanten-Nr. — wird nicht übergeben" }),
    );
    fireEvent.change(screen.getByLabelText("Lieferanten-Artikelnummer für Unbekannte Klemme"), {
      target: { value: "01004771" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Eintragen" }));
    expect(props.onSetSupplierNo).toHaveBeenCalledWith(ORDER.lines[2], "01004771");
  });

  it("offers 'Trotzdem übergeben' on a refused hand-over, with the same route", () => {
    const props = mount({
      conflict: {
        route: { kind: "shop" },
        detail: {
          code: "unresolved_lines",
          message: "1 Position ohne Lieferanten-Artikelnummer",
          warnings: ["Position 3 (Unbekannte Klemme) hat keine Artikelnummer für Unielektro"],
          unresolved_positions: [3],
        },
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("1 Position ohne Lieferanten-Artikelnummer");
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem übergeben" }));
    expect(props.onSend).toHaveBeenCalledWith({ kind: "shop" }, true);
  });

  it("offers the export for a supplier without a shop", () => {
    mount({
      order: { ...ORDER, supplier_has_shop: false },
      resolution: { ...RESOLUTION, channel: "manual", ready_count: 3 },
    });
    expect(screen.queryByRole("button", { name: "Im Shop bestellen" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bestellung exportieren" }));
    expect(screen.getByRole("menuitem", { name: "CSV herunterladen" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Artikelnummern kopieren" })).toBeInTheDocument();
  });
});
