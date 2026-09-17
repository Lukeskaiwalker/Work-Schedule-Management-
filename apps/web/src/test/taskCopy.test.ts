/**
 * "Aufgabe kopieren" prefills the create modal. What gets copied is the
 * job description; what does NOT is everything bound to the original's date
 * and crate — those are exactly the things the operator must set afresh, and
 * silently carrying them over is how a confirmed date or a packed crate ends
 * up on the wrong job.
 *
 * The copy is taken from the edit modal's LIVE form, so an unsaved rewrite
 * lands in the copy; the stored-row copy is the same thing for a form nobody
 * touched, and both obey the same do-not-copy list.
 */
import { describe, expect, it } from "vitest";
import {
  buildTaskModalCopyState,
  buildTaskModalCopyStateFromEditForm,
  editFormCopyFields,
  taskCopyFields,
  taskCopyNotice,
} from "../utils/taskCopy";
import { buildTaskEditFormState, buildTaskModalFormState } from "../utils/reports";
import type { Task } from "../types";

function source(overrides: Partial<Task> = {}): Task {
  return {
    id: 42,
    project_id: 7,
    customer_id: 3,
    title: "Zählerschrank tauschen",
    description: "Alt gegen neu",
    subtasks: ["Strom abschalten", "Schrank setzen"],
    materials_required: "Zählerschrank | 1 | Stk",
    storage_box_number: 9,
    construction_box_id: 12,
    task_type: "construction",
    class_template_id: 5,
    status: "done",
    planning_status: "confirmed",
    due_date: "2026-10-01",
    end_date: "2026-10-03",
    start_time: "08:00:00",
    estimated_hours: 8,
    assignee_ids: [2, 4],
    partner_ids: [11],
    customer_confirmation_status: "confirmed",
    customer_confirmation_at: "2026-09-20T10:00:00",
    ...overrides,
  };
}

describe("buildTaskModalCopyState", () => {
  const base = buildTaskModalFormState({ projectId: 7, projectQuery: "P-7 · Müller", taskType: "office" });

  it("copies the job description, crew, daily slot and project", () => {
    const copy = buildTaskModalCopyState(source(), base);
    expect(copy).toMatchObject({
      title: "Zählerschrank tauschen",
      description: "Alt gegen neu",
      subtasks_raw: "Strom abschalten\nSchrank setzen",
      materials_required: "Zählerschrank | 1 | Stk",
      task_type: "construction",
      class_template_id: "5",
      project_id: "7",
      project_query: "P-7 · Müller",
      assignee_ids: [2, 4],
      partner_ids: [11],
      start_time: "08:00",
      estimated_hours: "8",
    });
  });

  it("does not copy the date, the planning status, the crate or the confirmation", () => {
    const copy = buildTaskModalCopyState(source(), base);
    expect(copy.due_date).toBe("");
    expect(copy.end_date).toBe("");
    expect(copy.planning_status).toBe("");
    expect(copy.construction_box_id).toBe("");
    expect(copy.has_storage_box).toBe(false);
    expect(copy.storage_box_number).toBe("");
    expect(copy).not.toHaveProperty("customer_confirmation_status");
    expect(copy).not.toHaveProperty("status");
  });

  it("does not mutate the base form", () => {
    const frozen = { ...base };
    buildTaskModalCopyState(source(), base);
    expect(base).toEqual(frozen);
  });

  it("keeps the customer anchor only for a customer-only original", () => {
    const customerOnly = buildTaskModalCopyState(
      source({ project_id: null, customer_id: 3 }),
      buildTaskModalFormState(),
    );
    expect(customerOnly.project_id).toBe("");
    expect(customerOnly.project_query).toBe("");
    expect(customerOnly.customer_id).toBe(3);

    const projectTask = buildTaskModalCopyState(source(), base);
    expect(projectTask.customer_id).toBeNull();
  });

  it("falls back to the legacy single assignee and copies nothing when there is none", () => {
    expect(buildTaskModalCopyState(source({ assignee_ids: [], assignee_id: 9 }), base).assignee_ids).toEqual([9]);
    expect(buildTaskModalCopyState(source({ assignee_ids: undefined, assignee_id: null }), base).assignee_ids).toEqual([]);
    const bare = buildTaskModalCopyState(
      source({ description: null, subtasks: undefined, materials_required: null, class_template_id: null, start_time: null, estimated_hours: null, partner_ids: undefined }),
      base,
    );
    expect(bare).toMatchObject({
      description: "",
      subtasks_raw: "",
      materials_required: "",
      class_template_id: "",
      start_time: "",
      estimated_hours: "",
      partner_ids: [],
    });
  });
});

