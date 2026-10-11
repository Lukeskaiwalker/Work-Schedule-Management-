/**
 * Machine values never reach the German UI raw.
 *
 * Found on a screenshot pass of v2.14.40: a customer's project list said
 * "in_durchfuehrung", a project overview said "construction", the sidebar
 * said "employee", the Zeiterfassung calendar started "Mo Tu We". Every value
 * the API stores as a key (status, task type, role, audit target, extraction
 * job state) goes through a label map; these tests pin that every KNOWN key
 * has a German label and that an UNKNOWN one falls back to something sensible
 * instead of an empty cell.
 */
import { describe, expect, it } from "vitest";

import { auditTargetLabel } from "../components/admin/auditLabels";
import { PROJECT_STATUS_PRESETS } from "../constants";
import { weekdayShortLabels } from "../utils/dates";
import { lineItemJobStatusLabel } from "../utils/projectLineItemsApi";
import { permissionDescription, permissionGroupLabel, permissionLabel } from "../utils/permissionLabels";
import { activityEventLabel, statusLabel } from "../utils/projects";
import { ROLE_KEYS, roleLabel } from "../utils/roles";
import { normalizeTaskTypeValue, taskStatusLabel, taskTypeLabel } from "../utils/tasks";
import type { RolePermissionsMeta, TaskType } from "../types";

/** A German label is not the key and not an obvious English word. */
function expectGerman(label: string, key: string) {
  expect(label, key).toBeTruthy();
  expect(label, key).not.toBe(key);
  expect(label, key).not.toMatch(/_/);
  expect(label, key).not.toMatch(/\b(Construction|Office|Task|Open|Done|In progress|Employee|Planning|Accountant|Queued|Processing|Completed|Failed|User|Project)\b/);
}

describe("project status labels", () => {
  it("names every funnel stage in German", () => {
    expect(PROJECT_STATUS_PRESETS.map((key) => statusLabel(key, "de"))).toEqual([
      "Angebotsphase",
      "In Durchführung",
      "Rechnung verschickt",
      "Abgeschlossen",
    ]);
    expect(statusLabel("archived", "de")).toBe("Archiviert");
  });

  it("heals the legacy machine values to their stage", () => {
    expect(statusLabel("active", "de")).toBe("In Durchführung");
    expect(statusLabel("completed", "de")).toBe("Abgeschlossen");
  });

  it("shows unknown imported free text as it is, and an empty status as the first stage", () => {
    expect(statusLabel("Warten auf Netzbetreiber", "de")).toBe("Warten auf Netzbetreiber");
    expect(statusLabel("", "de")).toBe("Angebotsphase");
  });
});

describe("change-log event labels", () => {
  // Every event type the API writes into project_activities / customer_activities.
  const EVENTS = [
    "project.created",
    "project.classes_updated",
    "project.state_changed",
    "project.note_updated",
    "project.note_posted",
    "project.visit_posted",
    "project.visit_updated",
    "project.visit_deleted",
    "project.report_finalized",
    "project.report_finalize_failed",
    "project.critical_set",
    "project.critical_cleared",
    "project.partner_assigned",
    "project.partner_removed",
    "customer.created",
    "customer.updated",
    "customer.note_posted",
    "customer.note_deleted",
    "customer.visit_posted",
    "customer.visit_updated",
    "customer.visit_deleted",
    "customer.credential_created",
    "customer.credential_updated",
    "customer.credential_deleted",
    "customer.credential_revealed",
    "customer.archived",
    "customer.unarchived",
    "task.created",
    "task.updated",
    "task.deleted",
    "task.materials_settled",
    "ticket.created",
    "ticket.updated",
    "file.uploaded",
    "file.deleted",
    "report.created",
    "material.created",
    "material.status_updated",
    "material.updated",
    "material.deleted",
    "material.bulk_status_updated",
    "material.bulk_deleted",
    "material.ordered",
    "finance.updated",
    "partner.hours_reported",
    "partner.hours_deleted",
  ];

  it("names every event the API writes in German", () => {
    for (const event of EVENTS) {
      const label = activityEventLabel(event, "de");
      expect(label, event).not.toBe("Änderung");
      expect(label, event).not.toContain(".");
    }
    expect(activityEventLabel("task.created", "de")).toBe("Aufgabe erstellt");
  });

  it("says a plain word for an event this build does not know, never the key", () => {
    expect(activityEventLabel("project.something_new", "de")).toBe("Änderung");
    expect(activityEventLabel("project.something_new", "en")).toBe("Change");
  });
});

