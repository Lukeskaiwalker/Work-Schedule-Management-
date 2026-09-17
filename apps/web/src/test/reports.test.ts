/**
 * Box materials round-trip through the Baustellenbericht.
 *
 * A task carries the rows the server imported from its Baustellenkiste. The
 * report prefills "Verbrauchtes Material" from them, the crew edits or deletes
 * rows, and the submission has to hand `task_material_id` back for every row
 * — or the server cannot record what was used. These pin each hop: the
 * mapping, the payload, and the draft snapshot in between.
 */
import { describe, expect, it } from "vitest";
import {
  TASK_EDIT_PATCH_KEYS,
  buildTaskEditFormState,
  buildTaskModalFormState,
  consumedMaterialsPayload,
  createReportMaterialRow,
  reportRowsFromTaskMaterials,
  reportUploadProgressText,
  storedMaterialRowSnapshot,
  taskEditPayloadFromForm,
  taskEndDatePayload,
  taskModalStateWithProject,
} from "../utils/reports";
import type { Task, TaskMaterial } from "../types";

function material(overrides: Partial<TaskMaterial> = {}): TaskMaterial {
  return {
    id: 7,
    item_name: "NYM-J 3x1,5",
    article_no: "A-1001",
    ean: null,
    unit: "m",
    quantity: 100,
    quantity_used: null,
    article_id: null,
    source_box_id: 3,
    notes: null,
    settled_at: null,
    ...overrides,
  };
}

