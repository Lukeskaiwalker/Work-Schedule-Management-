/**
 * The "Termin & Kundenbestätigung" half of the task modal.
 *
 * Ways this block was dangerous, all guarded here:
 *
 *   1. The confirm/decline buttons were gated on "a confirmation flow exists",
 *      which is not the same question as "is there a customer". 535 of the 562
 *      tasks in production have no customer at all, and on one of those the
 *      hint told the operator to tick "Kundenbestätigung anfordern" to unlock
 *      the buttons — i.e. walked them into recording an agreement for a
 *      customer that does not exist. Employees saw the controls too, and their
 *      click can only come back 403: the endpoint wants tasks:manage.
 *
 *   2. The request checkbox is manager-only for a harsher reason than the
 *      buttons: request_customer_confirmation is not in the api's
 *      ALLOWED_EMPLOYEE_FIELDS, so an employee's tick 403s the WHOLE patch and
 *      takes every other edit in the modal with it.
 *
 *   3. Both confirmation endpoints commit server-side, which invalidates the
 *      modal's optimistic-lock expectation and turns the unsaved tick that put
 *      the buttons on screen into a "start a fresh round" instruction that
 *      would void the verdict just recorded.
 *
 *   4. The modal is permanently mounted, so a POST still in flight when the
 *      operator moves to another task would write the first task's answer onto
 *      the second one.
 *
 *   5. The phone note survives a reset — it is the only record of what was
 *      agreed — so next to "pending" it describes the PREVIOUS round and has
 *      to say so. The send timestamp does NOT survive one: it is per-round, so
 *      it never needs that qualifier and must not get one.
 *
 * What must NOT regress: once there is a customer and a flow, the buttons stay
 * available in every status, confirmed and declined included — "Kunde ruft an
 * und sagt doch ab" is the most ordinary event of the week.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TaskEditModal } from "../components/modals/TaskEditModal";
import type { TaskEditFormState } from "../types";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

const CONFIRM_BUTTON = "Kunde hat zugesagt";
const DECLINE_BUTTON = "Kunde hat abgesagt";
const REQUEST_CHECKBOX = "Kundenbestätigung anfordern";
const EMAIL_BUTTON = /Bestätigungs-E-Mail senden/;
/** A resolved customer, the way App derives one: task's own, else project's. */
const CUSTOMER_ID = 7;

function formWith(overrides: Partial<TaskEditFormState>): TaskEditFormState {
  return {
    id: 42,
    project_id: null,
    customer_id: null,
    title: "Zählerwechsel",
    description: "",
    subtasks_raw: "",
    materials_required: "",
    has_storage_box: false,
    storage_box_number: "",
    construction_box_id: "",
    construction_box_number: null,
    task_type: "construction",
    class_template_id: "",
    status: "open",
    due_date: "2026-09-20",
    end_date: "",
    start_time: "",
    estimated_hours: "",
    priority: "normal",
    planning_status: "",
    assignee_query: "",
    assignee_ids: [],
    partner_ids: [],
    week_start: "",
    request_customer_confirmation: false,
    customer_confirmation_status: null,
    materials: [],
    ...overrides,
  };
}

function contextValue(
  form: Partial<TaskEditFormState>,
  context: Record<string, unknown> = {},
) {
  return makeAppContextStub({
    overrides: {
      language: "de",
      taskEditModalOpen: true,
      canManageTasks: true,
      // The customer signal the gate keys on. Defaulted to "there is one" so
      // each test states only the thing it is about; the no-customer tests
      // pass null explicitly.
      taskEditCustomerId: CUSTOMER_ID,
      taskEditForm: formWith(form),
      taskEditMaterialRows: [],
      taskEditOverlapWarning: null,
      taskEditExpectedUpdatedAt: null,
      menuUserNameById: () => "",
      assigneeAvailabilityHint: () => null,
      taskProjectTitleParts: () => ({ title: "", suffix: "" }),
      ...context,
    },
  }) as never;
}

