/**
 * The box-material list a crew sees on a task.
 *
 * Two things must be true on every surface: the status column tells a
 * reported quantity apart from "nobody said yet" (a reported zero is a
 * statement, not an absence), and the Packliste opens through the same
 * opener the rest of the app uses for server PDFs — a bare link or
 * window.open would 401 in the iOS shell.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TaskMaterialList } from "../components/tasks/TaskMaterialList";
import { openServerFile } from "../native/fileOpen";
import type { TaskMaterial } from "../types";

vi.mock("../native/fileOpen", () => ({ openServerFile: vi.fn() }));

function material(overrides: Partial<TaskMaterial> = {}): TaskMaterial {
  return {
    id: 1,
    item_name: "NYM-J 3x1,5",
    article_no: "A-1001",
    ean: null,
    unit: "m",
    quantity: 100,
    quantity_used: null,
    article_id: null,
    source_box_id: 3,
    notes: null,
    settled_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(openServerFile).mockClear();
});

describe("TaskMaterialList", () => {
  it("renders nothing for a task without box materials", () => {
    const { container } = render(<TaskMaterialList taskId={1} materials={[]} language="de" />);
    expect(container).toBeEmptyDOMElement();
    const missing = render(<TaskMaterialList taskId={1} materials={undefined} language="de" />);
    expect(missing.container).toBeEmptyDOMElement();
  });

  it("shows quantity with unit, the item and the article number", () => {
    render(
      <TaskMaterialList
        taskId={42}
        materials={[material(), material({ id: 2, item_name: "Dose", unit: null, article_no: null, quantity: 12 })]}
        language="de"
      />,
    );
    expect(screen.getByText("Material aus der Kiste (2)")).toBeInTheDocument();
    expect(screen.getByText("100 m")).toBeInTheDocument();
    expect(screen.getByText("NYM-J 3x1,5")).toBeInTheDocument();
    expect(screen.getByText("A-1001")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("tells a reported quantity (even zero) apart from an unreported one", () => {
    render(
      <TaskMaterialList
        taskId={42}
        materials={[
          material({ id: 1, quantity_used: 37 }),
          material({ id: 2, item_name: "Dose", unit: "Stk", quantity_used: 0 }),
          material({ id: 3, item_name: "Klemme" }),
        ]}
        language="de"
      />,
    );
    expect(screen.getByText("gemeldet: 37 m")).toBeInTheDocument();
    expect(screen.getByText("gemeldet: 0 Stk")).toBeInTheDocument();
    expect(screen.queryByText("verbucht")).not.toBeInTheDocument();
  });

  it("shows the verbucht badge once the movements were booked", () => {
    render(
      <TaskMaterialList
        taskId={42}
        materials={[material({ quantity_used: 80, settled_at: "2026-09-08T10:00:00Z" })]}
        language="de"
      />,
    );
    expect(screen.getByText("gemeldet: 80 m")).toBeInTheDocument();
    expect(screen.getByText("verbucht")).toHaveClass("task-material-badge");
  });

  it("opens the Packliste through the server-file opener with the task's URL", () => {
    render(<TaskMaterialList taskId={42} materials={[material()]} language="de" />);
    fireEvent.click(screen.getByRole("button", { name: "Packliste (PDF)" }));
    expect(openServerFile).toHaveBeenCalledTimes(1);
    expect(openServerFile).toHaveBeenCalledWith("/api/tasks/42/packing-list.pdf", expect.stringMatching(/\.pdf$/));
  });

  // Open at first since the field-worker view: the crew reads this list on
  // the card and must not have to tap for it; the fold is for putting it away.
  it("starts open on a card and folds on demand, keeping the PDF button reachable", () => {
    render(<TaskMaterialList taskId={42} materials={[material()]} language="de" collapsible />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("100 m")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Packliste (PDF)" })).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Material \(1\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Packliste (PDF)" })).toBeInTheDocument();
  });
});
