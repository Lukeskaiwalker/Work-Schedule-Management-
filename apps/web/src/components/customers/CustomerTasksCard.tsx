/**
 * CustomerTasksCard — customer-anchored task list (v2.4.5+).
 *
 * Sits on the right column of the CustomerDetailPage. Lets operators
 * create lightweight tasks tied to a customer instead of a project —
 * useful for call-back reminders, follow-up tasks, "quote needs to be
 * resent" todos, etc.
 *
 * The component is intentionally minimal: title-only quick-add form,
 * compact list with "mark done"/"mark open" toggle. Heavier-weight
 * editing (due-date, assignees, partners) goes through the existing
 * TaskEditModal opened from MyTasks or the planning grid — those
 * surfaces already accept customer-anchored tasks now that the schema
 * supports them.
 */
import { useEffect, useState, type FormEvent } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import type { Task } from "../../types";


type Props = {
  customerId: number;
};


export function CustomerTasksCard({ customerId }: Props) {
  const { token, language, setError, setNotice } = useAppContext();
  const de = language === "de";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [creating, setCreating] = useState(false);

  // (Re-)load whenever the customer id changes. Splitting load() out
  // of the effect lets the create-handler reuse it without a full
  // useEffect dependency dance.
  async function load() {
    setLoading(true);
    try {
      const rows = await apiFetch<Task[]>(
        `/tasks?view=all_open&customer_id=${customerId}`,
        token,
      );
      // Server returns a mix of completed + open under view=all_open
      // (it gates by status != "done"), but be defensive against
      // future backend changes.
      setTasks(rows);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, token]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    const title = draftTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      const created = await apiFetch<Task>("/tasks", token, {
        method: "POST",
        body: JSON.stringify({
          customer_id: customerId,
          title,
          // task_type=office matches the canonical "call/follow-up"
          // shape — operators can change it later via TaskEditModal.
          task_type: "office",
        }),
      });
      setTasks((current) => [created, ...current]);
      setDraftTitle("");
      setNotice(de ? "Aufgabe erstellt" : "Task created");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function toggleDone(task: Task) {
    const nextStatus = task.status === "done" ? "open" : "done";
    try {
      const updated = await apiFetch<Task>(`/tasks/${task.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      // Closed task drops out of view=all_open on the next fetch.
      // For now we replace optimistically and re-fetch on next mount.
      if (nextStatus === "done") {
        setTasks((current) => current.filter((t) => t.id !== task.id));
      } else {
        setTasks((current) =>
          current.map((t) => (t.id === task.id ? updated : t)),
        );
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
      </header>

      <form
        className="customer-tasks-form"
        onSubmit={handleCreate}
        style={{ display: "flex", gap: 8, marginBottom: 12 }}
      >
        <input
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder={
            de ? "Neue Aufgabe (z.B. 'Angebot nachfassen')" : "New task (e.g. 'Follow up on quote')"
          }
          style={{ flex: "1 1 auto" }}
          disabled={creating}
        />
        <button type="submit" disabled={creating || draftTitle.trim() === ""}>
          {creating ? (de ? "Erstelle…" : "Adding…") : (de ? "+ Aufgabe" : "+ Task")}
        </button>
      </form>

      {loading ? (
        <small className="muted">{de ? "Lade…" : "Loading…"}</small>
      ) : tasks.length === 0 ? (
        <div className="customers-empty muted">
          {de
            ? "Keine offenen Kundenaufgaben."
            : "No open customer tasks."}
        </div>
      ) : (
        <ul className="customer-tasks-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {tasks.map((task) => (
            <li
              key={`customer-task-${task.id}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <input
                type="checkbox"
                checked={task.status === "done"}
                onChange={() => void toggleDone(task)}
                aria-label={de ? "Erledigt" : "Done"}
              />
              <span style={{ flex: "1 1 auto" }}>
                {task.title}
                {task.due_date && (
                  <small className="muted" style={{ marginLeft: 8 }}>
                    {task.due_date}
                  </small>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