describe("reportRowsFromTaskMaterials", () => {
  it("keeps the task material id and copies name, unit and article number", () => {
    const [row] = reportRowsFromTaskMaterials([material()]);
    expect(row).toMatchObject({
      task_material_id: 7,
      item: "NYM-J 3x1,5",
      qty: "100",
      unit: "m",
      article_no: "A-1001",
    });
    expect(row?.id).toMatch(/^materials-/);
  });

  it("prefers the reported quantity over the packed one, including a reported zero", () => {
    const rows = reportRowsFromTaskMaterials([
      material({ id: 1, quantity: 100, quantity_used: 42 }),
      material({ id: 2, quantity: 5, quantity_used: 0 }),
      material({ id: 3, quantity: 5, quantity_used: null }),
    ]);
    expect(rows.map((row) => row.qty)).toEqual(["42", "0", "5"]);
  });

  it("renders a missing unit or article number as an empty string, not 'null'", () => {
    const [row] = reportRowsFromTaskMaterials([material({ unit: null, article_no: null })]);
    expect(row?.unit).toBe("");
    expect(row?.article_no).toBe("");
  });

  it("produces one row per material with distinct row ids", () => {
    const rows = reportRowsFromTaskMaterials([material({ id: 1 }), material({ id: 2 })]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });
});

describe("consumedMaterialsPayload", () => {
  it("carries task_material_id on prefilled rows and null on hand-typed ones", () => {
    const rows = [
      ...reportRowsFromTaskMaterials([material({ id: 9 })]),
      createReportMaterialRow("materials", { item: "Kabelbinder", qty: "1", unit: "Pkg" }),
    ];
    const payload = consumedMaterialsPayload(rows);
    expect(payload).toEqual([
      { item: "NYM-J 3x1,5", qty: "100", unit: "m", article_no: "A-1001", task_material_id: 9 },
      { item: "Kabelbinder", qty: "1", unit: "Pkg", article_no: null, task_material_id: null },
    ]);
  });

  it("keeps the id after the user edits the quantity via a row spread", () => {
    const [row] = reportRowsFromTaskMaterials([material({ id: 9 })]);
    const edited = { ...row, qty: " 12 " };
    expect(consumedMaterialsPayload([edited])).toEqual([
      expect.objectContaining({ qty: "12", task_material_id: 9 }),
    ]);
  });

  it("drops rows without an item and blanks become null", () => {
    const payload = consumedMaterialsPayload([
      createReportMaterialRow("materials"),
      createReportMaterialRow("materials", { item: "  Dose  ", qty: "", unit: " ", article_no: "" }),
    ]);
    expect(payload).toEqual([
      { item: "Dose", qty: null, unit: null, article_no: null, task_material_id: null },
    ]);
  });
});

describe("draft snapshot round-trip", () => {
  it("survives localStorage serialisation with the task link intact", () => {
    const rows = [
      ...reportRowsFromTaskMaterials([material({ id: 5 })]),
      createReportMaterialRow("materials", { item: "Schrauben" }),
    ];
    const stored = JSON.parse(JSON.stringify(storedMaterialRowSnapshot(rows))) as unknown[];
    const restored = (stored as Array<Record<string, unknown>>).map((r) => ({
      ...createReportMaterialRow("materials"),
      ...r,
    }));
    expect(restored[0]).toMatchObject({ item: "NYM-J 3x1,5", task_material_id: 5 });
    expect(restored[1]).toMatchObject({ item: "Schrauben", task_material_id: null });
    expect(stored[0]).not.toHaveProperty("id");
  });

  it("restores a pre-feature draft row (no task_material_id) as a hand-typed row", () => {
    const legacy = { item: "Alt", qty: "1", unit: "Stk", article_no: "" };
    const restored = { ...createReportMaterialRow("materials"), ...legacy };
    expect(consumedMaterialsPayload([restored])[0]?.task_material_id).toBeNull();
  });
});

/**
 * Internal planning certainty through the edit form.
 *
 * The select stores "" for "not set" like the form's other optional selects;
 * the PATCH must turn that back into an explicit null (the contract reads
 * null as "clear", omitted as "unchanged"). And the dirty-diff key list in
 * saveTaskEdit is the gate every field has to pass — a key missing there is
 * inert on save, which is exactly what happened to the customer-confirmation
 * checkbox for a while.
 */
function taskRow(overrides: Partial<Task> = {}): Task {
  return { id: 1, project_id: 1, title: "Zählerschrank", status: "open", ...overrides };
}

describe("buildTaskEditFormState / planning_status", () => {
  it("seeds '' when the task has no planning status", () => {
    expect(buildTaskEditFormState(taskRow({ planning_status: null })).planning_status).toBe("");
    expect(buildTaskEditFormState(taskRow()).planning_status).toBe("");
    expect(buildTaskEditFormState(null).planning_status).toBe("");
  });

  it("seeds the stored value", () => {
    expect(buildTaskEditFormState(taskRow({ planning_status: "tentative" })).planning_status).toBe("tentative");
    expect(buildTaskEditFormState(taskRow({ planning_status: "confirmed" })).planning_status).toBe("confirmed");
  });

  it("seeds a legacy status spelling as its canonical key so the Status select has a match", () => {
    expect(buildTaskEditFormState(taskRow({ status: "Offen" })).status).toBe("open");
    expect(buildTaskEditFormState(taskRow({ status: "completed" })).status).toBe("done");
  });
});

describe("taskEditPayloadFromForm / planning_status", () => {
  it("emits null for the empty select and the value otherwise", () => {
    const base = buildTaskEditFormState(taskRow());
    expect(taskEditPayloadFromForm(base, null).planning_status).toBeNull();
    expect(taskEditPayloadFromForm({ ...base, planning_status: "confirmed" }, null).planning_status).toBe("confirmed");
    expect(taskEditPayloadFromForm({ ...base, planning_status: "tentative" }, null).planning_status).toBe("tentative");
  });

  it("does not register a change when the form was merely opened and closed", () => {
    const form = buildTaskEditFormState(taskRow({ status: "Offen", planning_status: "tentative" }));
    const before = taskEditPayloadFromForm(form, null);
    const after = taskEditPayloadFromForm({ ...form }, null);
    expect(after.planning_status).toBe(before.planning_status);
    expect(after.status).toBe(before.status);
  });
});

describe("TASK_EDIT_PATCH_KEYS", () => {
  it("routes the planning status and the customer-confirmation checkbox into the PATCH", () => {
    expect(TASK_EDIT_PATCH_KEYS).toContain("planning_status");
    expect(TASK_EDIT_PATCH_KEYS).toContain("request_customer_confirmation");
  });

  it("routes the end date into the PATCH, so moving only Bis reaches the api", () => {
    expect(TASK_EDIT_PATCH_KEYS).toContain("end_date");
  });

  it("only names keys the payload actually produces", () => {
    const payload = taskEditPayloadFromForm(buildTaskEditFormState(taskRow()), null);
    TASK_EDIT_PATCH_KEYS.forEach((key) => expect(payload).toHaveProperty(key));
  });
});

describe("reportUploadProgressText", () => {
  const retrying = { kind: "retrying", attempt: 2, maxAttempts: 3 } as const;

  it("shows the upload percentage, or movement when there is no total", () => {
    expect(reportUploadProgressText("uploading", 57, true)).toBe("Upload läuft: 57%");
    expect(reportUploadProgressText("uploading", 57, false)).toBe("Uploading: 57%");
    expect(reportUploadProgressText("uploading", null, true)).toBe("Upload läuft…");
    expect(reportUploadProgressText("uploading", null, false)).toBe("Uploading…");
  });

  it("says the bytes are through while the server still works", () => {
    expect(reportUploadProgressText("processing", 100, true)).toBe(
      "Upload abgeschlossen, Bericht wird verarbeitet…",
    );
    expect(reportUploadProgressText("processing", 100, false)).toBe(
      "Upload complete, report is being processed…",
    );
  });

  it("names the retry attempt after a dropped connection, with the new attempt's percentage once it moves", () => {
    expect(reportUploadProgressText(retrying, null, true)).toBe(
      "Verbindung unterbrochen — erneuter Versuch 2/3 …",
    );
    expect(reportUploadProgressText(retrying, null, false)).toBe("Connection lost — retrying 2/3 …");
    expect(reportUploadProgressText(retrying, 35, true)).toBe(
      "Verbindung unterbrochen — erneuter Versuch 2/3: 35%",
    );
    expect(reportUploadProgressText(retrying, 35, false)).toBe("Connection lost — retrying 2/3: 35%");
  });

  it("treats no phase like the plain upload, so the bar never goes blank mid-submit", () => {
    expect(reportUploadProgressText(null, 12, true)).toBe("Upload läuft: 12%");
  });
});

/**
 * "Bis" through the edit form. The api stores a single day as end_date NULL,
 * so the form must fold "same day spelled twice" onto null too — otherwise
 * opening and saving a single-day task would PATCH an end_date and reset the
 * customer's confirmation for a date that never moved.
 */
describe("taskEditPayloadFromForm / end_date", () => {
  it("seeds the stored window and emits it back", () => {
    const form = buildTaskEditFormState(taskRow({ due_date: "2026-10-01", end_date: "2026-10-03" }));
    expect(form.end_date).toBe("2026-10-03");
    expect(taskEditPayloadFromForm(form, null).end_date).toBe("2026-10-03");
  });

  it("is null for a single day, for Bis equal to Von, and whenever Von is empty", () => {
    const base = buildTaskEditFormState(taskRow({ due_date: "2026-10-01" }));
    expect(base.end_date).toBe("");
    expect(taskEditPayloadFromForm(base, null).end_date).toBeNull();
    expect(taskEditPayloadFromForm({ ...base, end_date: "2026-10-01" }, null).end_date).toBeNull();
    expect(taskEditPayloadFromForm({ ...base, due_date: "", end_date: "2026-10-03" }, null).end_date).toBeNull();
    expect(taskEndDatePayload("2026-10-01", " 2026-10-04 ")).toBe("2026-10-04");
  });
});

describe("taskModalStateWithProject", () => {
  it("drops the copied customer anchor and the crate when a project is picked", () => {
    // Kopieren on a customer-only task leaves customer_id=7 in the form. Picking
    // a legacy project without a customer must not keep the box picker on
    // customer 7's crates — the api would refuse the crate on POST.
    const copied = {
      ...buildTaskModalFormState(),
      customer_id: 7,
      construction_box_id: "31",
      class_template_id: "2",
      create_project_from_task: true,
      new_project_name: "Entwurf",
      new_project_number: "T-1",
    };
    const next = taskModalStateWithProject(copied, 12, "P-12 · Legacy");
    expect(next).toMatchObject({
      project_id: "12",
      project_query: "P-12 · Legacy",
      customer_id: null,
      construction_box_id: "",
      class_template_id: "",
      create_project_from_task: false,
      new_project_name: "",
      new_project_number: "",
    });
  });

  it("keeps everything the project does not imply, and does not mutate the input", () => {
    const current = { ...buildTaskModalFormState(), title: "Zählerschrank", assignee_ids: [4], customer_id: 7 };
    const next = taskModalStateWithProject(current, 12, "P-12");
    expect(next.title).toBe("Zählerschrank");
    expect(next.assignee_ids).toEqual([4]);
    expect(current.customer_id).toBe(7);
    expect(current.project_id).toBe("");
  });
});
