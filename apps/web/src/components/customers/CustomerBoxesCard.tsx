/**
 * CustomerBoxesCard — construction boxes currently with this customer.
 *
 * Mirrors CustomerReportsCard's data-loading shape, including the deliberate
 * 403-swallow: not having Werkstatt access is a normal state on a customer page,
 * not an error worth a red banner.
 *
 * Shows currently-assigned boxes by default; "Verlauf anzeigen" re-fetches with
 * include_returned=true so returned boxes remain findable as history.
 */
import { useEffect, useState } from "react";

import { apiFetch, ApiError } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { formatServerDateTime } from "../../utils/dates";

type CustomerBox = {
  id: number;
  box_number: string;
  label: string;
  status: string;
  item_count: number;
  assigned_at: string | null;
  returned_at: string | null;
  project_name: string | null;
};

const STATUS_LABELS: Record<string, { de: string; en: string }> = {
  offen: { de: "Offen", en: "Open" },
  gepackt: { de: "Gepackt", en: "Packed" },
  zugewiesen: { de: "Beim Kunden", en: "With customer" },
  zurueck: { de: "Zurück", en: "Returned" },
};

type Props = {
  customerId: number;
};

export function CustomerBoxesCard({ customerId }: Props) {
  const { token, language, setError, setMainView, setWerkstattTab } = useAppContext();
  const de = language === "de";

  const [boxes, setBoxes] = useState<CustomerBox[]>([]);
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const rows = await apiFetch<CustomerBox[]>(
          `/customers/${customerId}/boxes${showHistory ? "?include_returned=true" : ""}`,
          token,
        );
        if (!cancelled) setBoxes(rows);
      } catch (err: unknown) {
        if (cancelled) return;
        setBoxes([]);
        if (err instanceof ApiError && err.status === 403) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [customerId, token, showHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <article className="card customer-boxes-card">
      <div className="overview-card-head">
        <h3>{de ? "Baustellenkisten" : "Construction boxes"}</h3>
        {boxes.length > 0 && <span className="muted">{boxes.length}</span>}
      </div>

      {loading && boxes.length === 0 ? (
        <div className="overview-empty-state">{de ? "Wird geladen…" : "Loading…"}</div>
      ) : boxes.length === 0 ? (
        <div className="overview-empty-state">
          {showHistory
            ? de
              ? "Keine Kisten für diesen Kunden."
              : "No boxes for this customer."
            : de
              ? "Aktuell keine Kiste zugewiesen."
              : "No box currently assigned."}
        </div>
      ) : (
        <div className="overview-report-list">
          {boxes.map((box) => (
            <div key={`customer-box-${box.id}`} className="overview-report-item">
              <div className="overview-report-title">
                {box.label} <span className="muted">{box.box_number}</span>
              </div>
              <div className="overview-report-meta">
                {de ? "Status" : "Status"}:{" "}
                {de
                  ? STATUS_LABELS[box.status]?.de ?? box.status
                  : STATUS_LABELS[box.status]?.en ?? box.status}
                {" · "}
                {box.item_count}{" "}
                {de
                  ? box.item_count === 1
                    ? "Position"
                    : "Positionen"
                  : box.item_count === 1
                    ? "item"
                    : "items"}
              </div>
              {box.project_name && (
                <div className="overview-report-meta">
                  {de ? "Projekt" : "Project"}: {box.project_name}
                </div>
              )}
              {box.assigned_at && (
                <div className="overview-report-meta">
                  {de ? "Übergeben" : "Handed over"}:{" "}
                  {formatServerDateTime(box.assigned_at, language)}
                </div>
              )}
              <div className="overview-report-links">
                <button
                  type="button"
                  onClick={() => {
                    setWerkstattTab("kisten");
                    setMainView("werkstatt");
                  }}
                >
                  {de ? "In der Werkstatt öffnen" : "Open in workshop"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button type="button" className="linklike" onClick={() => setShowHistory((v) => !v)}>
        {showHistory
          ? de
            ? "Nur aktuelle anzeigen"
            : "Show current only"
          : de
            ? "Verlauf anzeigen"
            : "Show history"}
      </button>
    </article>
  );
}
