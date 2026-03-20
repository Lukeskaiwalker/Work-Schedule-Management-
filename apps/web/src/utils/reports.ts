import { EMPTY_REPORT_DRAFT } from "../constants";
import type {
  Language,
  Project,
  ReportDraft,
  ReportMaterialRow,
  Task,
  TaskType,
  TaskEditFormState,
  TaskModalState,
  ProjectTaskFormState,
} from "../types";
import { normalizeWeekStartISO } from "./dates";
import { parseTaskSubtasks, subtasksToTextareaValue, normalizeTaskTypeValue, formatTaskStartTime, parseListLines } from "./tasks";

let _rowCounter = 0;

export function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function buildClientFileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function nextReportMaterialRowId(prefix: "materials" | "office_materials") {
  _rowCounter += 1;
  return `${prefix}-${Date.now()}-${_rowCounter}`;
}

export function createReportMaterialRow(
  prefix: "materials" | "office_materials",
  values?: Partial<Omit<ReportMaterialRow, "id">>,
): ReportMaterialRow {
  return {
    id: nextReportMaterialRowId(prefix),
    item: values?.item ?? "",
    qty: values?.qty ?? "",
    unit: values?.unit ?? "",
    article_no: values?.article_no ?? "",
  };
}

export function parseReportMaterialRows(
  rawValue: string | null | undefined,
  prefix: "materials" | "office_materials",
): ReportMaterialRow[] {
  const rows = parseListLines(String(rawValue || "")).map((line) => {
    const [item, qty, unit, article_no] = line.split("|").map((entry) => entry.trim());
    if (!qty && !unit && !article_no) {
      return createReportMaterialRow(prefix, { item: line.trim() });
    }
    return createReportMaterialRow(prefix, {
      item: item || "",
      qty: qty || "",
      unit: unit || "",
      article_no: article_no || "",
    });
  });
  if (rows.length > 0) return rows;
  return [createReportMaterialRow(prefix)];
}

export function serializeTaskMaterialRows(rows: ReportMaterialRow[]) {
  const lines = rows
    .map((row) => {
      const item = row.item.trim();
      if (!item) return "";
      const qty = row.qty.trim();
      const unit = row.unit.trim();
      const articleNo = row.article_no.trim();
      if (!qty && !unit && !articleNo) return item;
      return [item, qty, unit, articleNo].join(" | ");
    })
    .filter((line) => line.length > 0);
  return lines.join("\n");
}

export function taskMaterialsDisplay(rawValue: string | null | undefined, language: Language) {
  const rows = parseReportMaterialRows(rawValue, "materials")
    .map((row) => {
      const item = row.item.trim();
      if (!item) return "";
      const qtyUnit = [row.qty.trim(), row.unit.trim()].filter((value) => value.length > 0).join(" ");
      const articleNo = row.article_no.trim();
      const parts = [item];
      if (qtyUnit) parts.push(qtyUnit);
      if (articleNo) parts.push(`${language === "de" ? "ArtNr" : "ArtNo"} ${articleNo}`);
      return parts.join(" - ");
    })
    .filter((line) => line.length > 0);
  return rows.join(", ");
}

export function serializeOfficeMaterialRows(rows: ReportMaterialRow[]) {
  const lines = rows
    .map((row) => {
      const item = row.item.trim();
      if (!item) return "";
      const qtyUnit = [row.qty.trim(), row.unit.trim()].filter((value) => value.length > 0).join(" ");
      const articleNo = row.article_no.trim();
      const parts = [item];
      if (qtyUnit) parts.push(qtyUnit);
      if (articleNo) parts.push(`ArtNr ${articleNo}`);
      return parts.join(" - ");
    })
    .filter((line) => line.length > 0);
  return lines.join("\n");
}

