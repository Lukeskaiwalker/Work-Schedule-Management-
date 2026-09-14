/**
 * The one pill on a task row that says whether the date is settled.
 *
 * It replaced a pair of marks that could BOTH read "bestätigt" at once — a
 * green planning pill and a customer dot whose tooltip said the same word —
 * so the properties worth pinning are: every combination of the two
 * independent columns produces exactly the agreed label and tone, the word
 * "bestätigt" is never printed twice, and the empty case renders no node at
 * all (an empty span would still push the title line around).
 *
 * "pending" is the row that matters most here. It used to render nothing, on
 * the theory that it never occurred; the widened due-date reset made it the
 * ordinary consequence of dragging a job to another day, so it now renders —
 * and it renders one of THREE labels, because whether anybody actually asked
 * the customer decides who owes the next move.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TerminBadge } from "../components/tasks/TerminBadge";
import { resolveTerminBadge } from "../utils/terminBadge";
import type { PlanningStatus, Task } from "../types";

type Row = {
  planning: PlanningStatus | null;
  customer: string | null;
  /** Only meaningful while the customer half is "pending". */
  emailSentAt?: string | null;
  expired?: boolean;
  de: string | null;
  en: string | null;
  tone: "confirmed" | "tentative" | "declined" | null;
};

const SENT = "2026-09-01T09:15:00";

/** One row per line of the contract table, in the same order as the spec. */
const CONTRACT: Row[] = [
  // ── planning = confirmed ───────────────────────────────────────────────
  { planning: "confirmed", customer: "confirmed", de: "bestätigt · Kunde", en: "confirmed · by customer", tone: "confirmed" },
  { planning: "confirmed", customer: "declined", de: "bestätigt · Kunde abgesagt", en: "confirmed · customer declined", tone: "declined" },
  { planning: "confirmed", customer: "pending", emailSentAt: null, de: "bestätigt · Kunde fragen", en: "confirmed · ask the customer", tone: "tentative" },
  { planning: "confirmed", customer: "pending", emailSentAt: SENT, de: "bestätigt · Kunde antwortet noch", en: "confirmed · awaiting customer reply", tone: "tentative" },
  { planning: "confirmed", customer: "pending", emailSentAt: SENT, expired: true, de: "bestätigt · Link abgelaufen", en: "confirmed · link expired", tone: "declined" },
  { planning: "confirmed", customer: null, de: "bestätigt", en: "confirmed", tone: "confirmed" },
  // ── planning = tentative ───────────────────────────────────────────────
  { planning: "tentative", customer: "confirmed", de: "in Planung · Kunde zugesagt", en: "tentative · customer agreed", tone: "tentative" },
  { planning: "tentative", customer: "declined", de: "in Planung · Kunde abgesagt", en: "tentative · customer declined", tone: "declined" },
  { planning: "tentative", customer: "pending", emailSentAt: null, de: "in Planung · Kunde fragen", en: "tentative · ask the customer", tone: "tentative" },
  { planning: "tentative", customer: "pending", emailSentAt: SENT, de: "in Planung · Kunde antwortet noch", en: "tentative · awaiting customer reply", tone: "tentative" },
  { planning: "tentative", customer: "pending", emailSentAt: SENT, expired: true, de: "in Planung · Link abgelaufen", en: "tentative · link expired", tone: "declined" },
  { planning: "tentative", customer: null, de: "in Planung", en: "tentative", tone: "tentative" },
  // ── planning = none ────────────────────────────────────────────────────
  { planning: null, customer: "confirmed", de: "Kunde zugesagt", en: "customer agreed", tone: "confirmed" },
  { planning: null, customer: "declined", de: "Kunde abgesagt", en: "customer declined", tone: "declined" },
  { planning: null, customer: "pending", emailSentAt: null, de: "Kunde fragen", en: "ask the customer", tone: "tentative" },
  { planning: null, customer: "pending", emailSentAt: SENT, de: "Kunde antwortet noch", en: "awaiting customer reply", tone: "tentative" },
  { planning: null, customer: "pending", emailSentAt: SENT, expired: true, de: "Link abgelaufen", en: "link expired", tone: "declined" },
  { planning: null, customer: null, de: null, en: null, tone: null },
];

