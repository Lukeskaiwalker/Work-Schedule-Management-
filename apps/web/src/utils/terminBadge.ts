/**
 * Termin badge resolver — the single pill a task row shows for "is this date
 * settled, and who says so?".
 *
 * TWO INDEPENDENT COLUMNS, ONE PILL. Nothing here merges the data; the two
 * database columns stay exactly as they are and keep their different
 * behaviour. Only the *display* is merged:
 *
 *   planning_status              OUR planner's answer — "tentative" (pencilled
 *                                in) or "confirmed" (fixed), or null when the
 *                                planner has not said anything. Manager-set.
 *                                Moving the due date does NOT reset it: our own
 *                                decision to fix a date survives rescheduling.
 *
 *   customer_confirmation_status The EXTERNAL customer's answer — "pending",
 *                                "confirmed", "declined", or null. Moving the
 *                                due date DOES reset it to "pending", because a
 *                                yes to last Tuesday is not a yes to next
 *                                Tuesday — and that reset now fires for a
 *                                "declined" round too.
 *
 * Before this resolver the row carried two separate marks — a green pill
 * reading "bestätigt" and a coloured dot whose tooltip also read "bestätigt" —
 * and the office could not tell which "bestätigt" it was looking at. The rule
 * that fixes that is: the word "bestätigt" appears at most once per row.
 *
 * The " · Kunde…" half is PROVENANCE, not a second axis. It answers "who
 * vouched for this date?" on top of what our own planning says — it is a suffix
 * on the planning word, never a badge competing with it. That is why
 * planning=confirmed + customer=confirmed reads "bestätigt · Kunde" (the
 * customer merely corroborates a date we had already fixed) while planning=null
 * + customer=confirmed reads "Kunde zugesagt" (the customer is the only reason
 * anyone believes in this date).
 *
 * PENDING IS VISIBLE, AND IT SPLITS INTO THREE. An earlier version of this file
 * rendered nothing for "pending" on the grounds that production had never
 * produced one. That stopped being true the moment the due-date reset widened:
 * a planner dragging a job from Tuesday to Thursday turns the customer's
 * "confirmed" into "pending", and a silently disappearing green pill is worse
 * than the amber dot it replaced. But "pending" in THIS product does not mean
 * "we asked and are waiting" — no confirmation email has ever actually been
 * sent — so the label has to say which of the two it is, and who owes the next
 * move:
 *
 *   no email ever sent  → "Kunde fragen"           we owe the customer a call
 *   email went out      → "Kunde antwortet noch"   the customer owes us a reply
 *   link expired        → "Link abgelaufen"        the link is dead; the tooltip
 *                                                  says to phone them, because
 *                                                  three lines of wrapped pill in
 *                                                  a 164px column say it worse
 *
 * Note the precedence in customerKey(): "was an email sent?" is asked BEFORE
 * "has the link expired?". The expiry flag is a pure due-date comparison on the
 * server (today >= due_date) and is therefore true for every overdue pending
 * task, email or no email; asking it first would advertise an expired link to a
 * customer who was never sent one.
 *
 * WHY THE SEND TIMESTAMP CAN BE TRUSTED HERE: customer_confirmation_email_sent_at
 * is PER-ROUND. A reset mints a new token, which kills the link the old
 * timestamp described, so the server clears the timestamp with it; the only
 * exception is a send that provably never reached the wire, which the server
 * rolls back wholesale — timestamp included. A non-null value therefore always
 * means "a link for THIS round went out and may still be live", which is
 * exactly what "Kunde antwortet noch" claims. (An earlier version of the column
 * survived resets, so a rescheduled task wrongly read as "Kunde antwortet noch"
 * about a date nobody had been asked about. The pill has no room for the
 * "vorherige Runde" qualifier the modal used to paper over that with, which is
 * why the column had to become per-round rather than the label hedged.)
 *
 * Pure function, no React, no i18n framework — so the contract below can be
 * table-tested in both languages without rendering anything.
 */
import type { Language, PlanningStatus } from "../types";

export type TerminBadgeTone = "confirmed" | "tentative" | "declined";