function renderModal(
  form: Partial<TaskEditFormState>,
  context: Record<string, unknown> = {},
) {
  const result = render(
    <AppContext.Provider value={contextValue(form, context)}>
      <TaskEditModal />
    </AppContext.Provider>,
  );
  return {
    ...result,
    /**
     * Point the (permanently mounted) modal at another task, or close it —
     * exactly what the app does when the operator picks a different row.
     */
    showTask(
      nextForm: Partial<TaskEditFormState>,
      nextContext: Record<string, unknown> = {},
    ) {
      result.rerender(
        <AppContext.Provider value={contextValue(nextForm, nextContext)}>
          <TaskEditModal />
        </AppContext.Provider>,
      );
    },
  };
}

describe("who may record a customer confirmation", () => {
  it("offers nothing to record before anybody asked for a confirmation", () => {
    renderModal({ request_customer_confirmation: false, customer_confirmation_status: null });
    expect(screen.queryByRole("button", { name: CONFIRM_BUTTON })).toBeNull();
    expect(screen.queryByRole("button", { name: DECLINE_BUTTON })).toBeNull();
  });

  it("says why the buttons are absent instead of leaving a blank", () => {
    renderModal({ request_customer_confirmation: false, customer_confirmation_status: null });
    expect(screen.getByText(/keine Kundenbestätigung/i)).toBeInTheDocument();
    expect(screen.getByText(/ankreuzen/i)).toBeInTheDocument();
  });

  it("hides them from an employee, whose click could only come back 403", () => {
    renderModal(
      { request_customer_confirmation: true, customer_confirmation_status: "pending" },
      { canManageTasks: false },
    );
    expect(screen.queryByRole("button", { name: CONFIRM_BUTTON })).toBeNull();
    expect(screen.queryByRole("button", { name: EMAIL_BUTTON })).toBeNull();
  });

  it("offers them as soon as the request flag is ticked, before any round ran", () => {
    renderModal({ request_customer_confirmation: true, customer_confirmation_status: null });
    expect(screen.getByRole("button", { name: CONFIRM_BUTTON })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: DECLINE_BUTTON })).toBeInTheDocument();
  });

  it("keeps them after a confirmation — the customer may still call and cancel", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "confirmed",
    });
    expect(screen.getByRole("button", { name: CONFIRM_BUTTON })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: DECLINE_BUTTON })).toBeInTheDocument();
  });

  it("keeps them after a decline, and on a task whose request flag was unticked", () => {
    renderModal({
      request_customer_confirmation: false,
      customer_confirmation_status: "declined",
    });
    expect(screen.getByRole("button", { name: CONFIRM_BUTTON })).toBeInTheDocument();
  });
});

/**
 * The gate's real subject. A ticked checkbox says somebody MEANT to ask
 * someone; it does not say there is anyone to ask. On a Baustellenaufgabe with
 * no customer — the overwhelming majority of this database — the two questions
 * come apart, and only the second one may open the buttons.
 */
describe("a task with no customer cannot have an answer recorded", () => {
  const FULL_FLOW = {
    request_customer_confirmation: true,
    customer_confirmation_status: "pending",
  };

  it("withholds the buttons however the flow flags read", () => {
    renderModal(FULL_FLOW, { taskEditCustomerId: null });
    expect(screen.queryByRole("button", { name: CONFIRM_BUTTON })).toBeNull();
    expect(screen.queryByRole("button", { name: DECLINE_BUTTON })).toBeNull();
  });

  it("withholds them on a recorded confirmation too", () => {
    renderModal(
      { request_customer_confirmation: true, customer_confirmation_status: "confirmed" },
      { taskEditCustomerId: null },
    );
    expect(screen.queryByRole("button", { name: CONFIRM_BUTTON })).toBeNull();
  });

  it("names the actual reason — no customer — and stops there", () => {
    renderModal(FULL_FLOW, { taskEditCustomerId: null });
    expect(screen.getByText(/keinen Kunden/i)).toBeInTheDocument();
  });

  it("does NOT tell the operator to tick the box, which would ask nobody", () => {
    // The wording that made this a trap: "zuerst oben 'Kundenbestätigung
    // anfordern' ankreuzen" on a task with no customer behind it.
    renderModal(
      { request_customer_confirmation: false, customer_confirmation_status: null },
      { taskEditCustomerId: null },
    );
    expect(screen.getByText(/keinen Kunden/i)).toBeInTheDocument();
    expect(screen.queryByText(/ankreuzen/i)).toBeNull();
  });

  it("opens them again the moment a customer is resolved", () => {
    const { showTask } = renderModal(FULL_FLOW, { taskEditCustomerId: null });
    expect(screen.queryByRole("button", { name: CONFIRM_BUTTON })).toBeNull();
    showTask(FULL_FLOW, { taskEditCustomerId: CUSTOMER_ID });
    expect(screen.getByRole("button", { name: CONFIRM_BUTTON })).toBeInTheDocument();
  });
});

