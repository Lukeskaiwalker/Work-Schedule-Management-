/**
 * PublicCustomerConfirmationPage — v2.5.0 unauthenticated customer
 * landing for an email confirmation link.
 *
 * URL: /confirm/<token>
 *
 * The page fetches the task summary from the public api endpoint (no
 * JWT required — the random 32-hex token gates access), renders the
 * appointment details, and offers Confirm / Decline buttons. After a
 * click, the page transitions to a thank-you state.
 *
 * Edge cases handled:
 *   - Unknown token (404)   → "Link nicht gefunden / not found"
 *   - Expired (today >= due_date) → friendly "please call" message
 *   - Already confirmed / declined → static "thank you" state
 *
 * Stays language-aware via the `language` field the api returns on
 * the GET response (sourced from the customer's `language` setting).
 */
import { useEffect, useState } from "react";

import { apiFetch } from "../api/client";
import { readCustomerConfirmationToken } from "../utils/auth";


type PublicView = {
  customer_name: string | null;
  task_title: string;
  task_description: string | null;
  due_date: string | null;
  start_time: string | null;
  estimated_hours: number | null;
  worker_display_names: string[];
  language: "de" | "en";
  confirmation_status: string | null;
  confirmation_at: string | null;
  expired: boolean;
};


type PageState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "ready"; view: PublicView }
  | { kind: "submitting"; view: PublicView }
  | { kind: "error"; view: PublicView | null; message: string };


function localize(view: PublicView | null, de: string, en: string): string {
  if (view?.language === "en") return en;
  return de;
}