export type TerminBadge = {
  /** The pill label, already in the requested language. */
  text: string;
  /** Drives the colour: confirmed = green, tentative = amber/dashed, declined = red. */
  tone: TerminBadgeTone;
  /**
   * Plain-language tooltip. Always says whether the statement is ours
   * ("intern") or the customer's, because that is the distinction the two old
   * badges failed to make.
   */
  title: string;
};

/**
 * The four task fields the pill is a function of. An object rather than four
 * positional arguments: two of them are a timestamp and a boolean that only
 * qualify the third, and a call site that swapped them would still type-check.
 * A full `Task` satisfies this shape as-is.
 */
export type TerminBadgeInput = {
  planning_status?: PlanningStatus | null;
  customer_confirmation_status?: string | null;
  /** ISO timestamp of the last successful send, or null if none ever went out. */
  customer_confirmation_email_sent_at?: string | null;
  /** Server-computed: today >= due_date, so an emailed link no longer works. */
  customer_confirmation_token_expired?: boolean | null;
};

/** What the planner said, with null/unknown collapsed onto "none". */
type PlanningKey = "confirmed" | "tentative" | "none";

/**
 * What the customer said. "pending" fans out into the three states above —
 * who owes the next move — and null/unknown collapse onto "none".
 */
type CustomerKey = "confirmed" | "declined" | "asking" | "waiting" | "expired" | "none";

type Entry = {
  tone: TerminBadgeTone;
  de: string;
  en: string;
  titleDe: string;
  titleEn: string;
};

/**
 * The contract, transcribed one row per combination so a reviewer can diff it
 * against the spec by eye. `null` means "render nothing at all" — not an empty
 * pill, which would still take up space on the title line.
 *
 * Tone follows the least-settled half: a customer "no" or a dead link paints
 * the whole pill red however fixed our own planning is, an unanswered customer
 * keeps it amber, and green needs both halves to agree.
 */
