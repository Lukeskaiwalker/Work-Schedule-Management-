/**
 * The Daten tab's infeed hint (docs/PANEL_ENCLOSURE_R4.md §8.5): under
 * "Zuleitung", what the infeed parser recognised and what the cabinet gets
 * for it — the page computes the text (`infeedHint`), the tab shows it as
 * the field's description, never as a live region, and not at all without one.
 * Invented data only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { PanelDataTab } from "../components/schaltplan/PanelDataTab";
import { emptyDocument } from "../utils/schaltplanDevices";
import type { PanelPlan } from "../types/schaltplan";

const PANEL = { id: 7, designation: "ZS1", name: "Zählerschrank", location: null, panel_type: "meter", fed_from_panel_id: null, notes: null } as unknown as PanelPlan;

function renderTab(infeedHint?: string | null) {
  return render(
    <PanelDataTab
      panel={PANEL}
      document={emptyDocument()}
      panels={[]}
      readOnly={false}
      canEdit
      onPatchSupply={vi.fn()}
      onSaveMeta={vi.fn()}
      onDelete={vi.fn()}
      infeedHint={infeedHint}
    />,
  );
}

describe("PanelDataTab — infeed hint", () => {
  it("describes the Zuleitung field with the hint, keeping its name", () => {
    const { container } = renderTab("Querschnitt erkannt: 16 mm² → Einspeiseadapter K96ESA5");
    const field = screen.getByRole("textbox", { name: "Zuleitung" });
    expect(field).toHaveAccessibleDescription("Querschnitt erkannt: 16 mm² → Einspeiseadapter K96ESA5");
    const hint = container.querySelector("small.sp-field-hint")!;
    expect(hint.closest("label")).toBe(field.closest("label"));
    expect(hint).not.toHaveAttribute("role");
    expect(hint).not.toHaveAttribute("aria-live");
  });

  it("shows nothing without a hint", () => {
    const { container } = renderTab(null);
    expect(screen.getByRole("textbox", { name: "Zuleitung" })).not.toHaveAccessibleDescription();
    expect(container.querySelector("label small.sp-field-hint")).toBeNull();
  });
});
