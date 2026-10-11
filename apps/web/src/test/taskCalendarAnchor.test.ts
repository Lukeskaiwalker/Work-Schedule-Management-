/**
 * The calendar export names where a task belongs. A project task's event
 * says the project and its customer and sits at the site; a customer-only
 * task's event used to say "Project ID: null" and had no location at all —
 * it now names the customer and takes the customer's address, so the entry
 * in the fitter's phone can navigate there like a project entry can.
 *
 * The lines are German in the German UI ("Kunde:", "Projekt:"), as the
 * server's calendar feed has always written them; English only in English.
 */
import { describe, expect, it } from "vitest";
import { taskCalendarAnchor, taskCalendarDescriptionLines } from "../utils/tasks";
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
      "de",
    );
    expect(anchor.summaryBase).toBe("Müller Haustechnik GmbH - Rückruf wegen Angebot");
    expect(anchor.anchorLines).toEqual(["Kunde: Müller Haustechnik GmbH", "Adresse: Hauptstr. 1, 12345 Berlin"]);
    expect(anchor.location).toBe("Hauptstr. 1, 12345 Berlin");
    expect(anchor.fileNameSource).toBe("kunde-7-5");
    expect(anchor.anchorLines.join("\n")).not.toMatch(/Projekt-ID|Project ID/);
  });

  it("leaves the address line out when the customer has none", () => {
    const anchor = taskCalendarAnchor(
      { id: 5, title: "Rückruf", project_id: null, customer_id: 7 },
      undefined,
      { name: "Schmidt Elektro", address: "" },
      "de",
    );
    expect(anchor.anchorLines).toEqual(["Kunde: Schmidt Elektro"]);
    expect(anchor.location).toBe("");
  });

  it("names the project and its customer, at the site, for a project task", () => {
    const anchor = taskCalendarAnchor({ id: 6, title: "Zählerwechsel", project_id: 12, customer_id: null }, PROJECT, null, "de");
    expect(anchor.summaryBase).toBe("2026-0412 - Zählerwechsel");
    expect(anchor.anchorLines[0]).toMatch(/^Projekt: 2026-0412/);
    expect(anchor.anchorLines[1]).toBe("Kunde: Müller");
    expect(anchor.location).toBe("Baustellenweg 9, 12345 Berlin");
    expect(anchor.fileNameSource).toBe("2026-0412-6");
  });

  it("falls back to the project id when the project is not loaded", () => {
    const anchor = taskCalendarAnchor({ id: 6, title: "Zählerwechsel", project_id: 99, customer_id: null }, undefined, null, "de");
    expect(anchor.summaryBase).toBe("Zählerwechsel");
    expect(anchor.anchorLines).toEqual(["Projekt-ID: 99"]);
    expect(anchor.fileNameSource).toBe("task-6");
  });

  it("keeps the English lines in the English UI", () => {
    const anchor = taskCalendarAnchor({ id: 6, title: "Zählerwechsel", project_id: 12, customer_id: null }, PROJECT, null, "en");
    expect(anchor.anchorLines[0]).toMatch(/^Project: 2026-0412/);
    expect(anchor.anchorLines[1]).toBe("Customer: Müller");
  });
});

describe("taskCalendarDescriptionLines", () => {
  const BASE = {
    taskId: 6,
    status: "in_progress",
    anchorLines: ["Projekt: 2026-0412 · Umbau", "Kunde: Müller"],
    multiDay: false,
    dateRange: "2026-10-12 – 2026-10-14",
    dueDate: "2026-10-12",
    timeRange: "08:00-16:00",
    description: "Zählerplatz vorbereiten",
    materials: "NYM-J 5x2,5 - 25 m",
    box: "K-12",
    assignees: "Anna, Bob",
  };

  it("says every line in German, with the status as a label", () => {
    expect(taskCalendarDescriptionLines(BASE, "de")).toEqual([
      "Aufgabe: #6",
      "Status: In Arbeit",
      "Projekt: 2026-0412 · Umbau",
      "Kunde: Müller",
      "Fällig: 2026-10-12",
      "Uhrzeit: 08:00-16:00",
      "Info: Zählerplatz vorbereiten",
      "Material: NYM-J 5x2,5 - 25 m",
      "Baustellenkiste: K-12",
      "Zugewiesen: Anna, Bob",
    ]);
  });

  it("gives a multi-day task its window and daily hours", () => {
    const lines = taskCalendarDescriptionLines({ ...BASE, multiDay: true }, "de");
    expect(lines).toContain("Zeitraum: 2026-10-12 – 2026-10-14");
    expect(lines).toContain("Uhrzeit: 08:00-16:00 täglich");
  });

  it("leaves out what the task does not have", () => {
    const lines = taskCalendarDescriptionLines(
      { ...BASE, timeRange: "", description: "", materials: "", box: "", dueDate: null },
      "de",
    );
    expect(lines).toEqual([
      "Aufgabe: #6",
      "Status: In Arbeit",
      "Projekt: 2026-0412 · Umbau",
      "Kunde: Müller",
      "Fällig: -",
      "Zugewiesen: Anna, Bob",
    ]);
  });

  it("keeps the English lines in the English UI", () => {
    const lines = taskCalendarDescriptionLines({ ...BASE, multiDay: true }, "en");
    expect(lines[0]).toBe("Task ID: #6");
    expect(lines[1]).toBe("Status: In progress");
    expect(lines).toContain("From/To: 2026-10-12 – 2026-10-14");
    expect(lines).toContain("Time: 08:00-16:00 daily");
    expect(lines).toContain("Assignees: Anna, Bob");
  });
});
