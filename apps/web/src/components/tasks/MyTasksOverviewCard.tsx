/**
 * MyTasksOverviewCard — "Meine Aufgaben" on the construction overview.
 *
 * The overview used to show the project list here; the field worker's first
 * question on opening the app is "what is on for me", so this card answers
 * it: my tasks, overdue first, with a status filter that also reaches the
 * recently completed ones (the api's view=my_all, capped server-side to the
 * last 30 days so the box cannot grow forever).
 *
 * The filter logic is the office page's (officeFilteredTasks in App.tsx):
 * "overdue" is a computed state, every other value compares canonical
 * statuses — a legacy "Offen" row matches "open".
 *
 * The start page's „Meine Aufgaben“ widget renders this same card inside its
 * own frame (docs/DASHBOARD.md §10, W3): `embedded` drops the card chrome,
 * `rowLimit` and `showFilter` follow the widget size, and `onOpenList` lets
 * the dashboard pick the page (the office task list in Büro mode). Without
 * props the card is exactly what it was.
 */
import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import type { Task } from "../../types";
import {
  canonicalTaskStatus,
  isTaskDoneStatus,
  isTaskOverdue,
  sortTasksByDueTime,
  taskDisplayStatus,
  taskStatusLabel,
} from "../../utils/tasks";
import { TaskRowSummary } from "./TaskRowSummary";
import "../../styles/tasks.css";

/** Fixed, in display order — not derived from the rows, so the select never
 *  loses an option while a filter that would show nothing is active. */
export const MY_TASKS_FILTER_OPTIONS = ["all", "open", "in_progress", "on_hold", "done", "overdue"] as const;
export type MyTasksFilter = (typeof MY_TASKS_FILTER_OPTIONS)[number];

/** Rows shown before the card folds the rest behind "+n weitere". */
export const MY_TASKS_CARD_ROW_LIMIT = 8;

export function filterMyTasks(tasks: Task[], filter: MyTasksFilter, todayIso: string): Task[] {
  if (filter === "all") return tasks;
  if (filter === "overdue") return tasks.filter((task) => isTaskOverdue(task, todayIso));
  return tasks.filter((task) => canonicalTaskStatus(task.status) === filter);
}

/** Overdue first (by due date), then open work by due date/time, done last. */
export function sortMyTasksForCard(tasks: Task[], todayIso: string): Task[] {
  const byDue = sortTasksByDueTime(tasks);
  const overdue = byDue.filter((task) => isTaskOverdue(task, todayIso));
  const open = byDue.filter((task) => !isTaskOverdue(task, todayIso) && !isTaskDoneStatus(task.status));
  const done = byDue.filter((task) => !isTaskOverdue(task, todayIso) && isTaskDoneStatus(task.status));
  return [...overdue, ...open, ...done];
}

/**
 * What a click on a row does for this user. Managers open the edit modal for
 * any row. Everyone else is taken to Meine Aufgaben — with the row expanded
 * for an open task, and WITHOUT an expanded id for a done one: that page
 * loads view=my (open only), so the done row is not there and an expanded id
 * would only be cleared again, leaving the user on a list without the task
 * they clicked and no sign why.
 */
export type MyTasksRowAction = "edit" | "expand" | "list";

export function myTasksRowAction(task: Task, canManageTasks: boolean): MyTasksRowAction {
  if (canManageTasks) return "edit";
  return isTaskDoneStatus(task.status) ? "list" : "expand";
}

export type MyTasksOverviewCardProps = {
  /** Rows before the rest folds behind „+n weitere“. */
  rowLimit?: number;
  /** The status filter; without it every task shows. */
  showFilter?: boolean;
  /** No card, title or „Alle anzeigen“ of its own: the host frame has them. */
  embedded?: boolean;
  /** Where „Alle anzeigen“, „+n weitere“ and an expanded row lead; default Meine Aufgaben. */
  onOpenList?: () => void;
};