function inputFor(row: Row) {
  return {
    planning_status: row.planning,
    customer_confirmation_status: row.customer,
    customer_confirmation_email_sent_at: row.emailSentAt ?? null,
    customer_confirmation_token_expired: row.expired ?? false,
  };
}

function rowName(row: Row): string {
  if (row.customer !== "pending") return `${row.planning ?? "null"} + ${row.customer ?? "null"}`;
  const qualifier = row.expired ? "expired link" : row.emailSentAt ? "email sent" : "never asked";
  return `${row.planning ?? "null"} + pending (${qualifier})`;
}

function taskWith(planning: PlanningStatus | null, customer: string | null): Task {
  return {
    id: 1,
    project_id: 1,
    title: "Zählerwechsel",
    status: "open",
    planning_status: planning,
    customer_confirmation_status: customer,
  };
}

describe("resolveTerminBadge — the contract table", () => {
  for (const row of CONTRACT) {
    const name = rowName(row);

    it(`German: ${name} → ${row.de ?? "nothing"}`, () => {
      const badge = resolveTerminBadge(inputFor(row), "de");
      if (row.de === null) {
        expect(badge).toBeNull();
        return;
      }
      expect(badge).not.toBeNull();
      expect(badge!.text).toBe(row.de);
      expect(badge!.tone).toBe(row.tone);
    });

    it(`English: ${name} → ${row.en ?? "nothing"}`, () => {
      const badge = resolveTerminBadge(inputFor(row), "en");
      if (row.en === null) {
        expect(badge).toBeNull();
        return;
      }
      expect(badge).not.toBeNull();
      expect(badge!.text).toBe(row.en);
      // The tone is a fact about the data, not about the language.
      expect(badge!.tone).toBe(row.tone);
    });
  }

  it("covers every combination the two columns can produce", () => {
    // 3 planning values × 6 customer states, so a new state added to either
    // axis without a row here trips this count.
    expect(CONTRACT).toHaveLength(18);
  });

  it("never prints the word 'bestätigt' twice in one label", () => {
    for (const row of CONTRACT) {
      const badge = resolveTerminBadge(inputFor(row), "de");
      if (!badge) continue;
      expect(badge.text.toLowerCase().split("bestätigt").length - 1).toBeLessThanOrEqual(1);
    }
  });

  it("gives every German label an English one and vice versa", () => {
    for (const row of CONTRACT) {
      const de = resolveTerminBadge(inputFor(row), "de");
      const en = resolveTerminBadge(inputFor(row), "en");
      expect(de === null).toBe(en === null);
      if (!de || !en) continue;
      expect(en.text).not.toBe("");
      expect(en.text).not.toBe(de.text);
      expect(en.title).not.toBe("");
    }
  });
});

