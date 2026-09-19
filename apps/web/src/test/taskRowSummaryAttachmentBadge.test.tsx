/**
 * The paperclip on a task row. The row is the first place the assignee sees
 * the task, so "there is a plan in here" has to show before the task is
 * opened — and only then: most tasks carry no file, and a clip on every row
 * would say nothing.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskAttachmentBadge } from "../components/tasks/TaskAttachmentBadge";
import { TaskRowSummary } from "../components/tasks/TaskRowSummary";
import type { Task } from "../types";

function renderRow(overrides: Partial<Task>) {
  const task: Task = {
    id: 1,
    project_id: 1,
    title: "Zählerwechsel",
    status: "open",
    due_date: "2026-09-20",
    ...overrides,
  };
  render(
    <TaskRowSummary task={task} language="de" todayIso="2026-09-19" projectLabel={{ title: "", subtitle: "" }} />,
  );
}

describe("TaskRowSummary attachment badge", () => {
  it("shows the count with a plain-language title", () => {
    renderRow({ attachment_count: 3 });
    const badge = screen.getByRole("img", { name: "3 Anhänge" });
    expect(badge).toHaveTextContent("📎 3");
    expect(badge).toHaveAttribute("title", "3 Anhänge");
  });

  it("says Anhang, singular, for one", () => {
    renderRow({ attachment_count: 1 });
    expect(screen.getByRole("img", { name: "1 Anhang" })).toHaveTextContent("📎 1");
  });

  it("shows nothing at zero", () => {
    renderRow({ attachment_count: 0 });
    expect(screen.queryByText(/📎/)).not.toBeInTheDocument();
  });

  it("shows nothing when the row predates the count", () => {
    renderRow({});
    expect(screen.queryByText(/📎/)).not.toBeInTheDocument();
  });
});

describe("TaskAttachmentBadge on its own", () => {
  it("speaks English where the row does", () => {
    render(<TaskAttachmentBadge task={{ attachment_count: 2 }} language="en" />);
    expect(screen.getByRole("img", { name: "2 attachments" })).toHaveTextContent("📎 2");
  });
});
