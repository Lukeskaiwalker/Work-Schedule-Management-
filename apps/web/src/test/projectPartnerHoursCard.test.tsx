/**
 * "Partnerstunden" on the project's hours tab.
 *
 * What must hold: hidden while no partner reported anything; otherwise the
 * grand total, one total per company, and every entry with its job — kept
 * apart from the planned-hours budget.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { ProjectPartnerHoursCard } from "../components/project/ProjectPartnerHoursCard";
import { listProjectPartnerHours } from "../utils/partnersApi";
import type { PartnerHoursEntry } from "../types";

vi.mock("../utils/partnersApi", () => ({
  listProjectPartnerHours: vi.fn(),
  deletePartnerHours: vi.fn(),
}));

function entry(id: number, partnerId: number, name: string, total: number): PartnerHoursEntry {
  return {
    id,
    partner: { id: partnerId, name, trade: null, archived_at: null },
    project_id: 11,
    task: id === 3 ? null : { id: 21, title: "Dachrinne und Fallrohre erneuern" },
    work_date: "2026-10-08",
    workers: 1,
    hours: total,
    total_hours: total,
    note: null,
    reported_by: null,
    created_at: "2026-10-08T16:00:00",
  };
}

function card() {
  const context = makeAppContextStub({ overrides: { token: "tok", language: "de", canCreateProject: false } });
  return (
    <AppContext.Provider value={context as never}>
      <ProjectPartnerHoursCard projectId={11} />
    </AppContext.Provider>
  );
}

beforeEach(() => {
  vi.mocked(listProjectPartnerHours).mockReset();
});

describe("ProjectPartnerHoursCard", () => {
  it("stays hidden while nobody reported hours", async () => {
    vi.mocked(listProjectPartnerHours).mockResolvedValue([]);
    const { container } = render(card());
    await waitFor(() => expect(listProjectPartnerHours).toHaveBeenCalledWith("tok", 11));
    expect(container).toBeEmptyDOMElement();
  });

  it("totals per company and lists every entry with its job", async () => {
    vi.mocked(listProjectPartnerHours).mockResolvedValue([
      entry(1, 3, "Bedachungen Hoffmann KG", 16),
      entry(2, 4, "Wagner Sanitär e.K.", 2.5),
      entry(3, 3, "Bedachungen Hoffmann KG", 2),
    ]);
    render(card());
    const section = await screen.findByRole("region", { name: "Partnerstunden" });
    expect(within(section).getByText("20,5 Std")).toBeInTheDocument();
    const totals = section.querySelector(".project-hours-partner-totals") as HTMLElement;
    expect(within(totals).getByText("Bedachungen Hoffmann KG").nextSibling).toHaveTextContent("18 Std");
    expect(within(totals).getByText("Wagner Sanitär e.K.").nextSibling).toHaveTextContent("2,5 Std");
    expect(within(section).getAllByText("Dachrinne und Fallrohre erneuern")).toHaveLength(2);
    expect(within(section).getByText("Ohne bestimmte Aufgabe")).toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: /entfernen/ })).toBeNull();
  });
});
