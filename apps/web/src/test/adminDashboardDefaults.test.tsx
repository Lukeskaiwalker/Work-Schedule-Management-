/**
 * The admin tab „Startseiten“: the start page each role begins with, per
 * device (docs/DASHBOARD.md §8.6, §12 W6).
 *
 * The editor itself is W1's DashboardEditor and is replaced here by a stand-in
 * that prints what it was handed (device, widgets, which ones are marked
 * hidden) and offers two buttons that change the draft. What this file holds
 * the panel to is everything around it: which layout is on show, the preview
 * frame's width, the PUT and DELETE it sends, the question before a switch
 * would throw away unsaved changes, and that the tab is there only for
 * `settings:manage`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { AppContext } from "../context/AppContext";
import { makeAppContextStub } from "./appContextStub";
import { AdminDashboardDefaultsPanel } from "../components/admin/AdminDashboardDefaultsPanel";
import { auditTargetLabel } from "../components/admin/auditLabels";
import { DASHBOARD_WIDGET_META } from "../components/dashboard/widgetMeta";
import { AdminPage } from "../pages/AdminPage";
import {
  DASHBOARD_WIDGET_IDS,
  type DashboardDevice,
  type DashboardRoleDefault,
  type DashboardRoleDefaults,
  type DashboardWidgetId,
  type DashboardWidgetItem,
  type DashboardWidgetSize,
} from "../types/dashboard";

type FakeEditorProps = {
  device: DashboardDevice;
  widgets: DashboardWidgetItem[];
  onChange: (next: DashboardWidgetItem[]) => void;
  availableIds: readonly DashboardWidgetId[];
  defaultSizes: Readonly<Record<DashboardWidgetId, DashboardWidgetSize>>;
  hiddenIds?: ReadonlySet<DashboardWidgetId>;
  language: string;
};

vi.mock("../components/dashboard/DashboardEditor", () => ({
  DashboardEditor: (props: FakeEditorProps) => (
    <div data-testid="dashboard-editor" data-device={props.device} data-language={props.language}>
      <ul>
        {props.widgets.map((widget) => (
          <li key={widget.id} data-testid="editor-widget" data-size={widget.size}>
            {widget.id}
            {props.hiddenIds?.has(widget.id) ? " (hidden)" : ""}
          </li>
        ))}
      </ul>
      <span data-testid="editor-available">{props.availableIds.join(",")}</span>
      <button type="button" onClick={() => props.onChange(props.widgets.slice(1))}>
        fake: remove first
      </button>
      <button
        type="button"
        onClick={() =>
          props.onChange([
            ...props.widgets,
            { id: "vacation_approvals", size: props.defaultSizes.vacation_approvals },
          ])
        }
      >
        fake: add vacation_approvals
      </button>
    </div>
  ),
}));

const ROLES = ["admin", "ceo", "accountant", "planning", "employee"];
const DEVICES: DashboardDevice[] = ["mobile", "tablet", "desktop"];

function entry(
  role: string,
  device: DashboardDevice,
  widgets: DashboardWidgetItem[],
  extra: Partial<DashboardRoleDefault> = {},
): DashboardRoleDefault {
  return { role, device, widgets, source: "builtin", hidden_for_role: [], updated_at: null, ...extra };
}

/** Invented layouts; only the ones a test looks at differ from the filler. */
const SPECIAL: Record<string, DashboardRoleDefault> = {
  "admin:desktop": entry("admin", "desktop", [
    { id: "shortcuts", size: "large", settings: { views: ["my_tasks", "planning"] } },
    { id: "clocked_in", size: "small" },
  ]),
  "admin:tablet": entry("admin", "tablet", [{ id: "werkstatt_kpis", size: "medium" }]),
  "planning:tablet": entry("planning", "tablet", [
    { id: "planning_today", size: "medium" },
    { id: "absent_today", size: "small" },
  ]),
  "employee:mobile": entry("employee", "mobile", [{ id: "vacation_approvals", size: "medium" }], {
    hidden_for_role: ["vacation_approvals"],
  }),
  "employee:desktop": entry(
    "employee",
    "desktop",
    [
      { id: "my_tasks", size: "medium" },
      { id: "clocked_in", size: "small" },
    ],
    { source: "role", hidden_for_role: ["clocked_in"], updated_at: "2026-10-20T07:00:00Z" },
  ),
};

function roleDefaults(): DashboardRoleDefaults {
  return {
    catalog: DASHBOARD_WIDGET_IDS.map((id) => ({
      id,
      group: DASHBOARD_WIDGET_META[id].group,
      default_size: id === "shortcuts" ? "large" : id === "vacation_approvals" ? "small" : "medium",
      requires: [],
    })),
    roles: ROLES,
    defaults: ROLES.flatMap((role) =>
      DEVICES.map((device) => SPECIAL[`${role}:${device}`] ?? entry(role, device, [{ id: "notifications", size: "small" }])),
    ),
  };
}