describe("the request checkbox", () => {
  it("is not shown to an employee — their tick 403s the whole PATCH", () => {
    // request_customer_confirmation is not in ALLOWED_EMPLOYEE_FIELDS (only
    // status / expected_updated_at / confirm_overlap are), so the failure is
    // not a rejected checkbox: every other edit in the modal dies with it.
    renderModal(
      { request_customer_confirmation: false, customer_confirmation_status: "pending" },
      { canManageTasks: false },
    );
    expect(screen.queryByLabelText(REQUEST_CHECKBOX)).toBeNull();
  });

  it("leaves the read-only status panel visible to that employee", () => {
    renderModal(
      { request_customer_confirmation: true, customer_confirmation_status: "confirmed" },
      { canManageTasks: false },
    );
    expect(screen.getByText(/Kunde hat zugesagt ✓/)).toBeInTheDocument();
  });

  it("stays usable while the round is still open", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
    });
    expect(screen.getByLabelText(REQUEST_CHECKBOX)).toBeEnabled();
  });

  it("stays usable after the customer answered — the only way to undo a wrong entry", () => {
    // It was disabled here for one round, which meant a confirmation recorded
    // on the wrong task could not be cleared from any screen. The api now
    // makes ticking-when-answered a no-op, so the destructive half is gone
    // while unticking still clears the flow.
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "confirmed",
    });
    expect(screen.getByLabelText(REQUEST_CHECKBOX)).toBeEnabled();
  });

  it("is enabled after a decline too", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "declined",
    });
    expect(screen.getByLabelText(REQUEST_CHECKBOX)).toBeEnabled();
  });

  it("explains what unticking does instead of claiming to be locked", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "confirmed",
    });
    expect(screen.getByText(/bereits geantwortet/i)).toBeInTheDocument();
    expect(screen.queryByText(/gesperrt/i)).toBeNull();
    expect(screen.getByText(/Häkchen entfernen/i)).toBeInTheDocument();
  });
});

