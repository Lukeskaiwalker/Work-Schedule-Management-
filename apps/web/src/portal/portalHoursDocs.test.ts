import { describe, expect, it } from "vitest";
import { shiftDayIso } from "./portalDates";
import {
  documentKind,
  entryAmount,
  formatHours,
  groupDocuments,
  hoursProblem,
  parseHoursInput,
  stepHours,
} from "./portalHoursDocs";
import type { PortalDocument, PortalHoursEntry } from "./portalTypes";

function entry(fields: Partial<PortalHoursEntry>): PortalHoursEntry {
  return {
    id: 1,
    work_date: "2026-10-09",
    workers: 1,
    hours: 8,
    total_hours: 8,
    note: null,
    task: null,
    reported_by: null,
    created_at: "2026-10-09T15:00:00",
    can_delete: true,
    ...fields,
  };
}

function doc(id: number, folder: string, name = `Datei ${id}.pdf`): PortalDocument {
  return { id, file_name: name, content_type: "application/pdf", folder, created_at: "2026-10-09T10:00:00" };
}

describe("formatHours", () => {
  it("writes German decimals and drops trailing zeros", () => {
    expect(formatHours(8)).toBe("8 Std");
    expect(formatHours(7.5)).toBe("7,5 Std");
    expect(formatHours(0.25)).toBe("0,25 Std");
    expect(formatHours(15.75)).toBe("15,75 Std");
  });
});

describe("entryAmount", () => {
  it("shows the crew only when there is more than one person", () => {
    expect(entryAmount(entry({ workers: 1, hours: 6, total_hours: 6 }))).toBe("6 Std");
    expect(entryAmount(entry({ workers: 2, hours: 7.5, total_hours: 15 }))).toBe("2 × 7,5 Std = 15 Std");
  });
});

describe("parseHoursInput", () => {
  it("reads comma or point and keeps the quarter-hour grid", () => {
    expect(parseHoursInput("7,5")).toBe(7.5);
    expect(parseHoursInput(" 8 ")).toBe(8);
    expect(parseHoursInput("6.25")).toBe(6.25);
    expect(parseHoursInput("1,3")).toBeNull();
    expect(parseHoursInput("")).toBeNull();
    expect(parseHoursInput("acht")).toBeNull();
  });
});

describe("stepHours", () => {
  it("moves in half hours and stays between a quarter hour and 24", () => {
    expect(stepHours(8, 1)).toBe(8.5);
    expect(stepHours(8, -1)).toBe(7.5);
    expect(stepHours(0.5, -1)).toBe(0.25);
    expect(stepHours(0.25, -1)).toBe(0.25);
    expect(stepHours(24, 1)).toBe(24);
    expect(stepHours(7.25, 1)).toBe(7.75);
  });
});

describe("hoursProblem", () => {
  it("names the first thing that is wrong, in German", () => {
    expect(hoursProblem({ workers: 2, hours: 8, workDate: "2026-10-09", todayIso: "2026-10-09" })).toBeNull();
    expect(hoursProblem({ workers: 0, hours: 8, workDate: "2026-10-09", todayIso: "2026-10-09" })).toMatch(/Personen/);
    expect(hoursProblem({ workers: 51, hours: 8, workDate: "2026-10-09", todayIso: "2026-10-09" })).toMatch(/50/);
    expect(hoursProblem({ workers: 1, hours: null, workDate: "2026-10-09", todayIso: "2026-10-09" })).toMatch(/Viertelstunden/);
    expect(hoursProblem({ workers: 1, hours: 25, workDate: "2026-10-09", todayIso: "2026-10-09" })).toMatch(/24/);
    expect(hoursProblem({ workers: 1, hours: 8, workDate: "2026-10-10", todayIso: "2026-10-09" })).toMatch(/Zukunft/);
    expect(hoursProblem({ workers: 1, hours: 8, workDate: "", todayIso: "2026-10-09" })).toMatch(/Datum/);
  });
});

describe("groupDocuments", () => {
  it("puts the folder's own files first, then subfolders by name", () => {
    const groups = groupDocuments([doc(1, "Pläne"), doc(2, ""), doc(3, "Fotos vorher"), doc(4, "Pläne")]);
    expect(groups.map((group) => group.folder)).toEqual(["", "Fotos vorher", "Pläne"]);
    expect(groups[2].documents.map((d) => d.id)).toEqual([1, 4]);
  });
});

describe("documentKind", () => {
  it("tells plans, photos and anything else apart", () => {
    expect(documentKind("application/pdf")).toBe("pdf");
    expect(documentKind("image/jpeg")).toBe("image");
    expect(documentKind("application/vnd.dwg")).toBe("file");
  });
});

describe("shiftDayIso", () => {
  it("moves across month ends in local time", () => {
    expect(shiftDayIso("2026-10-01", -1)).toBe("2026-09-30");
    expect(shiftDayIso("2026-12-31", 1)).toBe("2027-01-01");
  });
});