type Call = { url: string; method: string; body: unknown };
type Answer = { status?: number; body: unknown };

/** Stubs fetch; GET answers the role defaults unless `answer` says otherwise. */
function stubFetch(answer: (call: Call) => Answer | undefined | Promise<Answer> = () => undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const given = await answer(call);
      const { status = 200, body } =
        given ?? (call.method === "GET" ? { body: roleDefaults() } : { status: 500, body: { detail: "unexpected" } });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

function withContext(node: JSX.Element, overrides: Record<string, unknown> = {}) {
  const value = makeAppContextStub({ overrides: { token: "admin-token", ...overrides } });
  return <AppContext.Provider value={value as never}>{node}</AppContext.Provider>;
}

async function renderPanel(overrides: Record<string, unknown> = {}) {
  const view = render(withContext(<AdminDashboardDefaultsPanel />, overrides));
  await screen.findByTestId("dashboard-editor");
  return view;
}

/** The tsconfig lib predates Array.prototype.at. */
function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}

function editorIds(): string[] {
  return screen.getAllByTestId("editor-widget").map((row) => row.textContent ?? "");
}

function choose(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function previewFrame(container: HTMLElement): HTMLElement {
  const frame = container.querySelector<HTMLElement>(".admin-dashboard-preview");
  if (!frame) throw new Error("no preview frame");
  return frame;
}

beforeEach(() => {
  // AdminPage's tab strip scrolls the chosen tab into view; jsdom has no scrollTo.
  (HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
});

describe("AdminDashboardDefaultsPanel", () => {
  it("loads the role defaults and shows the first role's desktop layout", async () => {
    const calls = stubFetch();
    await renderPanel();

    expect(calls).toEqual([{ url: "/api/dashboard/role-defaults", method: "GET", body: null }]);
    expect(screen.getByRole("heading", { name: "Standard-Startseiten je Rolle" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Neue und zurückgesetzte Startseiten beginnen mit diesem Stand. Wer seine Startseite schon angepasst hat, behält sie.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Rolle")).toHaveValue("admin");
    expect(screen.getByLabelText("Gerät")).toHaveValue("desktop");
    expect(editorIds()).toEqual(["shortcuts", "clocked_in"]);
    expect(screen.getByText("Werkseinstellung")).toBeInTheDocument();
    // Every catalog widget may be placed for a role; the ones it cannot see are marked, not withheld.
    expect(screen.getByTestId("editor-available")).toHaveTextContent(DASHBOARD_WIDGET_IDS.join(","));
    expect(screen.getByTestId("dashboard-editor")).toHaveAttribute("data-language", "de");
  });

  it("labels roles and devices the way people read them", async () => {
    stubFetch();
    await renderPanel();

    const roles = within(screen.getByLabelText("Rolle")).getAllByRole("option");
    expect(roles.map((option) => option.textContent)).toEqual([
      "Admin",
      "Geschäftsführung",
      "Buchhaltung",
      "Planung",
      "Mitarbeiter",
    ]);
    const devices = within(screen.getByLabelText("Gerät")).getAllByRole("option");
    expect(devices.map((option) => option.textContent)).toEqual(["Handy", "Tablet", "Desktop"]);
  });

  it("shows the chosen role's and device's layout on a clean switch, without asking", async () => {
    stubFetch();
    await renderPanel();

    choose("Rolle", "employee");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Rolle")).toHaveValue("employee");
    expect(editorIds()).toEqual(["my_tasks", "clocked_in (hidden)"]);
    expect(screen.getByText("Angepasst")).toBeInTheDocument();

    choose("Gerät", "mobile");
    expect(screen.getByLabelText("Gerät")).toHaveValue("mobile");
    expect(editorIds()).toEqual(["vacation_approvals (hidden)"]);
    expect(screen.getByText("Werkseinstellung")).toBeInTheDocument();
  });

  it("asks before a switch would throw away unsaved changes", async () => {
    stubFetch();
    await renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "fake: remove first" }));
    expect(editorIds()).toEqual(["clocked_in"]);

    choose("Rolle", "planning");
    const dialog = screen.getByRole("dialog", { name: "Ungespeicherte Änderungen verwerfen?" });
    // Nothing has moved yet: the select and the draft wait for the answer.
    expect(screen.getByLabelText("Rolle")).toHaveValue("admin");
    expect(editorIds()).toEqual(["clocked_in"]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Rolle")).toHaveValue("admin");
    expect(editorIds()).toEqual(["clocked_in"]);

    choose("Gerät", "tablet");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Ungespeicherte Änderungen verwerfen?" })).getByRole("button", {
        name: "Verwerfen",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Rolle")).toHaveValue("admin");
    expect(screen.getByLabelText("Gerät")).toHaveValue("tablet");
    expect(editorIds()).toEqual(["werkstatt_kpis"]);
  });

  it("previews each device in a frame of that device's width", async () => {
    stubFetch();
    const { container } = await renderPanel();

    const expected: [DashboardDevice, string][] = [
      ["mobile", "390px"],
      ["tablet", "820px"],
      ["desktop", "1280px"],
    ];
    for (const [device, width] of expected) {
      choose("Gerät", device);
      const frame = previewFrame(container);
      expect(frame).toHaveAttribute("data-device", device);
      expect(frame.style.width).toBe(width);
      // The editor's columns follow the device, never the admin's own screen (D10).
      expect(within(frame).getByTestId("dashboard-editor")).toHaveAttribute("data-device", device);
    }
    // The frame scrolls sideways inside its own container: the page root clips.
    const scroller = previewFrame(container).parentElement;
    expect(scroller).toHaveClass("admin-dashboard-preview-scroll");
    expect(scroller?.style.overflowX).toBe("auto");
  });

  it("„Speichern“ sends a PUT for the chosen role and device", async () => {
    const saved = entry("planning", "tablet", [{ id: "absent_today", size: "small" }], {
      source: "role",
      updated_at: "2026-10-21T09:00:00Z",
    });
    const calls = stubFetch((call) => (call.method === "PUT" ? { body: saved } : undefined));
    await renderPanel();
    choose("Rolle", "planning");
    choose("Gerät", "tablet");

    const save = screen.getByRole("button", { name: "Speichern" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "fake: remove first" }));
    expect(save).toBeEnabled();
    fireEvent.click(save);

    expect(await screen.findByText("Gespeichert.")).toBeInTheDocument();
    expect(last(calls)).toEqual({
      url: "/api/dashboard/role-defaults/planning/tablet",
      method: "PUT",
      body: { version: 1, widgets: [{ id: "absent_today", size: "small" }] },
    });
    expect(screen.getByText("Angepasst")).toBeInTheDocument();
    expect(editorIds()).toEqual(["absent_today"]);
    // The saved state is the new baseline: nothing left to save, and a switch does not ask.
    expect(save).toBeDisabled();
    choose("Gerät", "desktop");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the draft and says so when the save fails", async () => {
    stubFetch((call) => (call.method === "PUT" ? { status: 500, body: { detail: "boom" } } : undefined));
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "fake: remove first" }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByText("Konnte nicht gespeichert werden.")).toBeInTheDocument();
    expect(editorIds()).toEqual(["clocked_in"]);
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    expect(screen.getByText("Werkseinstellung")).toBeInTheDocument();
  });

  it("keeps a change made while the save was on its way", async () => {
    let release: (answer: Answer) => void = () => undefined;
    const saved = entry("admin", "desktop", [{ id: "clocked_in", size: "small" }], { source: "role" });
    const calls = stubFetch((call) =>
      call.method === "PUT"
        ? new Promise<Answer>((resolve) => {
            release = resolve;
          })
        : undefined,
    );
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "fake: remove first" }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "fake: add vacation_approvals" }));
    release({ body: saved });

    expect(await screen.findByText("Gespeichert.")).toBeInTheDocument();
    expect(screen.getByText("Angepasst")).toBeInTheDocument();
    // Still a draft against the new baseline, so still something to save.
    expect(editorIds()).toEqual(["clocked_in", "vacation_approvals"]);
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
  });

  it("adds the server's reason when it refuses the layout", async () => {
    stubFetch((call) =>
      call.method === "PUT"
        ? {
            status: 422,
            body: { detail: { code: "unknown_widget", message: "Widget „weather“ gibt es nicht.", ids: ["weather"] } },
          }
        : undefined,
    );
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "fake: remove first" }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    // The live region is always there (so the answer is announced); its text arrives with the answer.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Konnte nicht gespeichert werden. Widget „weather“ gibt es nicht.",
      ),
    );
  });

  it("„Auf Werkseinstellung zurücksetzen“ sends a DELETE and shows the factory layout", async () => {
    const factory = entry("employee", "desktop", [
      { id: "my_status", size: "small" },
      { id: "my_tasks", size: "medium" },
    ]);
    const calls = stubFetch((call) => (call.method === "DELETE" ? { body: factory } : undefined));
    await renderPanel();

    // A built-in default has nothing stored to reset.
    expect(screen.getByRole("button", { name: "Auf Werkseinstellung zurücksetzen" })).toBeDisabled();

    choose("Rolle", "employee");
    const reset = screen.getByRole("button", { name: "Auf Werkseinstellung zurücksetzen" });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    await waitFor(() => expect(screen.getByText("Werkseinstellung")).toBeInTheDocument());
    expect(last(calls)).toEqual({ url: "/api/dashboard/role-defaults/employee/desktop", method: "DELETE", body: null });
    expect(editorIds()).toEqual(["my_status", "my_tasks"]);
    expect(reset).toBeDisabled();
  });

  it("marks the widgets this role cannot see, wherever the server said so for that role", async () => {
    stubFetch();
    await renderPanel();
    choose("Rolle", "employee");

    expect(editorIds()).toEqual(["my_tasks", "clocked_in (hidden)"]);
    // Hidden is per role, not per device: the phone default already told us
    // the employee cannot see the approvals, so a new tile is marked at once.
    fireEvent.click(screen.getByRole("button", { name: "fake: add vacation_approvals" }));
    expect(editorIds()).toEqual(["my_tasks", "clocked_in (hidden)", "vacation_approvals (hidden)"]);
    expect(last(screen.getAllByTestId("editor-widget"))).toHaveAttribute("data-size", "small");
  });

  it("offers a retry when the defaults cannot be loaded", async () => {
    let failures = 1;
    const calls = stubFetch((call) => {
      if (call.method !== "GET" || failures === 0) return undefined;
      failures -= 1;
      return { status: 500, body: { detail: "down" } };
    });
    render(withContext(<AdminDashboardDefaultsPanel />));

    expect(await screen.findByText("Standard-Startseiten konnten nicht geladen werden.")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-editor")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByTestId("dashboard-editor")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it("speaks English in the English UI", async () => {
    stubFetch();
    await renderPanel({ language: "en" });

    expect(screen.getByRole("heading", { name: "Default start pages per role" })).toBeInTheDocument();
    expect(screen.getByLabelText("Role")).toHaveValue("admin");
    const devices = within(screen.getByLabelText("Device")).getAllByRole("option");
    expect(devices.map((option) => option.textContent)).toEqual(["Phone", "Tablet", "Desktop"]);
    expect(screen.getByText("Factory default")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-editor")).toHaveAttribute("data-language", "en");
  });
});