describe("evidence from the previous round is labelled as such", () => {
  it("marks the phone note as previous-round while the task is pending again", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
      customer_confirmation_notes: "Telefonat 14:32, Hr. Schmidt kommt um 8",
    });
    expect(screen.getByText(/vorherige Runde/i)).toBeInTheDocument();
    expect(screen.getByText(/Hr. Schmidt kommt um 8/)).toBeInTheDocument();
  });

  it("shows the same note unqualified once it describes the current answer", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "confirmed",
      customer_confirmation_notes: "Telefonat 14:32, Hr. Schmidt kommt um 8",
    });
    expect(screen.queryByText(/vorherige Runde/i)).toBeNull();
  });

  it("does NOT qualify the send timestamp — that column is per-round", () => {
    // The reset mints a new token, which kills the link the old timestamp
    // described, so the api clears the timestamp with it. Anything standing
    // here belongs to the round on screen, and the qualifier this used to
    // carry (from a session-lived Set of "tasks we emailed") was a guess that
    // never expired.
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
      customer_confirmation_email_sent_at: "2026-09-01T09:15:00",
    });
    expect(screen.getByText(/E-Mail zuletzt gesendet/)).toBeInTheDocument();
    expect(screen.queryByText(/vorherige Runde/i)).toBeNull();
  });

  it("offers a resend only where this round actually has a send behind it", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
      customer_confirmation_email_sent_at: null,
    });
    expect(screen.getByRole("button", { name: EMAIL_BUTTON })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /erneut senden/ })).toBeNull();
  });

  it("does not claim the customer is slow when nobody ever asked them", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
      customer_confirmation_email_sent_at: null,
    });
    expect(screen.getByText(/Noch nicht gefragt/i)).toBeInTheDocument();
    expect(screen.queryByText(/Wartet auf Rückmeldung/i)).toBeNull();
  });

  it("does not announce an expired link where no link was ever sent", () => {
    // token_expired is a plain `today >= due_date` check server-side, so it is
    // true for every overdue pending task, emailed or not.
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
      customer_confirmation_email_sent_at: null,
      customer_confirmation_token_expired: true,
    });
    expect(screen.queryByText(/Link abgelaufen/i)).toBeNull();
  });

  it("does announce it once a link actually went out", () => {
    renderModal({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
      customer_confirmation_email_sent_at: "2026-09-01T09:15:00",
      customer_confirmation_token_expired: true,
    });
    expect(screen.getByText(/Link abgelaufen/i)).toBeInTheDocument();
  });
});


/**
 * What happens to the modal's own bookkeeping when one of the confirmation
 * endpoints commits. Both of them write to the task server-side, and both used
 * to leave the modal holding two stale facts:
 *
 *   - taskEditExpectedUpdatedAt, captured when the modal opened, is now behind
 *     Task.updated_at, so the operator's next Save 409s against their own
 *     click and takes every other edit in the modal with it.
 *
 *   - the "Kundenbestätigung anfordern" tick that had to happen first, in
 *     order for these buttons to appear at all, still counts as an unsaved
 *     change — and that change means "start a fresh round" to the api, which
 *     would wipe the verdict just recorded.
 */
