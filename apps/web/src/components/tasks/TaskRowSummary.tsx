/**
 * TaskRowSummary — the header of a task row: title, the Termin pill, the
 * ÜBERFÄLLIG/ERLEDIGT badge and the one-line meta (project · when · status).
 *
 * Extracted from MyTasksPage so the "Meine Aufgaben" card on the construction
 * overview renders exactly the same header: one place decides which badge a
 * row wears and how its date reads, so the two surfaces cannot drift.
 *
 * Presentational: everything it needs arrives as props, so a test can render
 * it without the app context.
 */
import type { Language, ProjectTitleParts, Task } from "../../types";
import {
  customerTaskFallbackLabel,
  formatTaskDateRange,
  formatTaskTimeRange,
  isCustomerOnlyTask,
  isTaskDoneStatus,
  taskCustomerName,
  taskDayCount,
  taskDisplayStatus,
  taskStatusLabel,
} from "../../utils/tasks";
import { PartnerTaskChip } from "../partners/PartnerTaskChip";
import { TaskAttachmentBadge } from "./TaskAttachmentBadge";
import { TerminBadge } from "./TerminBadge";
import "../../styles/tasks.css";

type Props = {
  task: Task;
  language: Language;
  todayIso: string;
  projectLabel: ProjectTitleParts;
  /**
   * The customer's name for a customer-only task, when the caller resolved
   * it (App's taskCustomerLabel reads the loaded customers). Without it the
   * row uses the name the api sent on the task, then "Kunde #id".
   */
  customerLabel?: string;
};

export function TaskRowSummary({ task, language, todayIso, projectLabel, customerLabel }: Props) {
  const de = language === "de";
  const displayStatus = taskDisplayStatus(task, todayIso);
  const dateRange = formatTaskDateRange(task);
  const dayCount = taskDayCount(task);
  // Where a project task says "Projekt: 2026-0412 · Name", a customer task
  // says "Kunde: Müller Haustechnik GmbH" — the row must name its anchor, or
  // the fitter cannot tell whose task this is without opening it.
  const customerName =
    !projectLabel.title && isCustomerOnlyTask(task)
      ? customerLabel || taskCustomerName(task) || customerTaskFallbackLabel(task, language)
      : "";
  return (
    <div className="tasks-page-row-title-block">
      <div className="tasks-page-row-title-line">
        <span className="tasks-page-row-title">{task.title}</span>
        <TerminBadge task={task} language={language} />
        {displayStatus === "overdue" && (
          <span className="tasks-page-row-badge tasks-page-row-badge--overdue">
            {de ? "ÜBERFÄLLIG" : "OVERDUE"}
          </span>
        )}
        {isTaskDoneStatus(task.status) && (
          <span className="tasks-page-row-badge tasks-page-row-badge--done">
            {de ? "ERLEDIGT" : "DONE"}
          </span>
        )}
        <TaskAttachmentBadge task={task} language={language} />
      </div>
      <span className="tasks-page-row-meta">
        {projectLabel.title ? (
          <>
            {de ? "Projekt" : "Project"}: {projectLabel.title}
            {"  |  "}
          </>
        ) : customerName ? (
          <>
            {de ? "Kunde" : "Customer"}: {customerName}
            {"  |  "}
          </>
        ) : null}
        {de ? "Fällig" : "Due"}: {dateRange || "-"}
        {task.start_time ? ` ${de ? "um" : "at"} ${formatTaskTimeRange(task)}` : ""}
        {dayCount > 1 ? (
          <span className="task-day-chip">
            {dayCount} {de ? "Tage" : "days"}
          </span>
        ) : null}
        {"  |  "}
        {de ? "Status" : "Status"}: {taskStatusLabel(displayStatus, language)}
      </span>
      {task.partners && task.partners.length > 0 && (
        <span className="tasks-page-row-partner-line">
          <PartnerTaskChip partners={task.partners} language={de ? "de" : "en"} />
        </span>
      )}
      {projectLabel.subtitle && (
        <span className="tasks-page-row-subtitle">{projectLabel.subtitle}</span>
      )}
    </div>
  );
}