export function MyTasksOverviewCard({
  rowLimit = MY_TASKS_CARD_ROW_LIMIT,
  showFilter = true,
  embedded = false,
  onOpenList,
}: MyTasksOverviewCardProps = {}) {
  const {
    language,
    sortedTasks,
    todayIso,
    isTaskAssignedToCurrentUser,
    taskProjectTitleParts,
    taskCustomerLabel,
    canManageTasks,
    openTaskEditModal,
    setExpandedMyTaskId,
    setMainView,
    setProjectBackView,
    setOverviewShortcutBackVisible,
  } = useAppContext();
  const [filter, setFilter] = useState<MyTasksFilter>("all");

  const myTasks = useMemo(
    () => sortMyTasksForCard(sortedTasks.filter((task) => isTaskAssignedToCurrentUser(task)), todayIso),
    [sortedTasks, isTaskAssignedToCurrentUser, todayIso],
  );
  // Without the select there is no way back from a filter, so none applies.
  const activeFilter: MyTasksFilter = showFilter ? filter : "all";
  const visible = useMemo(() => filterMyTasks(myTasks, activeFilter, todayIso), [myTasks, activeFilter, todayIso]);
  const overdueCount = useMemo(
    () => myTasks.filter((task) => isTaskOverdue(task, todayIso)).length,
    [myTasks, todayIso],
  );

  const de = language === "de";
  const shown = visible.slice(0, Math.max(0, rowLimit));
  const hiddenCount = visible.length - shown.length;

  function goToMyTasks() {
    if (onOpenList) {
      onOpenList();
      return;
    }
    setProjectBackView(null);
    setOverviewShortcutBackVisible(true);
    setMainView("my_tasks");
  }

  function openRow(task: Task) {
    const action = myTasksRowAction(task, canManageTasks);
    if (action === "edit") {
      openTaskEditModal(task);
      return;
    }
    if (action === "expand") setExpandedMyTaskId(task.id);
    goToMyTasks();
  }

  function rowLabel(task: Task, action: MyTasksRowAction): string {
    if (action === "edit") return de ? `Aufgabe bearbeiten: ${task.title}` : `Edit task: ${task.title}`;
    if (action === "expand") return de ? `Aufgabe öffnen: ${task.title}` : `Open task: ${task.title}`;
    return de ? `Meine Aufgaben öffnen (erledigt: ${task.title})` : `Open My tasks (done: ${task.title})`;
  }

  const overdueChip =
    overdueCount > 0 ? (
      <span className="my-tasks-card-count">
        {overdueCount} {de ? "überfällig" : "overdue"}
      </span>
    ) : null;

  const filterSelect = showFilter ? (
    <label className="overview-state-filter">
      <span>{de ? "Status:" : "Status:"}</span>
      <select
        value={filter}
        onChange={(event) => setFilter(event.target.value as MyTasksFilter)}
        aria-label={de ? "Aufgaben nach Status filtern" : "Filter tasks by status"}
      >
        {MY_TASKS_FILTER_OPTIONS.map((value) => (
          <option key={value} value={value}>
            {value === "all" ? (de ? "Alle" : "All") : taskStatusLabel(value, language)}
          </option>
        ))}
      </select>
    </label>
  ) : null;

  const listAndFold = (
    <>
      <ul className="tasks-page-list">
        {shown.map((task) => {
          const isOverdue = isTaskOverdue(task, todayIso);
          const displayStatus = taskDisplayStatus(task, todayIso);
          const action = myTasksRowAction(task, canManageTasks);
          const rowClass = [
            "tasks-page-row",
            isOverdue ? "tasks-page-row--overdue" : "",
            displayStatus === "in_progress" && !isOverdue ? "tasks-page-row--in-progress" : "",
            isTaskDoneStatus(task.status) ? "tasks-page-row--done" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={`my-tasks-card-${task.id}`} className={rowClass}>
              <button
                type="button"
                className={
                  action === "list"
                    ? "tasks-page-row-header my-tasks-card-row-header--list-only"
                    : "tasks-page-row-header"
                }
                onClick={() => openRow(task)}
                aria-label={rowLabel(task, action)}
                title={
                  action === "list"
                    ? de
                      ? "Erledigte Aufgaben werden in Meine Aufgaben nicht aufgeklappt"
                      : "Done tasks are not expanded on My tasks"
                    : undefined
                }
              >
                <TaskRowSummary
                  task={task}
                  language={language}
                  todayIso={todayIso}
                  projectLabel={taskProjectTitleParts(task)}
                  customerLabel={taskCustomerLabel(task)}
                />
              </button>
            </li>
          );
        })}
      </ul>
      {myTasks.length === 0 ? (
        <div className="overview-empty-state">{de ? "Keine Aufgaben." : "No tasks."}</div>
      ) : visible.length === 0 ? (
        <div className="overview-empty-state">
          {de ? "Keine Aufgaben in diesem Status." : "No tasks in this status."}
        </div>
      ) : null}
      {hiddenCount > 0 ? (
        <button type="button" className="my-tasks-card-more" onClick={goToMyTasks}>
          +{hiddenCount} {de ? "weitere" : "more"}
        </button>
      ) : null}
    </>
  );

  if (embedded) {
    // The host frame carries the title and „Alle anzeigen“; the overdue count
    // and the filter stay, in a bar above the rows, when there is either.
    return (
      <div className="my-tasks-card my-tasks-card--embedded">
        {overdueChip || filterSelect ? (
          <div className="my-tasks-card-bar">
            {overdueChip}
            {filterSelect}
          </div>
        ) : null}
        {listAndFold}
      </div>
    );
  }

  return (
    <article className="overview-card overview-projects-card my-tasks-card">
      <div className="overview-projects-head">
        <span className="my-tasks-card-head-title">
          <h3>{de ? "Meine Aufgaben" : "My tasks"}</h3>
          {overdueChip}
        </span>
        <div className="overview-projects-controls">
          {filterSelect}
          <button type="button" className="overview-open-full-btn" onClick={goToMyTasks}>
            <span aria-hidden="true">≡</span>
            <span>{de ? "Alle anzeigen" : "Show all"}</span>
          </button>
        </div>
      </div>
      {listAndFold}
    </article>
  );
}