describe("resolveTerminBadge — which pending is it?", () => {
  it("asks the office to call when no confirmation email ever went out", () => {
    const badge = resolveTerminBadge(
      { customer_confirmation_status: "pending", customer_confirmation_email_sent_at: null },
      "de",
    );
    expect(badge!.text).toBe("Kunde fragen");
    expect(badge!.tone).toBe("tentative");
  });

  it("puts the ball with the customer once an email has gone out", () => {
    const badge = resolveTerminBadge(
      { customer_confirmation_status: "pending", customer_confirmation_email_sent_at: SENT },
      "de",
    );
    expect(badge!.text).toBe("Kunde antwortet noch");
  });

  it("warns that the link is dead once it expired — the old dot's warning, restored", () => {
    const badge = resolveTerminBadge(
      {
        customer_confirmation_status: "pending",
        customer_confirmation_email_sent_at: SENT,
        customer_confirmation_token_expired: true,
      },
      "de",
    );
    expect(badge!.text).toBe("Link abgelaufen");
    expect(badge!.tone).toBe("declined");
  });

  it("leaves 'call the customer' to the tooltip — the pill has 164px, not three lines", () => {
    const expiredInput = {
      planning_status: "confirmed" as const,
      customer_confirmation_status: "pending",
      customer_confirmation_email_sent_at: SENT,
      customer_confirmation_token_expired: true,
    };
    // The longest label the table can produce. With "— anrufen" on the end it
    // wrapped to about three lines in the planning column.
    const de = resolveTerminBadge(expiredInput, "de")!;
    expect(de.text).toBe("bestätigt · Link abgelaufen");
    expect(de.text).not.toMatch(/anrufen/i);
    expect(de.title).toMatch(/anrufen/i);

    const en = resolveTerminBadge(expiredInput, "en")!;
    expect(en.text).toBe("confirmed · link expired");
    expect(en.text).not.toMatch(/call/i);
    expect(en.title).toMatch(/call the customer/i);
  });

  it("does not claim a link expired when no link was ever sent", () => {
    // token_expired is a plain `today >= due_date` check on the server, so it
    // is true for EVERY overdue pending task. Without the email check first,
    // an overdue task nobody ever emailed would advertise a dead link.
    const badge = resolveTerminBadge(
      {
        customer_confirmation_status: "pending",
        customer_confirmation_email_sent_at: null,
        customer_confirmation_token_expired: true,
      },
      "de",
    );
    expect(badge!.text).toBe("Kunde fragen");
  });

  it("no longer treats 'pending' as 'no answer at all'", () => {
    // The regression this file exists to prevent: a planner moves a date, the
    // backend resets the customer's yes to pending, and the pill vanishes.
    for (const planning of [null, "tentative", "confirmed"] as const) {
      const pending = resolveTerminBadge(
        { planning_status: planning, customer_confirmation_status: "pending" },
        "de",
      );
      const nothing = resolveTerminBadge(
        { planning_status: planning, customer_confirmation_status: null },
        "de",
      );
      expect(pending).not.toBeNull();
      expect(pending).not.toEqual(nothing);
    }
  });

  it("collapses an unknown status from a future backend onto 'no answer'", () => {
    expect(resolveTerminBadge({ customer_confirmation_status: "rescheduled" }, "de")).toBeNull();
    expect(
      resolveTerminBadge(
        { planning_status: "tentative", customer_confirmation_status: "rescheduled" },
        "de",
      )?.text,
    ).toBe("in Planung");
  });

  it("treats undefined like null on every field", () => {
    expect(resolveTerminBadge({}, "de")).toBeNull();
    expect(resolveTerminBadge({ customer_confirmation_status: "confirmed" }, "de")?.text).toBe(
      "Kunde zugesagt",
    );
    expect(resolveTerminBadge({ planning_status: "confirmed" }, "de")?.text).toBe("bestätigt");
  });

  it("tells internal certainty and the customer's answer apart in the tooltip", () => {
    // The two old badges both said "bestätigt" and neither said whose word it
    // was; a tooltip that does not name the axis rebuilds that confusion.
    expect(
      resolveTerminBadge(
        { planning_status: "confirmed", customer_confirmation_status: "confirmed" },
        "de",
      )!.title,
    ).toBe("Termin steht fest — vom Kunden zugesagt");
    expect(resolveTerminBadge({ planning_status: "confirmed" }, "de")!.title).toBe(
      "Termin steht fest (intern)",
    );
    expect(resolveTerminBadge({ planning_status: "tentative" }, "de")!.title).toBe(
      "Termin noch nicht fix (intern)",
    );
    expect(resolveTerminBadge({ customer_confirmation_status: "declined" }, "de")!.title).toBe(
      "Kunde hat abgesagt",
    );
    expect(
      resolveTerminBadge(
        { customer_confirmation_status: "pending", customer_confirmation_email_sent_at: null },
        "en",
      )!.title,
    ).toContain("has not been asked yet");
  });
});