describe("buildTaskModalCopyStateFromEditForm", () => {
  const base = buildTaskModalFormState({ projectId: 7, projectQuery: "P-7 · Müller", taskType: "office" });

  it("copies what the operator sees: unsaved edits travel into the copy", () => {
    // The operator rewrote the task and clicked Kopieren instead of Speichern.
    // The stored row still says "Alt gegen neu"; the copy must not.
    const edited = {
      ...buildTaskEditFormState(source()),
      title: "Zählerschrank tauschen (2. Stock)",
      description: "Umgeschrieben, noch nicht gespeichert",
      subtasks_raw: "Nur noch ein Punkt",
      materials_required: "Zählerschrank | 2 | Stk",
      class_template_id: "9",
      assignee_ids: [9],
      partner_ids: [],
      start_time: "09:30",
      estimated_hours: "4",
    };
    const copy = buildTaskModalCopyStateFromEditForm(edited, base);
    expect(copy).toMatchObject({
      title: "Zählerschrank tauschen (2. Stock)",
      description: "Umgeschrieben, noch nicht gespeichert",
      subtasks_raw: "Nur noch ein Punkt",
      materials_required: "Zählerschrank | 2 | Stk",
      class_template_id: "9",
      assignee_ids: [9],
      partner_ids: [],
      start_time: "09:30",
      estimated_hours: "4",
      project_id: "7",
      project_query: "P-7 · Müller",
    });
    expect(copy.description).not.toBe(source().description);
  });

  it("is exactly the stored-row copy when nothing was edited", () => {
    const untouched = buildTaskEditFormState(source());
    expect(buildTaskModalCopyStateFromEditForm(untouched, base)).toEqual(buildTaskModalCopyState(source(), base));
    expect(editFormCopyFields(untouched)).toEqual(taskCopyFields(source()));
  });

  it("obeys the same do-not-copy list as the row copy", () => {
    const form = {
      ...buildTaskEditFormState(source()),
      due_date: "2026-11-11",
      end_date: "2026-11-12",
      planning_status: "tentative" as const,
      construction_box_id: "31",
      has_storage_box: true,
      storage_box_number: "9",
      status: "in_progress",
    };
    const copy = buildTaskModalCopyStateFromEditForm(form, base);
    expect(copy.due_date).toBe("");
    expect(copy.end_date).toBe("");
    expect(copy.planning_status).toBe("");
    expect(copy.construction_box_id).toBe("");
    expect(copy.has_storage_box).toBe(false);
    expect(copy.storage_box_number).toBe("");
    expect(copy).not.toHaveProperty("status");
  });

  it("keeps the customer anchor of a project-less form and drops it under a project", () => {
    const customerOnly = buildTaskModalCopyStateFromEditForm(
      buildTaskEditFormState(source({ project_id: null, customer_id: 3 })),
      buildTaskModalFormState(),
    );
    expect(customerOnly.project_id).toBe("");
    expect(customerOnly.project_query).toBe("");
    expect(customerOnly.customer_id).toBe(3);

    const projectTask = buildTaskModalCopyStateFromEditForm(buildTaskEditFormState(source()), base);
    expect(projectTask.customer_id).toBeNull();
  });

  it("does not share array state with the form it copied", () => {
    const form = buildTaskEditFormState(source());
    const copy = buildTaskModalCopyStateFromEditForm(form, base);
    expect(copy.assignee_ids).not.toBe(form.assignee_ids);
    expect(copy.partner_ids).not.toBe(form.partner_ids);
  });
});

describe("taskCopyNotice", () => {
  it("names the original in both languages", () => {
    expect(taskCopyNotice("Zählerschrank", "de")).toBe("Kopie von „Zählerschrank“ vorbereitet – Datum und Zuweisung prüfen");
    expect(taskCopyNotice("Meter board", "en")).toBe("Copy of “Meter board” prepared – check date and assignment");
  });
});