export function buildEmptyProjectTaskFormState(): ProjectTaskFormState {
  return {
    title: "",
    description: "",
    subtasks_raw: "",
    materials_required: "",
    has_storage_box: false,
    storage_box_number: "",
    task_type: "construction",
    class_template_id: "",
    due_date: "",
    start_time: "",
    estimated_hours: "",
    assignee_query: "",
    assignee_ids: [],
  };
}

export function buildTaskModalFormState(defaults?: {
  projectId?: number | null;
  dueDate?: string;
  projectQuery?: string;
  taskType?: TaskType;
}): TaskModalState {
  return {
    title: "",
    description: "",
    subtasks_raw: "",
    materials_required: "",
    has_storage_box: false,
    storage_box_number: "",
    task_type: defaults?.taskType ?? "construction",
    class_template_id: "",
    project_id: defaults?.projectId ? String(defaults.projectId) : "",
    project_query: defaults?.projectQuery ?? "",
    due_date: defaults?.dueDate ?? "",
    start_time: "",
    estimated_hours: "",
    assignee_query: "",
    assignee_ids: [],
    create_project_from_task: false,
    new_project_name: "",
    new_project_number: "",
  };
}

export function buildTaskEditFormState(task?: Task | null): TaskEditFormState {
  const assigneeIds =
    task?.assignee_ids && task.assignee_ids.length > 0
      ? task.assignee_ids
      : task?.assignee_id
        ? [task.assignee_id]
        : [];
  return {
    id: task?.id ?? null,
    project_id: task?.project_id ?? null,
    title: task?.title ?? "",
    description: task?.description ?? "",
    subtasks_raw: subtasksToTextareaValue(task?.subtasks),
    materials_required: task?.materials_required ?? "",
    has_storage_box: task?.storage_box_number != null,
    storage_box_number: task?.storage_box_number != null ? String(task.storage_box_number) : "",
    task_type: normalizeTaskTypeValue(task?.task_type),
    class_template_id: task?.class_template_id != null ? String(task.class_template_id) : "",
    status: task?.status ?? "open",
    due_date: task?.due_date ?? "",
    start_time: task?.start_time ? formatTaskStartTime(task.start_time) : "",
    estimated_hours: task?.estimated_hours != null ? String(task.estimated_hours) : "",
    assignee_query: "",
    assignee_ids: assigneeIds,
    week_start: task?.week_start ?? "",
  };
}

export function taskEditPayloadFromForm(form: TaskEditFormState, normalizedStartTime: string | null) {
  const dueDate = form.due_date.trim() || null;
  const estimatedHours =
    form.estimated_hours.trim().length > 0 ? Number(form.estimated_hours.trim()) : null;
  const storageBoxNumber =
    form.has_storage_box && form.storage_box_number.trim()
      ? Number(form.storage_box_number)
      : null;
  const classTemplateId =
    form.class_template_id.trim().length > 0 ? Number(form.class_template_id) : null;
  const weekStartValue = dueDate ? normalizeWeekStartISO(dueDate) : form.week_start.trim() || null;
  return {
    title: form.title.trim(),
    description: form.description.trim() || null,
    subtasks: parseTaskSubtasks(form.subtasks_raw),
    materials_required: form.materials_required.trim() || null,
    storage_box_number: storageBoxNumber,
    task_type: form.task_type,
    class_template_id: classTemplateId,
    status: form.status.trim() || "open",
    due_date: dueDate,
    start_time: normalizedStartTime,
    estimated_hours: estimatedHours,
    assignee_ids: form.assignee_ids,
    week_start: weekStartValue,
  };
}

export function reportDraftFromProject(project: Project | null): ReportDraft {
  if (!project) return { ...EMPTY_REPORT_DRAFT };
  return {
    customer: project.customer_name ?? "",
    customer_address: project.customer_address ?? "",
    customer_contact: project.customer_contact ?? "",
    customer_email: project.customer_email ?? "",
    customer_phone: project.customer_phone ?? "",
    project_name: project.name ?? "",
    project_number: project.project_number ?? "",
  };
}

export function sameNumberSet(left: number[], right: number[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
