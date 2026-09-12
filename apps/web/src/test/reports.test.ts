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
  consumedMaterialsPayload,
  createReportMaterialRow,
  reportRowsFromTaskMaterials,
  storedMaterialRowSnapshot,
  taskEditPayloadFromForm,
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

  it("only names keys the payload actually produces", () => {
    const payload = taskEditPayloadFromForm(buildTaskEditFormState(taskRow()), null);
    TASK_EDIT_PATCH_KEYS.forEach((key) => expect(payload).toHaveProperty(key));
  });
});
