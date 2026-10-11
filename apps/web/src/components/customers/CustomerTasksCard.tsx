/**
 * CustomerTasksCard — the customer's open tasks, on the customer page.
 *
 * Tasks are created here exactly the way they are everywhere else: "+
 * Aufgabe" opens the full task modal (the weekly planning's), with this
 * customer already set as the task's anchor — type, dates, crew, partners,
 * crate and files are all there, and the modal still lets the operator pick
 * one of the customer's projects instead. There used to be a title-only
 * quick-add here that skipped all of that; it is gone on purpose.
 *
 * A row opens the task in the edit modal; the checkbox completes it. The list
 * re-reads whenever a task changes anywhere (`taskRevision` — the modals and
 * the event stream move it), so a task saved in the modal shows up here
 * without a reload.
 */
import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { TerminBadge } from "../tasks/TerminBadge";
import { TaskAttachmentBadge } from "../tasks/TaskAttachmentBadge";
import { formatTaskDateRange } from "../../utils/tasks";
import type { Task } from "../../types";


type Props = {
  customerId: number;
};


export function CustomerTasksCard({ customerId }: Props) {
  const { token, language, setError, openTaskModal, openTaskEditModal, taskRevision } = useAppContext();
  const de = language === "de";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // view=all_open gates on status != "done" server-side.
      setTasks(await apiFetch<Task[]>(`/tasks?view=all_open&customer_id=${customerId}`, token));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [customerId, token, setError]);

  useEffect(() => {
    void load();
  }, [load, taskRevision]);

  async function toggleDone(task: Task) {
    const nextStatus = task.status === "done" ? "open" : "done";
    try {
      const updated = await apiFetch<Task>(`/tasks/${task.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      // A closed task leaves view=all_open; drop it now rather than on the next read.
      if (nextStatus === "done") {
        setTasks((current) => current.filter((t) => t.id !== task.id));
      } else {
        setTasks((current) => current.map((t) => (t.id === task.id ? updated : t)));
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="customer-tasks-card">
      <header className="customer-contact-card-head">
        <h3 className="customer-contact-card-title">
          {de ? "Kundenaufgaben" : "Customer tasks"}{" "}
          <span className="customer-projects-count muted">({tasks.length})</span>
        </h3>
        <button
          type="button"
          className="customers-action-btn customers-action-btn--primary"
          onClick={() => openTaskModal({ customerId })}
        >
          {de ? "+ Aufgabe" : "+ Task"}
        </button>
      </header>

      {loading && tasks.length === 0 ? (
        <small className="muted">{de ? "Lade…" : "Loading…"}</small>
      ) : tasks.length === 0 ? (
        <div className="customers-empty muted">
          {de ? "Keine offenen Kundenaufgaben." : "No open customer tasks."}
        </div>
      ) : (
        <ul className="customer-tasks-list">
          {tasks.map((task) => (
            <li key={`customer-task-${task.id}`} className="customer-task-row">
              <input
                type="checkbox"
                className="customer-task-check"
                checked={task.status === "done"}
                onChange={() => void toggleDone(task)}
                aria-label={de ? "Erledigt" : "Done"}
              />
              <button type="button" className="customer-task-open" onClick={() => openTaskEditModal(task)}>
                <span className="customer-task-title">{task.title}</span>
                <TerminBadge task={task} language={language} />
                <TaskAttachmentBadge task={task} language={language} />
                {task.due_date && <small className="muted">{formatTaskDateRange(task)}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