const BADGE_TABLE: Record<`${PlanningKey}:${CustomerKey}`, Entry | null> = {
  "confirmed:confirmed": {
    tone: "confirmed",
    de: "bestätigt · Kunde",
    en: "confirmed · by customer",
    titleDe: "Termin steht fest — vom Kunden zugesagt",
    titleEn: "Date is fixed — agreed by the customer",
  },
  "confirmed:declined": {
    tone: "declined",
    de: "bestätigt · Kunde abgesagt",
    en: "confirmed · customer declined",
    titleDe: "Termin steht fest (intern) — aber der Kunde hat abgesagt",
    titleEn: "Date is fixed (internal) — but the customer declined",
  },
  "confirmed:asking": {
    tone: "tentative",
    de: "bestätigt · Kunde fragen",
    en: "confirmed · ask the customer",
    titleDe: "Termin steht fest (intern) — der Kunde wurde noch nicht gefragt",
    titleEn: "Date is fixed (internal) — the customer has not been asked yet",
  },
  "confirmed:waiting": {
    tone: "tentative",
    de: "bestätigt · Kunde antwortet noch",
    en: "confirmed · awaiting customer reply",
    titleDe: "Termin steht fest (intern) — der Kunde hat noch nicht geantwortet",
    titleEn: "Date is fixed (internal) — the customer has not replied yet",
  },
  "confirmed:expired": {
    tone: "declined",
    de: "bestätigt · Link abgelaufen",
    en: "confirmed · link expired",
    titleDe:
      "Termin steht fest (intern) — der Bestätigungslink ist abgelaufen, bitte den Kunden anrufen",
    titleEn:
      "Date is fixed (internal) — the confirmation link has expired, please call the customer",
  },
  "confirmed:none": {
    tone: "confirmed",
    de: "bestätigt",
    en: "confirmed",
    titleDe: "Termin steht fest (intern)",
    titleEn: "Date is fixed (internal)",
  },
  "tentative:confirmed": {
    tone: "tentative",
    de: "in Planung · Kunde zugesagt",
    en: "tentative · customer agreed",
    titleDe: "Termin noch nicht fix (intern) — der Kunde hat aber schon zugesagt",
    titleEn: "Date not fixed yet (internal) — but the customer has already agreed",
  },
  "tentative:declined": {
    tone: "declined",
    de: "in Planung · Kunde abgesagt",
    en: "tentative · customer declined",
    titleDe: "Termin noch nicht fix — der Kunde hat abgesagt",
    titleEn: "Date not fixed yet — the customer declined",
  },
  "tentative:asking": {
    tone: "tentative",
    de: "in Planung · Kunde fragen",
    en: "tentative · ask the customer",
    titleDe: "Termin noch nicht fix (intern) — der Kunde wurde noch nicht gefragt",
    titleEn: "Date not fixed yet (internal) — the customer has not been asked yet",
  },
  "tentative:waiting": {
    tone: "tentative",
    de: "in Planung · Kunde antwortet noch",
    en: "tentative · awaiting customer reply",
    titleDe: "Termin noch nicht fix (intern) — der Kunde hat noch nicht geantwortet",
    titleEn: "Date not fixed yet (internal) — the customer has not replied yet",
  },
  "tentative:expired": {
    tone: "declined",
    de: "in Planung · Link abgelaufen",
    en: "tentative · link expired",
    titleDe:
      "Termin noch nicht fix (intern) — der Bestätigungslink ist abgelaufen, bitte den Kunden anrufen",
    titleEn:
      "Date not fixed yet (internal) — the confirmation link has expired, please call the customer",
  },
  "tentative:none": {
    tone: "tentative",
    de: "in Planung",
    en: "tentative",
    titleDe: "Termin noch nicht fix (intern)",
    titleEn: "Date not fixed yet (internal)",
  },
  "none:confirmed": {
    tone: "confirmed",
    de: "Kunde zugesagt",
    en: "customer agreed",
    titleDe: "Kunde hat zugesagt — intern ist noch kein Planungsstand gesetzt",
    titleEn: "The customer agreed — no internal planning status set yet",
  },
  "none:declined": {
    tone: "declined",
    de: "Kunde abgesagt",
    en: "customer declined",
    titleDe: "Kunde hat abgesagt",
    titleEn: "The customer declined",
  },
  "none:asking": {
    tone: "tentative",
    de: "Kunde fragen",
    en: "ask the customer",
    titleDe: "Der Kunde wurde noch nicht gefragt — es ging keine Bestätigungs-E-Mail raus",
    titleEn: "The customer has not been asked yet — no confirmation email has gone out",
  },
  "none:waiting": {
    tone: "tentative",
    de: "Kunde antwortet noch",
    en: "awaiting customer reply",
    titleDe: "Der Kunde wurde per E-Mail gefragt und hat noch nicht geantwortet",
    titleEn: "The customer was asked by email and has not replied yet",
  },
  "none:expired": {
    tone: "declined",
    de: "Link abgelaufen",
    en: "link expired",
    titleDe: "Der Bestätigungslink ist abgelaufen — bitte den Kunden anrufen",
    titleEn: "The confirmation link has expired — please call the customer",
  },
  "none:none": null,
};

function planningKey(value: PlanningStatus | null | undefined): PlanningKey {
  return value === "confirmed" || value === "tentative" ? value : "none";
}

/**
 * The column is a free `string | null` on the wire, so an unknown value from a
 * future backend must not crash the row — anything we do not recognise
 * collapses onto "none". "pending" fans out into the three who-owes-the-next-
 * move states; see the header for why the email question comes before the
 * expiry question.
 */
function customerKey(input: TerminBadgeInput): CustomerKey {
  const status = input.customer_confirmation_status;
  if (status === "confirmed" || status === "declined") return status;
  if (status !== "pending") return "none";
  if (!input.customer_confirmation_email_sent_at) return "asking";
  return input.customer_confirmation_token_expired ? "expired" : "waiting";
}

export function resolveTerminBadge(
  input: TerminBadgeInput,
  language: Language,
): TerminBadge | null {
  const entry = BADGE_TABLE[`${planningKey(input.planning_status)}:${customerKey(input)}`];
  if (!entry) return null;
  const de = language === "de";
  return {
    text: de ? entry.de : entry.en,
    tone: entry.tone,
    title: de ? entry.titleDe : entry.titleEn,
  };
}