describe("task type labels", () => {
  const TYPES: TaskType[] = ["construction", "office", "customer_appointment"];

  it("names every task type in German", () => {
    expect(TYPES.map((type) => taskTypeLabel(type, "de"))).toEqual(["Baustellenaufgabe", "Büroaufgabe", "Kundentermin"]);
    for (const type of TYPES) expectGerman(taskTypeLabel(type, "de"), type);
  });

  it("reads an unknown or missing type as a construction task", () => {
    expect(taskTypeLabel(normalizeTaskTypeValue("something_new"), "de")).toBe("Baustellenaufgabe");
    expect(taskTypeLabel(normalizeTaskTypeValue(null), "de")).toBe("Baustellenaufgabe");
  });
});

describe("task status labels", () => {
  it("names every status in German", () => {
    for (const status of ["open", "in_progress", "on_hold", "overdue", "done"]) {
      expectGerman(taskStatusLabel(status, "de"), status);
    }
    expect(taskStatusLabel("in_progress", "de")).toBe("In Arbeit");
  });

  it("shows an unknown status as it is rather than an empty cell", () => {
    expect(taskStatusLabel("waiting_for_parts", "de")).toBe("waiting_for_parts");
    expect(taskStatusLabel("", "de")).toBe("-");
  });
});

describe("role labels", () => {
  it("names every role in German", () => {
    expect(ROLE_KEYS.map((role) => roleLabel(role, "de"))).toEqual([
      "Admin",
      "Geschäftsführung",
      "Buchhaltung",
      "Planung",
      "Mitarbeiter",
      "Partner",
    ]);
  });

  it("speaks English in the English UI", () => {
    expect(roleLabel("employee", "en")).toBe("Employee");
    expect(roleLabel("ceo", "en")).toBe("CEO");
  });

  it("falls back to the stored value for a role it does not know, and to a dash for none", () => {
    expect(roleLabel("auditor", "de")).toBe("auditor");
    expect(roleLabel(" Employee ", "de")).toBe("Mitarbeiter");
    expect(roleLabel(null, "de")).toBe("—");
  });
});

describe("weekday header", () => {
  it("is Monday-first German in the German UI", () => {
    expect(weekdayShortLabels("de")).toEqual(["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);
  });

  it("is Monday-first English in the English UI", () => {
    expect(weekdayShortLabels("en")).toEqual(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
  });
});

describe("audit log target labels", () => {
  it("names the targets the API writes in German", () => {
    for (const target of ["user", "project", "task", "settings", "backup", "school_absence", "role", "employee_group"]) {
      expectGerman(auditTargetLabel(target, true), target);
    }
    expect(auditTargetLabel("user", true)).toBe("Benutzer");
    expect(auditTargetLabel("project_line_item", true)).toBe("Projektposition");
  });

  it("keeps an unknown target as it is", () => {
    expect(auditTargetLabel("brand_new_thing", true)).toBe("brand_new_thing");
    expect(auditTargetLabel("user", false)).toBe("User");
  });
});

describe("line-item extraction job status", () => {
  it("names every state in German", () => {
    expect(["queued", "processing", "completed", "failed"].map((s) => lineItemJobStatusLabel(s, true))).toEqual([
      "In Warteschlange",
      "Wird verarbeitet",
      "Abgeschlossen",
      "Fehlgeschlagen",
    ]);
  });

  it("keeps an unknown state as it is", () => {
    expect(lineItemJobStatusLabel("paused", true)).toBe("paused");
  });
});

describe("permission labels from the API", () => {
  const META: RolePermissionsMeta = {
    permissions: {},
    all_permissions: ["users:manage", "audit:view"],
    permission_labels: { "users:manage": "Benutzer verwalten" },
    permission_descriptions: { "users:manage": "Benutzer anlegen …" },
    permission_labels_en: { "users:manage": "Manage users" },
    permission_descriptions_en: { "users:manage": "Create, edit …" },
    permission_groups: [{ key: "users", label: "Benutzer", label_en: "Users", permissions: ["users:manage"] }],
    all_roles: ["admin"],
  };

  it("uses the German set in the German UI and the English twin in the English UI", () => {
    expect(permissionLabel(META, "users:manage", "de")).toBe("Benutzer verwalten");
    expect(permissionLabel(META, "users:manage", "en")).toBe("Manage users");
    expect(permissionDescription(META, "users:manage", "de")).toBe("Benutzer anlegen …");
    expect(permissionDescription(META, "users:manage", "en")).toBe("Create, edit …");
    expect(permissionGroupLabel(META.permission_groups[0], "de")).toBe("Benutzer");
    expect(permissionGroupLabel(META.permission_groups[0], "en")).toBe("Users");
  });

  it("falls back to the plain set when an older server sends no English twin, and to the key", () => {
    const older = { ...META, permission_labels_en: undefined, permission_descriptions_en: undefined };
    expect(permissionLabel(older, "users:manage", "en")).toBe("Benutzer verwalten");
    expect(permissionLabel(META, "audit:view", "de")).toBe("audit:view");
    expect(permissionDescription(META, "audit:view", "de")).toBe("");
    expect(permissionGroupLabel({ key: "x", label: "X", permissions: [] }, "en")).toBe("X");
  });
});
