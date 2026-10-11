import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import type { PartnerHoursEntry } from "../../types";
import { formatPartnerHours, partnerHoursTotal } from "../../utils/partnerHours";
import { deletePartnerHours, listProjectPartnerHours } from "../../utils/partnersApi";
import { PartnerHoursList } from "../partners/PartnerHoursList";
import "../../styles/partner-portal-office.css";

/**
 * "Partnerstunden" on the project's hours tab: what the subcontractors'
 * crews reported in the partner portal, totalled per company. Kept apart
 * from the plan above on purpose — the planned hours budget is our own
 * labour; a roofer's hours are checked against the roofer's invoice.
 * Hidden until a partner has reported something.
 */
export function ProjectPartnerHoursCard({ projectId }: { projectId: number }) {
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
        const rows = await listProjectPartnerHours(token, projectId);
        if (!cancelled) setEntries(Array.isArray(rows) ? rows : []);
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token, projectId]);

  const byPartner = useMemo(() => {
    const totals = new Map<number, { name: string; total: number }>();
    for (const entry of entries) {
      const current = totals.get(entry.partner.id) ?? { name: entry.partner.name, total: 0 };
      totals.set(entry.partner.id, { name: current.name, total: current.total + entry.total_hours });
    }
    return Array.from(totals.entries()).map(([id, value]) => ({ id, ...value }));
  }, [entries]);

  async function remove(entry: PartnerHoursEntry) {
    const question = de
      ? `Stundenmeldung von ${entry.partner.name} entfernen? Das steht danach im Verlauf des Projekts.`
      : `Remove the hours reported by ${entry.partner.name}? The change is kept in the project history.`;
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
    <section className="project-hours-partner-card" aria-label={de ? "Partnerstunden" : "Partner hours"}>
      <div className="project-hours-partner-head">
        <div>
          <h3 className="project-hours-card-subtitle">{de ? "Partnerstunden" : "Partner hours"}</h3>
          <p className="project-hours-partner-hint">
            {de
              ? "Von Nachunternehmern im Partnerportal gemeldet. Zählen nicht zum Planverbrauch oben."
              : "Reported by subcontractors in the partner portal. Not counted in the plan usage above."}
          </p>
        </div>
        <strong className="project-hours-partner-total">{formatPartnerHours(partnerHoursTotal(entries))}</strong>
      </div>
      {byPartner.length > 0 && (
        <ul className="project-hours-partner-totals">
          {byPartner.map((row) => (
            <li key={row.id}>
              <span>{row.name}</span>
              <strong>{formatPartnerHours(row.total)}</strong>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 0 && (
        <PartnerHoursList
          entries={entries}
          showPartner
          showTask
          busyId={busyId}
          onDelete={canCreateProject ? (entry) => void remove(entry) : undefined}
        />
      )}
      {error && <small className="partner-portal-access-error" role="alert">{error}</small>}
    </section>
  );
}