describe("TerminBadge", () => {
  it("renders nothing when there is nothing to say", () => {
    const { container } = render(<TerminBadge task={taskWith(null, null)} language="de" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a pill while the customer answer is pending — it used to render none", () => {
    render(<TerminBadge task={taskWith(null, "pending")} language="de" />);
    expect(screen.getByText("Kunde fragen")).toHaveClass(
      "tasks-page-row-badge--termin-tentative",
    );
  });

  it("renders one pill, not two, when both axes have an answer", () => {
    const { container } = render(
      <TerminBadge task={taskWith("confirmed", "confirmed")} language="de" />,
    );
    expect(container.querySelectorAll(".tasks-page-row-badge")).toHaveLength(1);
    expect(screen.getByText("bestätigt · Kunde")).toBeInTheDocument();
  });

  it("carries the tone as a class so the three colours are addressable", () => {
    render(<TerminBadge task={taskWith("tentative", null)} language="de" />);
    const pill = screen.getByText("in Planung");
    expect(pill).toHaveClass("tasks-page-row-badge");
    expect(pill).toHaveClass("tasks-page-row-badge--termin");
    expect(pill).toHaveClass("tasks-page-row-badge--termin-tentative");
    expect(pill).not.toHaveClass("tasks-page-row-badge--termin-confirmed");
  });

  it("marks a customer decline red even when our own planning is confirmed", () => {
    render(<TerminBadge task={taskWith("confirmed", "declined")} language="de" />);
    expect(screen.getByText("bestätigt · Kunde abgesagt")).toHaveClass(
      "tasks-page-row-badge--termin-declined",
    );
  });

  it("keeps the phone note reachable on hover — it is the proof of what was agreed", () => {
    render(
      <TerminBadge
        task={{
          ...taskWith(null, "confirmed"),
          customer_confirmation_at: "2026-05-12T14:32:00",
          customer_confirmation_method: "phone",
          customer_confirmation_by_display_name: "Luca Schmidt",
          customer_confirmation_notes: "Herr Meier kommt um 8",
        }}
        language="de"
      />,
    );
    const title = screen.getByText("Kunde zugesagt").getAttribute("title") ?? "";
    expect(title).toContain("Kunde hat zugesagt");
    expect(title).toContain("per Telefon");
    expect(title).toContain("Luca Schmidt");
    expect(title).toContain("Herr Meier kommt um 8");
  });

  it("shows when we last asked, on a pending row that was emailed", () => {
    render(
      <TerminBadge
        task={{
          ...taskWith(null, "pending"),
          customer_confirmation_email_sent_at: SENT,
        }}
        language="de"
      />,
    );
    const title = screen.getByText("Kunde antwortet noch").getAttribute("title") ?? "";
    expect(title).toContain("E-Mail zuletzt gesendet");
    expect(title).toContain("2026-09-01 09:15");
  });

  it("shows no stale phone note on a pending row", () => {
    // The note survives a reset by design (it is the only record of what was
    // agreed), so a pending row must not present it as the current answer.
    render(
      <TerminBadge
        task={{
          ...taskWith(null, "pending"),
          customer_confirmation_notes: "Telefonat 14:32, Hr. Schmidt",
        }}
        language="de"
      />,
    );
    const title = screen.getByText("Kunde fragen").getAttribute("title") ?? "";
    expect(title).not.toContain("Hr. Schmidt");
  });

  it("adds no provenance lines when the customer never answered", () => {
    render(<TerminBadge task={taskWith("confirmed", null)} language="de" />);
    expect(screen.getByText("bestätigt")).toHaveAttribute(
      "title",
      "Termin steht fest (intern)",
    );
  });

  it("uses the English fallbacks when the UI language is English", () => {
    render(<TerminBadge task={taskWith("tentative", "confirmed")} language="en" />);
    expect(screen.getByText("tentative · customer agreed")).toBeInTheDocument();
  });

  it("uses the English fallbacks for the pending labels too", () => {
    render(<TerminBadge task={taskWith("confirmed", "pending")} language="en" />);
    expect(screen.getByText("confirmed · ask the customer")).toBeInTheDocument();
  });
});