describe("Verwaltungszentrum tab „Startseiten“", () => {
  function adminPage(overrides: Record<string, unknown>) {
    return withContext(<AdminPage />, {
      mainView: "admin",
      activeAdminUsers: [],
      archivedAdminUsers: [],
      adminUsersById: new Map(),
      userPermissionOverrides: {},
      requiredHoursDrafts: {},
      vacationBalanceDrafts: {},
      ...overrides,
    });
  }

  function tabNames(): string[] {
    const strip = screen.getByRole("tablist", { name: "Verwaltungsbereiche" });
    return within(strip)
      .getAllByRole("tab")
      .map((tab) => tab.textContent ?? "");
  }

  it("is absent without canManageSettings", () => {
    stubFetch();
    render(adminPage({ canManageUsers: true, canManageSettings: false }));
    expect(tabNames()).not.toContain("Startseiten");
  });

  it("follows Einstellungen with canManageSettings and mounts the panel only when opened", async () => {
    const calls = stubFetch();
    render(adminPage({ canManageUsers: true, canManageSettings: true }));

    expect(tabNames()).toEqual(["Benutzer", "Gruppen", "Einstellungen", "Startseiten"]);
    expect(calls.some((call) => call.url.startsWith("/api/dashboard"))).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: "Startseiten" }));
    const panel = screen.getByRole("tabpanel", { name: "Startseiten" });
    expect(await within(panel).findByRole("heading", { name: "Standard-Startseiten je Rolle" })).toBeInTheDocument();
    expect(await within(panel).findByTestId("dashboard-editor")).toBeInTheDocument();
  });

  it("is called „Start pages“ in the English UI", () => {
    stubFetch();
    // Users first, so the strip opens on a tab the stub context can render.
    render(adminPage({ canManageUsers: true, canManageSettings: true, language: "en" }));
    const strip = screen.getByRole("tablist", { name: "Admin sections" });
    expect(within(strip).getAllByRole("tab").map((tab) => tab.textContent)).toContain("Start pages");
  });
});

describe("audit target label", () => {
  it("names a role-default change „Standard-Startseite“", () => {
    expect(auditTargetLabel("dashboard_default", true)).toBe("Standard-Startseite");
    expect(auditTargetLabel("dashboard_default", false)).toBe("Default start page");
  });
});
