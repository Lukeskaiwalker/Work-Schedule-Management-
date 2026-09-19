/**
 * A task row names its anchor. A project task reads "Projekt: 2026-0412 ·
 * Müller"; a customer-only task used to read nothing at all — the fitter saw
 * a title and a date and could not tell whose task it was without opening the
 * customer. It now reads "Kunde: Müller Haustechnik GmbH", from the name the
 * api sends on the row, the caller's resolved label, or "Kunde #id" last.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskRowSummary } from "../components/tasks/TaskRowSummary";
import type { Task } from "../types";

function renderRow(task: Partial<Task> & Record<string, unknown>, extra: { customerLabel?: string; projectTitle?: string } = {}) {
  const row = {
    id: 1,
    project_id: null,
    customer_id: 7,
    title: "Rückruf wegen Angebot",
    status: "open",
    due_date: "2026-09-22",
    ...task,
  } as Task;
  render(
    <TaskRowSummary
      task={row}
      language="de"
      todayIso="2026-09-20"
      projectLabel={{ title: extra.projectTitle ?? "", subtitle: "" }}
      customerLabel={extra.customerLabel}
    />,
  );
}

describe("TaskRowSummary customer anchor", () => {
  it("says Kunde: with the name the api sent on the row", () => {
    renderRow({ customer_name: "Müller Haustechnik GmbH" });
    expect(screen.getByText(/Kunde: Müller Haustechnik GmbH/)).toBeInTheDocument();
    expect(screen.queryByText(/Projekt:/)).not.toBeInTheDocument();
  });

  it("prefers the label the caller resolved over the row's own name", () => {
    renderRow({ customer_name: "Alter Name" }, { customerLabel: "Müller Haustechnik GmbH" });
    expect(screen.getByText(/Kunde: Müller Haustechnik GmbH/)).toBeInTheDocument();
  });

  it("falls back to Kunde #id when nothing names the customer", () => {
    renderRow({});
    expect(screen.getByText(/Kunde: Kunde #7/)).toBeInTheDocument();
  });

  it("keeps saying Projekt: for a project task, even one that also carries a customer", () => {
    renderRow({ project_id: 12, customer_name: "Müller Haustechnik GmbH" }, { projectTitle: "2026-0412 · Müller" });
    expect(screen.getByText(/Projekt: 2026-0412 · Müller/)).toBeInTheDocument();
    expect(screen.queryByText(/Kunde:/)).not.toBeInTheDocument();
  });
});
