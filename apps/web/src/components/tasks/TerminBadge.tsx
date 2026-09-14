/**
 * TerminBadge — the one pill on a task row that answers "is this date settled?".
 *
 * Replaces the pair that used to sit side by side: PlanningStatusBadge (our own
 * planning certainty) and CustomerConfirmationDot (the customer's answer). Both
 * could read "bestätigt" at the same time on the same row, which is exactly the
 * confusion this component exists to remove — see utils/terminBadge.ts for the
 * contract and for why the two underlying columns stay separate.
 *
 * Renders nothing only when there is genuinely nothing to say: no planning
 * status and no customer confirmation flow at all. A flow that is still waiting
 * DOES get a pill — "Kunde fragen" / "Kunde antwortet noch" / "Link abgelaufen"
 * — because the state a reschedule leaves behind is a state somebody has to
 * clear.
 *
 * The tooltip carries the plain-language explanation from the resolver, plus
 * provenance — and WHICH provenance depends on the status, because the two
 * cases are evidence about different things:
 *
 *   confirmed / declined  the full record of the answer on screen: when it was
 *                         taken, by which method, by whom, and the phone note.
 *                         That note is the only proof of what was agreed, so
 *                         here it is reachable on hover without opening the
 *                         task.
 *
 *   pending               the send timestamp only. The note is deliberately
 *                         WITHHELD: it survives a reset (destroying it on a
 *                         routine reschedule was a bug), so next to "pending"
 *                         it describes a round that has ended, and a tooltip
 *                         line of this kind cannot carry the "vorherige Runde"
 *                         qualifier the task modal puts in front of it. Shown
 *                         bare it would read as what the customer just agreed
 *                         to. The modal is where that note stays readable.
 */
import type { Language, Task } from "../../types";
import { resolveTerminBadge } from "../../utils/terminBadge";

/**
 * Structural slice of Task — a full Task satisfies it, and a test can build one
 * from a handful of fields. Every field is optional on Task itself (cached task
 * objects predate them), so the Pick stays optional too.
 */
export type TerminBadgeTask = Pick<
  Task,
  | "planning_status"
  | "customer_confirmation_status"
  | "customer_confirmation_at"
  | "customer_confirmation_method"
  | "customer_confirmation_by_display_name"
  | "customer_confirmation_notes"
  | "customer_confirmation_email_sent_at"
  | "customer_confirmation_token_expired"
>;

type Props = {
  task: TerminBadgeTask;
  language: Language;
};

function confirmationMethodLabel(method: string, de: boolean): string {
  if (method === "email") return de ? "per E-Mail-Link" : "via email link";
  if (method === "phone") return de ? "per Telefon" : "via phone";
  return de ? "manuell" : "manually";
}

function shortTimestamp(value: string): string {
  return value.slice(0, 16).replace("T", " ");
}

/**
 * Extra tooltip lines describing HOW the customer's answer was recorded — or,
 * while the flow is still open, when we last asked. An answered flow shows the
 * full provenance (the phone note included, it being the only proof of what was
 * agreed); a pending one shows just the send timestamp, which is per-round —
 * the server clears it whenever it mints a new token — so it always describes
 * the round on screen. "zuletzt" covers a resend within that round.
 */
function customerProvenanceLines(task: TerminBadgeTask, de: boolean): string[] {
  const status = task.customer_confirmation_status;
  if (status === "pending") {
    if (!task.customer_confirmation_email_sent_at) return [];
    return [
      (de ? "E-Mail zuletzt gesendet: " : "Email last sent: ") +
        shortTimestamp(task.customer_confirmation_email_sent_at),
    ];
  }
  if (status !== "confirmed" && status !== "declined") return [];
  const lines: string[] = [];
  if (task.customer_confirmation_at) {
    lines.push((de ? "Am: " : "On: ") + shortTimestamp(task.customer_confirmation_at));
  }
  if (task.customer_confirmation_method) {
    lines.push(
      (de ? "Methode: " : "Method: ") +
        confirmationMethodLabel(task.customer_confirmation_method, de),
    );
  }
  if (task.customer_confirmation_by_display_name) {
    lines.push(
      (de ? "Erfasst durch: " : "Recorded by: ") + task.customer_confirmation_by_display_name,
    );
  }
  if (task.customer_confirmation_notes) {
    lines.push(`"${task.customer_confirmation_notes}"`);
  }
  return lines;
}

export function TerminBadge({ task, language }: Props) {
  const badge = resolveTerminBadge(task, language);
  if (!badge) return null;

  const de = language === "de";
  const title = [badge.title, ...customerProvenanceLines(task, de)].join("\n");

  return (
    <span
      className={`tasks-page-row-badge tasks-page-row-badge--termin tasks-page-row-badge--termin-${badge.tone}`}
      title={title}
      data-tone={badge.tone}
    >
      {badge.text}
    </span>
  );
}
