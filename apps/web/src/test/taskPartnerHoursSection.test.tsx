/**
 * "Partnerstunden" in the task modal.
 *
 * What must hold: nothing is shown for a task without partner hours; with
 * hours, every partner's rows appear with the company named and the total;
 * removing one is offered only with project rights and asks first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { TaskPartnerHoursSection } from "../components/tasks/TaskPartnerHoursSection";
import { deletePartnerHours, listTaskPartnerHours } from "../utils/partnersApi";
import type { PartnerHoursEntry } from "../types";

vi.mock("../utils/partnersApi", () => ({
  listTaskPartnerHours: vi.fn(),
  deletePartnerHours: vi.fn(),
}));

function entry(id: number, partnerName: string, fields: Partial<PartnerHoursEntry> = {}): PartnerHoursEntry {
  return {
    id,
    partner: { id: id, name: partnerName, trade: null, archived_at: null },
    project_id: 11,
    task: { id: 21, title: "Dachdurchführung Lüftung" },
    work_date: "2026-10-08",
    workers: 1,
    hours: 2,
    total_hours: 2,
    note: null,
    reported_by: null,
    created_at: "2026-10-08T16:00:00",
    ...fields,
  };
}

function section(overrides: Record<string, unknown> = {}) {
  const context = makeAppContextStub({ overrides: { token: "tok", language: "de", canCreateProject: true, ...overrides } });
  return (
    <AppContext.Provider value={context as never}>
      <TaskPartnerHoursSection taskId={21} />
    </AppContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(listTaskPartnerHours).mockReset();
  vi.mocked(deletePartnerHours).mockReset();
});

describe("TaskPartnerHoursSection", () => {
  it("shows nothing for a task without partner hours", async () => {
    vi.mocked(listTaskPartnerHours).mockResolvedValue([]);
    const { container } = render(section());
    await waitFor(() => expect(listTaskPartnerHours).toHaveBeenCalledWith("tok", 21));
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every partner's hours with the total and removes one after asking", async () => {
    vi.mocked(listTaskPartnerHours).mockResolvedValue([
      entry(1, "Bedachungen Hoffmann KG", { workers: 2, hours: 3, total_hours: 6 }),
      entry(2, "Wagner Sanitär e.K."),
    ]);
    vi.mocked(deletePartnerHours).mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(section());
    expect(await screen.findByText("8 Std gemeldet")).toBeInTheDocument();
    expect(screen.getByText(/Bedachungen Hoffmann KG/)).toBeInTheDocument();
    expect(screen.getByText(/Wagner Sanitär e\.K\./)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /entfernen/ })[1]);
    await waitFor(() => expect(deletePartnerHours).toHaveBeenCalledWith("tok", 2));
    expect(await screen.findByText("6 Std gemeldet")).toBeInTheDocument();
  });

  it("is read-only without project rights", async () => {
    vi.mocked(listTaskPartnerHours).mockResolvedValue([entry(1, "Bedachungen Hoffmann KG")]);
    render(section({ canCreateProject: false }));
    expect(await screen.findByText("2 Std gemeldet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /entfernen/ })).toBeNull();
  });
});
