import { useEffect, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import type { PartnerHoursEntry } from "../../types";
import { formatPartnerHours, partnerHoursTotal } from "../../utils/partnerHours";
import { deletePartnerHours, listTaskPartnerHours } from "../../utils/partnersApi";
import { PartnerHoursList } from "../partners/PartnerHoursList";

/**
 * "Partnerstunden" in the task modal: what the partners on this task reported
 * in their portal, every partner's rows with the company named. Nothing is
 * shown until there is something to show, so a task without partner hours
 * looks exactly as before.
 */
export function TaskPartnerHoursSection({ taskId }: { taskId: number }) {
  const { token, language, canCreateProject } = useAppContext();
  const de = language === "de";
  const [entries, setEntries] = useState<PartnerHoursEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setError(null);
    async function load() {
      try {
        const rows = await listTaskPartnerHours(token, taskId);
        if (!cancelled) setEntries(Array.isArray(rows) ? rows : []);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token, taskId]);

  async function remove(entry: PartnerHoursEntry) {
    const question = de
      ? `Stundenmeldung von ${entry.partner.name} entfernen? Das steht danach im Verlauf.`
      : `Remove the hours reported by ${entry.partner.name}? The change is kept in the history.`;
    if (!window.confirm(question)) return;
    setBusyId(entry.id);
    try {
      await deletePartnerHours(token, entry.id);
      setEntries((current) => current.filter((row) => row.id !== entry.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  if (entries.length === 0 && !error) return null;

  return (
    <section className="task-modal-section task-modal-section--stack" aria-label={de ? "Partnerstunden" : "Partner hours"}>
      <div className="task-modal-section-head">
        <span className="task-modal-section-label">{de ? "PARTNERSTUNDEN" : "PARTNER HOURS"}</span>
        {entries.length > 0 && (
          <span className="task-modal-section-hint">
            {de ? `${formatPartnerHours(partnerHoursTotal(entries))} gemeldet` : `${formatPartnerHours(partnerHoursTotal(entries))} reported`}
          </span>
        )}
      </div>
      {entries.length > 0 && (
        <PartnerHoursList
          entries={entries}
          showPartner
          showTask={false}
          busyId={busyId}
          onDelete={canCreateProject ? (entry) => void remove(entry) : undefined}
        />
      )}
      {error && <small className="partner-portal-access-error" role="alert">{error}</small>}
    </section>
  );
}