describe("the modal's bookkeeping after a confirmation is persisted", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  const OPENED_AT = "2026-09-14T08:00:00";

  function trackingContext() {
    const formUpdates: ((current: TaskEditFormState) => TaskEditFormState)[] = [];
    const baseWrites: (TaskEditFormState | null)[] = [];
    const expectedWrites: (string | null)[] = [];
    const notices: string[] = [];
    const errors: string[] = [];
    const base = formWith({
      request_customer_confirmation: false,
      customer_confirmation_status: null,
    });
    return {
      formUpdates,
      baseWrites,
      expectedWrites,
      notices,
      errors,
      base,
      /** Fold every captured form update onto a starting state. */
      applyTo(start: Partial<TaskEditFormState>): TaskEditFormState {
        return formUpdates.reduce((form, update) => update(form), formWith(start));
      },
      overrides: {
        taskEditFormBase: base,
        taskEditExpectedUpdatedAt: OPENED_AT,
        setTaskEditForm: (
          update: TaskEditFormState | ((current: TaskEditFormState) => TaskEditFormState),
        ) => {
          if (typeof update === "function") formUpdates.push(update);
        },
        setTaskEditFormBase: (form: TaskEditFormState | null) => baseWrites.push(form),
        setTaskEditExpectedUpdatedAt: (at: string | null) => expectedWrites.push(at),
        setNotice: (message: string) => notices.push(message),
        setError: (message: string) => errors.push(message),
      },
    };
  }

  it("adopts the updated_at the manual endpoint returns, so the next Save still lands", async () => {
    const ctx = trackingContext();
    apiFetchMock.mockResolvedValue({
      id: 42,
      project_id: null,
      title: "Zählerwechsel",
      status: "open",
      customer_confirmation_status: "confirmed",
      customer_confirmation_at: "2026-09-14T09:59:00",
      customer_confirmation_method: "phone",
      updated_at: "2026-09-14T10:00:00",
    });

    renderModal({ request_customer_confirmation: true }, ctx.overrides);
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_BUTTON }));

    await waitFor(() => expect(ctx.expectedWrites).toContain("2026-09-14T10:00:00"));
  });

  it("stops the pending checkbox tick from re-resetting the round on the next Save", async () => {
    const ctx = trackingContext();
    apiFetchMock.mockResolvedValue({
      id: 42,
      project_id: null,
      title: "Zählerwechsel",
      status: "open",
      customer_confirmation_status: "confirmed",
      updated_at: "2026-09-14T10:00:00",
    });

    // The operator ticked the box a second ago — that is what put these
    // buttons on screen — so the form says true while the baseline says false.
    renderModal({ request_customer_confirmation: true }, ctx.overrides);
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_BUTTON }));

    await waitFor(() => expect(ctx.baseWrites.length).toBeGreaterThan(0));
    // Baseline now agrees with the form, so saveTaskEdit's diff no longer
    // carries request_customer_confirmation and the api is never asked to
    // start a fresh round over the confirmation it just stored.
    expect(ctx.baseWrites[ctx.baseWrites.length - 1]?.request_customer_confirmation).toBe(true);
    const applied = ctx.applyTo({ request_customer_confirmation: true });
    expect(applied.request_customer_confirmation).toBe(true);
    expect(applied.customer_confirmation_status).toBe("confirmed");
  });

  it("adopts the email endpoint's updated_at too, instead of dropping the lock", async () => {
    const ctx = trackingContext();
    apiFetchMock.mockResolvedValue({
      sent: true,
      sent_at: "2026-09-14T10:00:00",
      error_detail: null,
      updated_at: "2026-09-14T10:00:01",
    });

    renderModal(
      { request_customer_confirmation: true, customer_confirmation_status: "pending" },
      ctx.overrides,
    );
    fireEvent.click(screen.getByRole("button", { name: EMAIL_BUTTON }));

    await waitFor(() => expect(ctx.baseWrites.length).toBeGreaterThan(0));
    expect(ctx.baseWrites[ctx.baseWrites.length - 1]?.request_customer_confirmation).toBe(true);
    expect(ctx.expectedWrites).toContain("2026-09-14T10:00:01");
    expect(ctx.expectedWrites).not.toContain(null);
    const applied = ctx.applyTo({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
    });
    expect(applied.customer_confirmation_email_sent_at).toBe("2026-09-14T10:00:00");
  });

  it("still degrades to an unguarded save against an api that answers without one", async () => {
    // Unguarded beats guaranteed-to-409: the send committed either way.
    const ctx = trackingContext();
    apiFetchMock.mockResolvedValue({
      sent: true,
      sent_at: "2026-09-14T10:00:00",
      error_detail: null,
    });

    renderModal(
      { request_customer_confirmation: true, customer_confirmation_status: "pending" },
      ctx.overrides,
    );
    fireEvent.click(screen.getByRole("button", { name: EMAIL_BUTTON }));

    await waitFor(() => expect(ctx.expectedWrites).toContain(null));
  });
});

/**
 * A failed send is not a no-op. The api resets the round before it talks to
 * SMTP and commits either way; only failures that provably never reached the
 * wire are rolled back. So "sent: false" covers two opposite server states,
 * and the version the endpoint reports is what tells them apart.
 */