function formatDate(iso: string | null, language: "de" | "en"): string {
  if (!iso) return "—";
  const date = new Date(iso + "T00:00:00");
  if (Number.isNaN(date.getTime())) return iso;
  if (language === "en") {
    return date.toLocaleDateString("en-GB", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
  return date.toLocaleDateString("de-DE", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}


function formatTime(time: string | null): string {
  if (!time) return "";
  // Server sends HH:MM:SS; show HH:MM for the customer.
  return time.slice(0, 5);
}


function formatHours(value: number | null, language: "de" | "en"): string {
  if (value == null || value <= 0) return "";
  const label = language === "de" ? "Stunden" : "hours";
  if (Number.isInteger(value)) return `${value} ${label}`;
  return `${value.toFixed(1)} ${label}`;
}


export function PublicCustomerConfirmationPage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });

  useEffect(() => {
    const token = readCustomerConfirmationToken();
    if (!token) {
      setState({ kind: "not_found" });
      return;
    }
    apiFetch<PublicView>(`/public/customer-confirmations/${token}`, null)
      .then((view) => setState({ kind: "ready", view }))
      .catch((err: unknown) => {
        // 404 from the api → token unknown. Everything else is shown
        // as a generic error so the customer still has a place to
        // land instead of a blank screen.
        if (err instanceof Error && /404/.test(err.message)) {
          setState({ kind: "not_found" });
          return;
        }
        setState({
          kind: "error",
          view: null,
          message:
            err instanceof Error
              ? err.message
              : "Unbekannter Fehler / unknown error",
        });
      });
  }, []);

  async function submit(action: "confirm" | "decline") {
    if (state.kind !== "ready") return;
    const view = state.view;
    setState({ kind: "submitting", view });
    const token = readCustomerConfirmationToken();
    try {
      const next = await apiFetch<PublicView>(
        `/public/customer-confirmations/${token}`,
        null,
        { method: "POST", body: JSON.stringify({ action }) },
      );
      setState({ kind: "ready", view: next });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : localize(view, "Fehler", "Error");
      setState({ kind: "error", view, message });
    }
  }

  const container: React.CSSProperties = {
    maxWidth: 560,
    margin: "60px auto",
    padding: 24,
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    color: "#0f172a",
  };
  const card: React.CSSProperties = {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 12,
    padding: 24,
    boxShadow: "0 4px 12px -4px rgba(15, 23, 42, 0.08)",
  };

  if (state.kind === "loading") {
    return (
      <div style={container}>
        <div style={card}>
          <p>Lade… / Loading…</p>
        </div>
      </div>
    );
  }

  if (state.kind === "not_found") {
    return (
      <div style={container}>
        <div style={card}>
          <h1 style={{ marginTop: 0 }}>Link nicht gefunden</h1>
          <p>
            Dieser Bestätigungs-Link ist ungültig oder wurde bereits ausgetauscht.
            Bitte kontaktieren Sie uns telefonisch.
          </p>
          <hr style={{ margin: "16px 0", border: 0, borderTop: "1px solid #e2e8f0" }} />
          <p>This confirmation link is invalid or has been replaced. Please contact us by phone.</p>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div style={container}>
        <div style={card}>
          <h1 style={{ marginTop: 0 }}>
            {localize(state.view, "Fehler", "Error")}
          </h1>
          <p>{state.message}</p>
        </div>
      </div>
    );
  }

  const view = state.view;
  const de = view.language === "de";
  const submitting = state.kind === "submitting";
  const alreadyActed =
    view.confirmation_status === "confirmed" || view.confirmation_status === "declined";

  return (
    <div style={container}>
      <div style={card}>
        <h1 style={{ marginTop: 0 }}>
          {de ? "Terminbestätigung" : "Appointment confirmation"}
        </h1>
        {view.customer_name && (
          <p style={{ marginTop: -8, color: "#64748b" }}>
            {de ? "Hallo " : "Hello "}
            {view.customer_name},
          </p>
        )}

        <div style={{ marginTop: 16, padding: 12, background: "#f8fafc", borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: "#64748b" }}>
            {de ? "TERMIN" : "APPOINTMENT"}
          </div>
          <div style={{ marginTop: 4, fontSize: 18, fontWeight: 600 }}>
            {formatDate(view.due_date, view.language)}
            {view.start_time && ` · ${formatTime(view.start_time)}`}
          </div>
          <div style={{ marginTop: 8 }}>
            <b>{de ? "Geplante Arbeit: " : "Planned work: "}</b>
            {view.task_title}
          </div>
          {view.task_description && (
            <div style={{ marginTop: 4, fontSize: 14, color: "#475569" }}>
              {view.task_description}
            </div>
          )}
          {formatHours(view.estimated_hours, view.language) && (
            <div style={{ marginTop: 8 }}>
              <b>{de ? "Geschätzte Dauer: " : "Estimated duration: "}</b>
              {formatHours(view.estimated_hours, view.language)}
            </div>
          )}
          {view.worker_display_names.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <b>{de ? "Unsere Monteure: " : "Our team: "}</b>
              {view.worker_display_names.join(", ")}
            </div>
          )}
        </div>

        {alreadyActed ? (
          <div
            style={{
              marginTop: 20,
              padding: 14,
              borderRadius: 8,
              background:
                view.confirmation_status === "confirmed" ? "#dcfce7" : "#fee2e2",
              border:
                view.confirmation_status === "confirmed"
                  ? "1px solid #86efac"
                  : "1px solid #fca5a5",
              color:
                view.confirmation_status === "confirmed" ? "#166534" : "#991b1b",
            }}
          >
            <b>
              {view.confirmation_status === "confirmed"
                ? de ? "Bestätigt ✓" : "Confirmed ✓"
                : de ? "Abgelehnt ✕" : "Declined ✕"}
            </b>
            <div style={{ marginTop: 4, fontSize: 13 }}>
              {de
                ? "Vielen Dank für Ihre Rückmeldung."
                : "Thank you for your response."}
            </div>
          </div>
        ) : view.expired ? (
          <div
            style={{
              marginTop: 20,
              padding: 14,
              borderRadius: 8,
              background: "#fef9c3",
              border: "1px solid #fde047",
              color: "#854d0e",
            }}
          >
            <b>{de ? "Link abgelaufen" : "Link expired"}</b>
            <div style={{ marginTop: 4, fontSize: 13 }}>
              {de
                ? "Bitte rufen Sie uns an, um den Termin zu bestätigen oder zu verschieben."
                : "Please call us to confirm or reschedule the appointment."}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void submit("confirm")}
              style={{
                flex: "1 1 auto",
                padding: "12px 20px",
                fontSize: 16,
                fontWeight: 600,
                color: "#fff",
                background: "#16a34a",
                border: "none",
                borderRadius: 8,
                cursor: submitting ? "wait" : "pointer",
              }}
            >
              {submitting
                ? de ? "Sende…" : "Sending…"
                : de ? "Termin bestätigen" : "Confirm appointment"}
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => void submit("decline")}
              style={{
                flex: "0 0 auto",
                padding: "12px 20px",
                fontSize: 16,
                color: "#991b1b",
                background: "#fff",
                border: "1px solid #fca5a5",
                borderRadius: 8,
                cursor: submitting ? "wait" : "pointer",
              }}
            >
              {de ? "Ablehnen" : "Decline"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
