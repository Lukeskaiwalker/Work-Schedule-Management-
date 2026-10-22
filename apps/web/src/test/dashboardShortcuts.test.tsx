/**
 * „Schnellzugriff“ on the start page and its tile editor („Kacheln wählen“)
 * (docs/DASHBOARD.md §1, §1.1, §5, §8.2, §9.5; part W5).
 *
 * The widget reads only the app context — no request of its own. What must
 * hold: a tile never offers a page the sidebar hides in the current mode, a
 * widget without a choice shows the preset for the mode and the device, the
 * two badges count what they say (open own tasks, unread messages), and the
 * editor can neither go past 12 tiles nor down to none.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";

import { AppContext, type AppContextValue } from "../context/AppContext";
import ShortcutsSettingsEditor from "../components/dashboard/widgets/shortcuts/ShortcutsSettingsEditor";
import ShortcutsWidget from "../components/dashboard/widgets/shortcuts/ShortcutsWidget";
import {
  SHORTCUTS_SETTINGS_EDITOR_LOADER,
  SHORTCUT_WIDGET_LOADERS,
} from "../components/dashboard/widgets/shortcuts";
import {
  SHORTCUT_PRESETS,
  countOpenOwnTasks,
  shortcutPreset,
  sumUnreadMessages,
  toggleShortcutView,
} from "../components/dashboard/widgets/shortcuts/shortcutTiles";
import type { DashboardDevice, DashboardShortcutView, DashboardWidgetSettings, DashboardWidgetSize } from "../types/dashboard";
import { DASHBOARD_SHORTCUT_VIEWS } from "../types/dashboard";
import type { MainView, Task, Thread, WorkspaceMode } from "../types";
import { makeAppContextStub } from "./appContextStub";

const CONSTRUCTION_NAV: MainView[] = [
  "overview", "projects_all", "customers", "my_tasks", "calendar", "planning", "construction",
  "schaltplan", "reports", "materials", "werkstatt", "wiki", "messages", "time", "profile",
];
const OFFICE_NAV: MainView[] = [
  "overview", "projects_all", "projects_map", "customers", "office_tasks", "calendar", "planning",
  "construction", "reports", "materials", "werkstatt", "wiki", "messages", "time", "profile",
];

const ME = 1;

function task(id: number, fields: Partial<Task>): Task {
  return { id, title: `Aufgabe ${id}`, status: "open", assignee_ids: [], ...fields } as Task;
}

function thread(id: number, unread: number): Thread {
  return { id, name: `Chat ${id}`, message_count: 10, unread_count: unread } as Thread;
}

function setup({
  mode = "construction",
  device = "desktop",
  size = "large",
  settings = null,
  tasks = [],
  threads = [],
}: {
  mode?: WorkspaceMode;
  device?: DashboardDevice;
  size?: DashboardWidgetSize;
  settings?: DashboardWidgetSettings | null;
  tasks?: Task[];
  threads?: Thread[];
} = {}) {
  const calls: string[] = [];
  const record = (name: string) =>
    vi.fn((...args: unknown[]) => calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(",")})`));
  const context = makeAppContextStub({
    overrides: {
      workspaceMode: mode,
      navViews: mode === "office" ? OFFICE_NAV : CONSTRUCTION_NAV,
      user: { id: ME, email: "monteur@example.com", role: "employee" },
      tasks,
      threads,
      setProjectBackView: record("setProjectBackView"),
      setOverviewShortcutBackVisible: record("setOverviewShortcutBackVisible"),
      setConstructionBackView: record("setConstructionBackView"),
      setMainView: record("setMainView"),
    },
  }) as AppContextValue;
  const view = render(
    <AppContext.Provider value={context}>
      <ShortcutsWidget size={size} settings={settings} device={device} />
    </AppContext.Provider>,
  );
  return { calls, ...view };
}

function tileLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".dashboard-shortcuts__label")).map((node) => node.textContent ?? "");
}

afterEach(() => vi.restoreAllMocks());

describe("presets (§5)", () => {
  it("are the four tile sets of the contract, without the retired materials view", () => {
    expect(SHORTCUT_PRESETS.FIELD).toEqual(["my_tasks", "planning", "construction", "werkstatt", "messages", "time", "wiki"]);
    expect(SHORTCUT_PRESETS.OFFICE).toEqual(["my_tasks", "planning", "projects_all", "customers", "calendar", "messages", "time", "wiki"]);
    expect(SHORTCUT_PRESETS.M_FIELD).toEqual(["construction", "planning", "messages", "wiki"]);
    expect(SHORTCUT_PRESETS.M_OFFICE).toEqual(["planning", "projects_all", "customers", "messages"]);
    for (const preset of Object.values(SHORTCUT_PRESETS)) {
      for (const view of preset) expect(DASHBOARD_SHORTCUT_VIEWS).toContain(view);
    }
  });

  it("are picked by workspace mode, and by phone or not", () => {
    expect(shortcutPreset("construction", "desktop")).toEqual(SHORTCUT_PRESETS.FIELD);
    expect(shortcutPreset("construction", "tablet")).toEqual(SHORTCUT_PRESETS.FIELD);
    expect(shortcutPreset("office", "desktop")).toEqual(SHORTCUT_PRESETS.OFFICE);
    expect(shortcutPreset("construction", "mobile")).toEqual(SHORTCUT_PRESETS.M_FIELD);
    expect(shortcutPreset("office", "mobile")).toEqual(SHORTCUT_PRESETS.M_OFFICE);
  });
});

describe("ShortcutsWidget", () => {
  it("shows the mode and device preset when nothing was chosen", () => {
    expect(tileLabels(setup({ mode: "construction", device: "desktop" }).container)).toEqual([
      "Meine Aufgaben", "Planung", "Bericht", "Werkstatt", "Nachrichten", "Zeit", "Wiki",
    ]);
  });

  it("shows the office preset in Büro mode", () => {
    expect(tileLabels(setup({ mode: "office", device: "tablet" }).container)).toEqual([
      "Meine Aufgaben", "Planung", "Projekte", "Kunden", "Kalender", "Nachrichten", "Zeit", "Wiki",
    ]);
  });

  it("shows the phone presets on a phone", () => {
    expect(tileLabels(setup({ mode: "construction", device: "mobile" }).container)).toEqual([
      "Bericht", "Planung", "Nachrichten", "Wiki",
    ]);
    expect(tileLabels(setup({ mode: "office", device: "mobile" }).container)).toEqual([
      "Planung", "Projekte", "Kunden", "Nachrichten",
    ]);
  });

  it("shows the chosen tiles in their order and hides those the sidebar hides in this mode", () => {
    const chosen: DashboardWidgetSettings = { views: ["schaltplan", "time", "projects_map", "ausbildung", "planning"] };

    // Ausbildung is not in either nav here (no apprentice, no trainer).
    expect(tileLabels(setup({ mode: "construction", settings: chosen }).container)).toEqual([
      "Verteilerpläne", "Zeit", "Planung",
    ]);
    expect(tileLabels(setup({ mode: "office", settings: chosen }).container)).toEqual([
      "Zeit", "Karte", "Planung",
    ]);
  });

  it("falls back to the preset when not one chosen tile is offered in this mode", () => {
    const officeOnly: DashboardWidgetSettings = { views: ["projects_map"] };

    expect(tileLabels(setup({ mode: "construction", device: "mobile", settings: officeOnly }).container)).toEqual([
      "Bericht", "Planung", "Nachrichten", "Wiki",
    ]);
  });

  it("counts open own tasks on „Meine Aufgaben“ and sums unread messages on „Nachrichten“", () => {
    const tasks = [
      task(1, { assignee_ids: [ME], status: "open" }),
      task(2, { assignee_ids: [ME], status: "done" }),
      task(3, { assignee_ids: [2], status: "open" }),
      // A legacy row with only the single assignee field still counts.
      task(4, { assignee_ids: [], assignee_id: ME, status: "in_progress" }),
      task(5, { assignee_ids: [ME, 3], status: "Erledigt" }),
      task(6, { assignee_ids: [ME, 3], status: "on_hold" }),
    ];
    const threads = [thread(1, 2), thread(2, 0), thread(3, 5)];

    setup({ tasks, threads });

    const myTasks = screen.getByRole("button", { name: "Meine Aufgaben, 3 offen" });
    expect(within(myTasks).getByText("3")).toBeInTheDocument();
    const messages = screen.getByRole("button", { name: "Nachrichten, 7 ungelesen" });
    expect(within(messages).getByText("7")).toBeInTheDocument();
  });

  it("shows no badge at zero", () => {
    setup({ tasks: [task(1, { assignee_ids: [ME], status: "done" })], threads: [thread(1, 0)] });

    expect(screen.getByRole("button", { name: "Meine Aufgaben" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nachrichten" })).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("is a compact list at Klein and a tile grid at Mittel and Groß", () => {
    expect(setup({ size: "small" }).container.querySelector(".dashboard-shortcuts--list")).not.toBeNull();
    for (const size of ["medium", "large"] as const) {
      const { container, unmount } = setup({ size });
      expect(container.querySelector(".dashboard-shortcuts--grid")).not.toBeNull();
      expect(container.querySelector(".dashboard-shortcuts--list")).toBeNull();
      unmount();
    }
  });

  it("opens a tile through the shortcut sequence, and „Meine Aufgaben“ as the office list in Büro mode", () => {
    const { calls } = setup({ mode: "office" });

    fireEvent.click(screen.getByRole("button", { name: "Meine Aufgaben" }));

    expect(calls).toEqual([
      "setProjectBackView(null)",
      "setOverviewShortcutBackVisible(true)",
      "setConstructionBackView(null)",
      'setMainView("office_tasks")',
    ]);
  });
});

describe("badge counts", () => {
  it("count nothing without a user", () => {
    expect(countOpenOwnTasks([task(1, { assignee_ids: [ME] })], null)).toBe(0);
  });

  it("sum unread_count over every chat", () => {
    expect(sumUnreadMessages([thread(1, 1), thread(2, 4)])).toBe(5);
    expect(sumUnreadMessages([])).toBe(0);
  });
});

describe("toggleShortcutView", () => {
  it("appends a new view, removes a ticked one, and never touches its input", () => {
    const views: DashboardShortcutView[] = ["planning", "wiki"];
    const before = [...views];

    expect(toggleShortcutView(views, "time")).toEqual(["planning", "wiki", "time"]);
    expect(toggleShortcutView(views, "planning")).toEqual(["wiki"]);
    expect(views).toEqual(before);
  });

  it("keeps the last view and refuses a thirteenth", () => {
    expect(toggleShortcutView(["wiki"], "wiki")).toEqual(["wiki"]);
    const twelve = DASHBOARD_SHORTCUT_VIEWS.slice(0, 12);
    expect(toggleShortcutView(twelve, DASHBOARD_SHORTCUT_VIEWS[12])).toEqual(twelve);
  });
});

function EditorHarness({
  initial,
  onChange,
  mode = "construction",
  device = "desktop",
}: {
  initial: DashboardWidgetSettings | null;
  onChange: (next: DashboardWidgetSettings) => void;
  mode?: WorkspaceMode;
  device?: DashboardDevice;
}) {
  const [settings, setSettings] = useState(initial);
  const context = makeAppContextStub({ overrides: { workspaceMode: mode } }) as AppContextValue;
  return (
    <AppContext.Provider value={context}>
      <ShortcutsSettingsEditor
        settings={settings}
        device={device}
        language="de"
        onChange={(next) => {
          onChange(next);
          setSettings(next);
        }}
      />
    </AppContext.Provider>
  );
}

function checkedLabels(): string[] {
  return screen
    .getAllByRole("checkbox")
    .filter((box) => (box as HTMLInputElement).checked)
    .map((box) => box.getAttribute("aria-label") ?? box.closest("label")?.querySelector(".dashboard-shortcuts-editor__name")?.textContent ?? "");
}

describe("ShortcutsSettingsEditor („Kacheln wählen“)", () => {
  // The editor's placeholder tile owns the „Kacheln wählen“ button that
  // reveals this (DashboardEditor); a second toggle in here would be a fold
  // inside a fold.
  it("is the group „Kacheln wählen“: all 14 views, the mode hints and the limit", () => {
    render(<EditorHarness initial={null} onChange={() => undefined} />);

    const group = screen.getByRole("group", { name: "Kacheln wählen" });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(14);
    expect(screen.queryByRole("button")).toBeNull();
    expect(within(group).getByText("7 von 12")).toBeInTheDocument();
    expect(screen.getByText("Höchstens 12 Kacheln.")).toBeInTheDocument();
    const row = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}`) }).closest("label") as HTMLElement;
    expect(within(row("Verteilerpläne")).getByText("nur Baustelle")).toBeInTheDocument();
    expect(within(row("Ausbildung")).getByText("nur Baustelle")).toBeInTheDocument();
    expect(within(row("Karte")).getByText("nur Büro")).toBeInTheDocument();
    expect(within(row("Planung")).queryByText(/nur /)).toBeNull();
  });

  it("starts from the preset when nothing was chosen, and saves the full list on the first change", () => {
    const onChange = vi.fn();
    render(<EditorHarness initial={null} onChange={onChange} mode="office" device="mobile" />);

    // The checklist keeps one fixed order; what the user sees is which are ticked.
    expect(checkedLabels().sort()).toEqual(["Kunden", "Nachrichten", "Planung", "Projekte"]);

    fireEvent.click(screen.getByRole("checkbox", { name: /^Zeit/ }));

    expect(onChange).toHaveBeenLastCalledWith({ views: ["planning", "projects_all", "customers", "messages", "time"] });
  });

  it("removes an unticked view", () => {
    const onChange = vi.fn();
    render(<EditorHarness initial={{ views: ["wiki", "time", "planning"] }} onChange={onChange} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /^Zeit/ }));

    expect(onChange).toHaveBeenLastCalledWith({ views: ["wiki", "planning"] });
  });

  it("keeps at least one tile: the last ticked box cannot be unticked", () => {
    const onChange = vi.fn();
    render(<EditorHarness initial={{ views: ["wiki"] }} onChange={onChange} />);

    const wiki = screen.getByRole("checkbox", { name: /^Wiki/ });
    expect(wiki).toBeChecked();
    expect(wiki).toBeDisabled();
    fireEvent.click(wiki);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("caps at 12: with twelve ticked, the other boxes are disabled", () => {
    const onChange = vi.fn();
    const twelve = DASHBOARD_SHORTCUT_VIEWS.slice(0, 12);
    render(<EditorHarness initial={{ views: [...twelve] }} onChange={onChange} />);

    const unticked = screen.getAllByRole("checkbox").filter((box) => !(box as HTMLInputElement).checked);
    expect(unticked).toHaveLength(2);
    unticked.forEach((box) => expect(box).toBeDisabled());
    screen
      .getAllByRole("checkbox")
      .filter((box) => (box as HTMLInputElement).checked)
      .forEach((box) => expect(box).toBeEnabled());
  });
});

describe("group loaders", () => {
  it("load the widget and the settings editor lazily", async () => {
    expect(Object.keys(SHORTCUT_WIDGET_LOADERS)).toEqual(["shortcuts"]);
    const widget = await SHORTCUT_WIDGET_LOADERS.shortcuts!();
    expect(widget.default).toBe(ShortcutsWidget);
    expect(SHORTCUTS_SETTINGS_EDITOR_LOADER).not.toBeNull();
    const editor = await SHORTCUTS_SETTINGS_EDITOR_LOADER!();
    expect(editor.default).toBe(ShortcutsSettingsEditor);
  });
});
