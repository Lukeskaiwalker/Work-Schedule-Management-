/**
 * The project Material tab, once rows can come from two places.
 *
 * A row summed from Baustellenberichte and a row of stock consumed for a
 * Verteiler look alike — an item, a number, a unit — and they mean different
 * things: one is what a technician wrote down, the other is what physically
 * left the shelf for a named cabinet. The "Quelle" column is what tells them
 * apart, so these tests pin that it says "Bericht" for the old shape (no
 * `source` at all) and "Verteiler VT-0007" for the new one, and that the
 * panel number can be searched, sorted on and exported.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import {
  ProjectMaterialsTab,
  materialSourceLabel,
} from "../pages/project/ProjectMaterialsTab";
import type { ProjectTrackedMaterial } from "../types";

const REPORT_ROW: ProjectTrackedMaterial = {
  item: "Kabel NYM-J 3x1,5",
  unit: "m",
  article_no: "NYM-315",
  quantity_total: 120,
  quantity_notes: [],
  occurrence_count: 3,
  report_count: 2,
  last_report_date: "2026-09-10",
  // No `source` on purpose: rows from before the field existed are report rows.
};

const PANEL_ROW: ProjectTrackedMaterial = {
  item: "WAGO 2003-7641 - TOPJOB S Durchgangsklemme",
  unit: "ST",
  article_no: "SP-0187",
  quantity_total: 12,
  quantity_notes: [],
  occurrence_count: 4,
  report_count: 0,
  last_report_date: "2026-09-24",
  source: "verteiler",
  panel_numbers: ["VT-0007"],
};

function renderTab(materials: ProjectTrackedMaterial[], overrides: Record<string, unknown> = {}) {
  const loadProjectTrackedMaterials = vi.fn();
  const context = makeAppContextStub({
    overrides: {
      mainView: "project",
      projectTab: "materials",
      language: "de",
      activeProject: { id: 244, project_number: "381", title: "Neubau Schulze" },
      projectTrackedMaterials: materials,
      loadProjectTrackedMaterials,
      ...overrides,
    },
  });
  const utils = render(
    <AppContext.Provider value={context as never}>
      <ProjectMaterialsTab />
    </AppContext.Provider>,
  );
  return { ...utils, loadProjectTrackedMaterials };
}

function rowTexts(): string[] {
  return Array.from(document.querySelectorAll(".project-mat-tab-row")).map(
    (row) => row.querySelector(".project-mat-tab-td--source")?.textContent ?? "",
  );
}

describe("materialSourceLabel", () => {
  it("treats a row without a source as a report row", () => {
    expect(materialSourceLabel({}, true)).toBe("Bericht");
    expect(materialSourceLabel({ source: "bericht" }, false)).toBe("Report");
  });

  it("names every panel a verteiler row was scanned for", () => {
    expect(materialSourceLabel({ source: "verteiler", panel_numbers: ["VT-0007"] }, true)).toBe(
      "Verteiler VT-0007",
    );
    expect(
      materialSourceLabel({ source: "verteiler", panel_numbers: ["VT-0007", "VT-0012"] }, false),
    ).toBe("Panel VT-0007, VT-0012");
    // A verteiler row that arrives without numbers still says where it is from.
    expect(materialSourceLabel({ source: "verteiler" }, true)).toBe("Verteiler");
  });
});

describe("ProjectMaterialsTab source column", () => {
  it("shows Bericht for report rows and the panel number for verteiler rows", () => {
    renderTab([REPORT_ROW, PANEL_ROW]);

    expect(screen.getByRole("columnheader", { name: /Quelle/ })).toBeTruthy();
    const reportRow = screen.getByText("Kabel NYM-J 3x1,5").closest(".project-mat-tab-row");
    expect(within(reportRow as HTMLElement).getByText("Bericht")).toBeTruthy();
    const panelRow = screen
      .getByText("WAGO 2003-7641 - TOPJOB S Durchgangsklemme")
      .closest(".project-mat-tab-row");
    expect(within(panelRow as HTMLElement).getByText("Verteiler VT-0007")).toBeTruthy();
  });

  it("finds a panel's material by its number", () => {
    renderTab([REPORT_ROW, PANEL_ROW]);

    fireEvent.change(screen.getByPlaceholderText("Material suchen…"), {
      target: { value: "vt-0007" },
    });

    expect(screen.queryByText("Kabel NYM-J 3x1,5")).toBeNull();
    expect(screen.getByText("WAGO 2003-7641 - TOPJOB S Durchgangsklemme")).toBeTruthy();
    expect(screen.getByText(/1 Treffer/)).toBeTruthy();
  });

  it("sorts by source in both directions", () => {
    renderTab([PANEL_ROW, REPORT_ROW]);
    // Default order is by item name: "Kabel…" before "WAGO…".
    expect(rowTexts()).toEqual(["Bericht", "Verteiler VT-0007"]);

    const header = screen.getByRole("columnheader", { name: /Quelle/ });
    fireEvent.click(header);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(rowTexts()).toEqual(["Bericht", "Verteiler VT-0007"]);

    fireEvent.click(header);
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(rowTexts()).toEqual(["Verteiler VT-0007", "Bericht"]);
  });

  it("labels in English when the UI is", () => {
    renderTab([REPORT_ROW, PANEL_ROW], { language: "en" });
    expect(screen.getByText("Report")).toBeTruthy();
    expect(screen.getByText("Panel VT-0007")).toBeTruthy();
  });

  describe("CSV export", () => {
    let captured: Blob | null = null;
    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;

    beforeEach(() => {
      captured = null;
      URL.createObjectURL = (blob: Blob) => {
        captured = blob;
        return "blob:test";
      };
      // jsdom has no navigation; a real click would only log a "not
      // implemented" error underneath the assertion that matters.
      HTMLAnchorElement.prototype.click = () => undefined;
    });

    afterEach(() => {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    });

    function readBlob(blob: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
      });
    }

    it("carries the source as its own column", async () => {
      renderTab([REPORT_ROW, PANEL_ROW]);

      fireEvent.click(screen.getByRole("button", { name: /CSV exportieren/ }));

      expect(captured).not.toBeNull();
      const csv = await readBlob(captured as unknown as Blob);
      const lines = csv.replace(/^﻿/, "").split("\r\n");
      expect(lines[0].endsWith(",Quelle")).toBe(true);
      // "3x1,5" carries a comma, so its cell is quoted and the line starts
      // with a quote mark — hence includes, not startsWith.
      expect(lines.find((line) => line.includes("Kabel NYM-J"))?.endsWith(",Bericht")).toBe(true);
      expect(
        lines.find((line) => line.includes("WAGO 2003-7641"))?.endsWith(",Verteiler VT-0007"),
      ).toBe(true);
    });
  });
});
