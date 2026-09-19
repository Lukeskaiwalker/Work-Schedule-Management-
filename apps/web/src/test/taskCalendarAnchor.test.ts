/**
 * The calendar export names where a task belongs. A project task's event
 * says the project and its customer and sits at the site; a customer-only
 * task's event used to say "Project ID: null" and had no location at all —
 * it now names the customer and takes the customer's address, so the entry
 * in the fitter's phone can navigate there like a project entry can.
 */
import { describe, expect, it } from "vitest";
import { taskCalendarAnchor } from "../utils/tasks";
import type { Project } from "../types";

const PROJECT: Project = {
  id: 12,
  project_number: "2026-0412",
  name: "Umbau",
  status: "active",
  customer_name: "Müller",
  customer_address: "Nebenstr. 5, 12345 Berlin",
  construction_site_address: "Baustellenweg 9, 12345 Berlin",
};

describe("taskCalendarAnchor", () => {
  it("names the customer and uses the customer's address for a customer-only task", () => {
    const anchor = taskCalendarAnchor(
      { id: 5, title: "Rückruf wegen Angebot", project_id: null, customer_id: 7 },
      undefined,
      { name: "Müller Haustechnik GmbH", address: "Hauptstr. 1, 12345 Berlin" },
    );
    expect(anchor.summaryBase).toBe("Müller Haustechnik GmbH - Rückruf wegen Angebot");
    expect(anchor.anchorLines).toEqual(["Customer: Müller Haustechnik GmbH", "Address: Hauptstr. 1, 12345 Berlin"]);
    expect(anchor.location).toBe("Hauptstr. 1, 12345 Berlin");
    expect(anchor.fileNameSource).toBe("kunde-7-5");
    expect(anchor.anchorLines.join("\n")).not.toMatch(/Project ID/);
  });

  it("leaves the address line out when the customer has none", () => {
    const anchor = taskCalendarAnchor(
      { id: 5, title: "Rückruf", project_id: null, customer_id: 7 },
      undefined,
      { name: "Schmidt Elektro", address: "" },
    );
    expect(anchor.anchorLines).toEqual(["Customer: Schmidt Elektro"]);
    expect(anchor.location).toBe("");
  });

  it("names the project and its customer, at the site, for a project task", () => {
    const anchor = taskCalendarAnchor({ id: 6, title: "Zählerwechsel", project_id: 12, customer_id: null }, PROJECT, null);
    expect(anchor.summaryBase).toBe("2026-0412 - Zählerwechsel");
    expect(anchor.anchorLines[0]).toMatch(/^Project: 2026-0412/);
    expect(anchor.anchorLines[1]).toBe("Customer: Müller");
    expect(anchor.location).toBe("Baustellenweg 9, 12345 Berlin");
    expect(anchor.fileNameSource).toBe("2026-0412-6");
  });

  it("falls back to the project id when the project is not loaded", () => {
    const anchor = taskCalendarAnchor({ id: 6, title: "Zählerwechsel", project_id: 99, customer_id: null }, undefined, null);
    expect(anchor.summaryBase).toBe("Zählerwechsel");
    expect(anchor.anchorLines).toEqual(["Project ID: 99"]);
    expect(anchor.fileNameSource).toBe("task-6");
  });
});
