/**
 * Where the screenshot pass caught a machine value on screen, the component
 * now renders its label: a customer's project list said "in_durchfuehrung",
 * the project overview's open tasks said "construction", the day dialog of
 * the Zeiterfassung said "open".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { apiFetch } from "../api/client";
import { CustomerProjectRow } from "../components/customers/CustomerProjectRow";
import { DayActivityPanel } from "../components/time/DayActivityPanel";
import { ProjectOverviewTab } from "../pages/project/ProjectOverviewTab";
import type { Project, Task } from "../types";

vi.mock("../api/client", () => ({ apiFetch: vi.fn(), apiUploadWithProgress: vi.fn() }));

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  apiFetchMock.mockReset();
  // Cards inside the overview load their own data; an empty answer is enough.
  apiFetchMock.mockResolvedValue([]);
});

describe("a customer's project list", () => {
  it("shows the status label, not the stored key", () => {
    render(
      <CustomerProjectRow
        project={{
          id: 7,
          project_number: "2026-0412",
          name: "Wallbox",
          status: "in_durchfuehrung",
          last_state: null,
          last_updated_at: null,
          customer_id: 3,
        }}
        language="de"
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByText("In Durchführung")).toBeInTheDocument();
    expect(screen.queryByText("in_durchfuehrung")).toBeNull();
  });

  it("shows the quote phase as such", () => {
    render(
      <CustomerProjectRow
        project={{
          id: 8,
          project_number: "2026-0413",
          name: "Zähler",
          status: "angebotsphase",
          last_state: null,
          last_updated_at: null,
          customer_id: 3,
        }}
        language="de"
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByText("Angebotsphase")).toBeInTheDocument();
  });
});

describe("the project overview's open tasks", () => {
  const PROJECT: Project = { id: 12, project_number: "2026-0412", name: "Umbau", status: "in_durchfuehrung" };
  const TASKS: Task[] = [
    { id: 1, project_id: 12, title: "Schlitze fräsen", status: "open", task_type: "construction" },
    { id: 2, project_id: 12, title: "Angebot schreiben", status: "open", task_type: "office" },
    { id: 3, project_id: 12, title: "Termin vor Ort", status: "open", task_type: "customer_appointment" },
  ];

  it("name the task type in German", () => {
    const { container } = render(
      <AppContext.Provider
        value={
          makeAppContextStub({
            overrides: {
              mainView: "project",
              projectTab: "overview",
              language: "de",
              activeProject: PROJECT,
              projectOverviewOpenTasks: TASKS,
              getTaskAssigneeLabel: () => "-",
            },
          }) as never
        }
      >
        <ProjectOverviewTab />
      </AppContext.Provider>,
    );
    const types = [...container.querySelectorAll(".project-overview-task-type")].map((node) => node.textContent);
    expect(types).toEqual(["Baustellenaufgabe", "Büroaufgabe", "Kundentermin"]);
  });
});

describe("the Zeiterfassung day dialog's activity", () => {
  it("names the task status in German", async () => {
    apiFetchMock.mockResolvedValue({
      user_id: 1,
      day: "2026-10-12",
      tasks: [
        {
          id: 5,
          title: "Zählerschrank setzen",
          status: "in_progress",
          task_type: "construction",
          project_id: null,
          project_number: null,
          project_name: null,
          customer_id: null,
          customer_name: null,
        },
      ],
      reports: [],
    });
    render(
      <AppContext.Provider value={makeAppContextStub({ overrides: { language: "de" } }) as never}>
        <DayActivityPanel day="2026-10-12" userId={1} />
      </AppContext.Provider>,
    );
    expect(await screen.findByText("In Arbeit")).toBeInTheDocument();
    expect(screen.queryByText("in_progress")).toBeNull();
  });
});