describe("a failed email send", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  const OPENED_AT = "2026-09-14T08:00:00";

  function failureContext() {
    const formUpdates: ((current: TaskEditFormState) => TaskEditFormState)[] = [];
    const baseWrites: (TaskEditFormState | null)[] = [];
    const expectedWrites: (string | null)[] = [];
    const errors: string[] = [];
    return {
      formUpdates,
      baseWrites,
      expectedWrites,
      errors,
      applyTo(start: Partial<TaskEditFormState>): TaskEditFormState {
        return formUpdates.reduce((form, update) => update(form), formWith(start));
      },
      overrides: {
        taskEditFormBase: formWith({ request_customer_confirmation: false }),
        taskEditExpectedUpdatedAt: OPENED_AT,
        setTaskEditForm: (
          update: TaskEditFormState | ((current: TaskEditFormState) => TaskEditFormState),
        ) => {
          if (typeof update === "function") formUpdates.push(update);
        },
        setTaskEditFormBase: (form: TaskEditFormState | null) => baseWrites.push(form),
        setTaskEditExpectedUpdatedAt: (at: string | null) => expectedWrites.push(at),
        setError: (message: string) => errors.push(message),
      },
    };
  }

  it("re-syncs the panel when the version moved, because the reset stood", async () => {
    const ctx = failureContext();
    apiFetchMock.mockResolvedValue({
      sent: false,
      sent_at: null,
      error_detail: "SMTP timeout",
      updated_at: "2026-09-14T10:00:00",
    });

    renderModal(
      {
        request_customer_confirmation: true,
        customer_confirmation_status: "pending",
        customer_confirmation_email_sent_at: "2026-09-01T09:15:00",
      },
      ctx.overrides,
    );
    fireEvent.click(screen.getByRole("button", { name: /erneut senden/ }));

    await waitFor(() => expect(ctx.errors.length).toBe(1));
    // The lock is re-pinned rather than left pointing at a version the failed
    // send already superseded — the next Save 409'd on the operator's own
    // click before this.
    expect(ctx.expectedWrites).toContain("2026-09-14T10:00:00");
    const applied = ctx.applyTo({
      request_customer_confirmation: true,
      customer_confirmation_status: "pending",
      customer_confirmation_email_sent_at: "2026-09-01T09:15:00",
    });
    expect(applied.customer_confirmation_status).toBe("pending");
    // The old link died with the new token, and this round's never left.
    expect(applied.customer_confirmation_email_sent_at).toBeNull();
    expect(ctx.baseWrites.length).toBeGreaterThan(0);
  });

  it("leaves everything alone when the version did not move", async () => {
    // "no customer email on record" — the failure this office actually hits —
    // returns before touching a single column. Mirroring a reset here would
    // invent a round the database does not have, and worse, would tell the
    // next Save that the operator's tick is no longer a change, so the flow
    // they asked for would never start.
    const ctx = failureContext();
    apiFetchMock.mockResolvedValue({
      sent: false,
      sent_at: null,
      error_detail: "no customer email on record",
      updated_at: OPENED_AT,
    });

    renderModal(
      { request_customer_confirmation: true, customer_confirmation_status: null },
      ctx.overrides,
    );
    fireEvent.click(screen.getByRole("button", { name: EMAIL_BUTTON }));

    await waitFor(() => expect(ctx.errors.length).toBe(1));
    expect(ctx.formUpdates).toHaveLength(0);
    expect(ctx.baseWrites).toHaveLength(0);
  });

  it("surfaces the reason verbatim either way", async () => {
    const ctx = failureContext();
    apiFetchMock.mockResolvedValue({
      sent: false,
      sent_at: null,
      error_detail: "no customer email on record",
      updated_at: OPENED_AT,
    });

    renderModal(
      { request_customer_confirmation: true, customer_confirmation_status: null },
      ctx.overrides,
    );
    fireEvent.click(screen.getByRole("button", { name: EMAIL_BUTTON }));

    await waitFor(() => expect(ctx.errors.length).toBe(1));
    expect(ctx.errors[0]).toContain("no customer email on record");
  });
});

/**
 * TaskEditModal is mounted for the whole session and renders null when closed,
 * so a request that is still in flight when the operator moves on keeps
 * running. Every setter after the await must check that the task it was fired
 * for is still the one on screen — otherwise the first task's answer lands on
 * the second task's lock, snapshot and diff baseline.
 */
