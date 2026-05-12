/**
 * CustomerConfirmationDot — v2.5.0 visual indicator for the task's
 * customer-confirmation state.
 *
 * Renders nothing when the task has no confirmation requested (status
 * is null/undefined). Otherwise renders a small colored dot with a
 * native-browser tooltip describing the full status (date, method, who
 * confirmed) so an operator can see the detail without opening the
 * task modal.
 *
 * Colors match the design discussion:
 *   pending   → amber, blinking (re-uses the same .sse-pulse animation
 *               so we don't introduce a second keyframe)
 *   confirmed → green
 *   declined  → red
 */
import type { Language, Task } from "../../types";


type Props = {
  task: Task;
  language: Language;
};


export function CustomerConfirmationDot({ task, language }: Props) {
  const status = task.customer_confirmation_status;
  if (!status) return null;

  const de = language === "de";
  const palette =
    status === "confirmed"
      ? { bg: "#22c55e", label: de ? "Bestätigt" : "Confirmed" }
      : status === "declined"
        ? { bg: "#dc2626", label: de ? "Abgelehnt" : "Declined" }
        : { bg: "#f59e0b", label: de ? "Wartet auf Bestätigung" : "Awaiting confirmation" };

  // Build a rich tooltip with method + actor + timestamp so hovering
  // is enough to answer "did the customer confirm?" without opening
  // the task. Tooltips are render-cheap (just a title attribute).
  const tooltipLines: string[] = [palette.label];
  if (status === "confirmed" || status === "declined") {
    if (task.customer_confirmation_at) {
      const stamp = task.customer_confirmation_at.slice(0, 16).replace("T", " ");
      tooltipLines.push((de ? "Am: " : "On: ") + stamp);
    }
    const method = task.customer_confirmation_method;
    if (method) {
      const methodLabel =
        method === "email"
          ? de ? "per E-Mail-Link" : "via email link"
          : method === "phone"
            ? de ? "per Telefon" : "via phone"
            : de ? "manuell" : "manually";
      tooltipLines.push((de ? "Methode: " : "Method: ") + methodLabel);
    }
    if (task.customer_confirmation_by_display_name) {
      tooltipLines.push(
        (de ? "Erfasst durch: " : "Recorded by: ") +
          task.customer_confirmation_by_display_name,
      );
    }
    if (task.customer_confirmation_notes) {
      tooltipLines.push(`"${task.customer_confirmation_notes}"`);
    }
  } else if (status === "pending") {
    if (task.customer_confirmation_email_sent_at) {
      const stamp = task.customer_confirmation_email_sent_at.slice(0, 16).replace("T", " ");
      tooltipLines.push((de ? "E-Mail gesendet: " : "Email sent: ") + stamp);
    }
    if (task.customer_confirmation_token_expired) {
      tooltipLines.push(
        de
          ? "Link abgelaufen — bitte Kunden anrufen."
          : "Link expired — please call the customer.",
      );
    }
  }

  return (
    <span
      className={
        status === "pending"
          ? "customer-confirmation-dot customer-confirmation-dot--pending"
          : "customer-confirmation-dot"
      }
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: palette.bg,
        marginLeft: 6,
        verticalAlign: "middle",
        flexShrink: 0,
      }}
      title={tooltipLines.join("\n")}
      aria-label={palette.label}
    />
  );
}