describe("a request in flight while the operator moves on", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  function deferredResponse<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
      resolve = settle;
    });
    apiFetchMock.mockReturnValue(promise as never);
    return { resolve };
  }

  function writeTrackers() {
    const formUpdates: unknown[] = [];
    const baseWrites: unknown[] = [];
    const expectedWrites: (string | null)[] = [];
    const notices: string[] = [];
    return {
      formUpdates,
      baseWrites,
      expectedWrites,
      notices,
      overrides: {
        taskEditFormBase: formWith({ request_customer_confirmation: false }),
        taskEditExpectedUpdatedAt: "2026-09-14T08:00:00",
        setTaskEditForm: (update: unknown) => formUpdates.push(update),
        setTaskEditFormBase: (form: unknown) => baseWrites.push(form),
        setTaskEditExpectedUpdatedAt: (at: string | null) => expectedWrites.push(at),
        setNotice: (message: string) => notices.push(message),
      },
    };
  }

  it("does not write task 42's confirmation onto task 99", async () => {
    const ctx = writeTrackers();
    const pending = deferredResponse<Record<string, unknown>>();

    const { showTask } = renderModal(
      { id: 42, request_customer_confirmation: true },
      ctx.overrides,
    );
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_BUTTON }));

    // Operator closes this task and opens another one while the POST is out.
    showTask({ id: 99, request_customer_confirmation: true }, ctx.overrides);

    pending.resolve({
      id: 42,
      customer_confirmation_status: "confirmed",
      updated_at: "2026-09-14T10:00:00",
    });

    // The notice is not task-scoped and still fires; the writes are, and must
    // not — task 99's lock and baseline belong to task 99.
    await waitFor(() => expect(ctx.notices.length).toBe(1));
    expect(ctx.expectedWrites).toHaveLength(0);
    expect(ctx.formUpdates).toHaveLength(0);
    expect(ctx.baseWrites).toHaveLength(0);
  });

  it("writes nothing once the modal has been closed", async () => {
    const ctx = writeTrackers();
    const pending = deferredResponse<Record<string, unknown>>();

    const { showTask } = renderModal(
      { id: 42, request_customer_confirmation: true },
      ctx.overrides,
    );
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_BUTTON }));
    showTask({ id: 42, request_customer_confirmation: true }, {
      ...ctx.overrides,
      taskEditModalOpen: false,
    });

    pending.resolve({
      id: 42,
      customer_confirmation_status: "confirmed",
      updated_at: "2026-09-14T10:00:00",
    });

    await waitFor(() => expect(ctx.notices.length).toBe(1));
    expect(ctx.expectedWrites).toHaveLength(0);
    expect(ctx.formUpdates).toHaveLength(0);
    expect(ctx.baseWrites).toHaveLength(0);
  });

  it("applies them normally when the operator stayed on the task", async () => {
    // The guard must not swallow the ordinary case it was added around.
    const ctx = writeTrackers();
    const pending = deferredResponse<Record<string, unknown>>();

    renderModal({ id: 42, request_customer_confirmation: true }, ctx.overrides);
    fireEvent.click(screen.getByRole("button", { name: CONFIRM_BUTTON }));

    pending.resolve({
      id: 42,
      customer_confirmation_status: "confirmed",
      updated_at: "2026-09-14T10:00:00",
    });

    await waitFor(() => expect(ctx.expectedWrites).toContain("2026-09-14T10:00:00"));
    expect(ctx.formUpdates.length).toBeGreaterThan(0);
    expect(ctx.baseWrites.length).toBeGreaterThan(0);
  });

  it("does the same on the email path", async () => {
    const ctx = writeTrackers();
    const pending = deferredResponse<Record<string, unknown>>();

    const { showTask } = renderModal(
      {
        id: 42,
        request_customer_confirmation: true,
        customer_confirmation_status: "pending",
      },
      ctx.overrides,
    );
    fireEvent.click(screen.getByRole("button", { name: EMAIL_BUTTON }));
    showTask(
      {
        id: 99,
        request_customer_confirmation: true,
        customer_confirmation_status: "pending",
      },
      ctx.overrides,
    );

    pending.resolve({
      sent: true,
      sent_at: "2026-09-14T10:00:00",
      error_detail: null,
      updated_at: "2026-09-14T10:00:01",
    });

    await waitFor(() => expect(ctx.notices.length).toBe(1));
    expect(ctx.expectedWrites).toHaveLength(0);
    expect(ctx.formUpdates).toHaveLength(0);
    expect(ctx.baseWrites).toHaveLength(0);
  });
});
