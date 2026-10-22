/**
 * The start-page editor (docs/DASHBOARD.md §8.2, §8.3, §11.2).
 *
 * It is controlled: every control turns the current widgets into a new list
 * through `onChange`, and the caller owns saving. Users and admins share it
 * (W6 renders it in the role-default tab), so everything here is about the
 * controls themselves. Dragging is the dnd-kit path and needs real layout;
 * the move buttons are the reliable, testable path to the same result.
 */
import { lazy, useState, type ComponentType, type LazyExoticComponent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { DashboardSettingsEditorProps } from "../components/dashboard/widgetTypes";

// The shortcuts' settings editor is W5's; a stand-in shows the editor wires it.
type SettingsEditor = ComponentType<DashboardSettingsEditorProps>;
const registry = vi.hoisted(() => ({
  settingsEditor: null as SettingsEditor | LazyExoticComponent<SettingsEditor> | null,
}));

vi.mock("../components/dashboard/widgetRegistry", () => ({
  getLazyWidget: () => null,
  getLazySettingsEditor: (id: string) => (id === "shortcuts" ? registry.settingsEditor : null),
}));

import { AppContext, type AppContextValue } from "../context/AppContext";
import { DashboardEditor } from "../components/dashboard/DashboardEditor";
import type {
  DashboardDevice,
  DashboardWidgetId,
  DashboardWidgetItem,
  DashboardWidgetSize,
} from "../types/dashboard";
import { DASHBOARD_WIDGET_IDS } from "../types/dashboard";
import { makeAppContextStub } from "./appContextStub";

const START: DashboardWidgetItem[] = [
  { id: "my_status", size: "medium" },
  { id: "my_tasks", size: "small" },
  { id: "notifications", size: "large" },
];

const DEFAULT_SIZES = Object.fromEntries(
  DASHBOARD_WIDGET_IDS.map((id) => [id, id === "shortcuts" ? "large" : "medium"]),
) as Record<DashboardWidgetId, DashboardWidgetSize>;

type Options = {
  device?: DashboardDevice;
  widgets?: DashboardWidgetItem[];
  availableIds?: DashboardWidgetId[];
  hiddenIds?: Set<DashboardWidgetId>;
};

/** A stateful parent, as the host and the admin tab are: onChange feeds back in. */
function renderEditor(options: Options = {}) {
  const changes: DashboardWidgetItem[][] = [];
  function Parent() {
    const [widgets, setWidgets] = useState(options.widgets ?? START);
    return (
      <DashboardEditor
        device={options.device ?? "desktop"}
        widgets={widgets}
        onChange={(next) => {
          changes.push(next);
          setWidgets(next);
        }}
        availableIds={options.availableIds ?? ["shortcuts", "my_status", "my_tasks", "notifications", "werkstatt_kpis"]}
        defaultSizes={DEFAULT_SIZES}
        hiddenIds={options.hiddenIds}
        language="de"
      />
    );
  }
  const context = makeAppContextStub({ overrides: { language: "de" } }) as AppContextValue;
  render(
    <AppContext.Provider value={context}>
      <Parent />
    </AppContext.Provider>,
  );
  return { changes, last: (): DashboardWidgetItem[] | undefined => changes[changes.length - 1] };
}

const tile = (title: string) => screen.getByRole("group", { name: title });
const tileOrder = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-widget-id]")).map((node) => node.dataset.widgetId);

afterEach(() => {
  registry.settingsEditor = null;
  vi.restoreAllMocks();
});

describe("DashboardEditor — moving", () => {
  it("moves with the buttons, announces the new position, and disables them at the ends", () => {
    const { last } = renderEditor();

    expect(screen.getByRole("button", { name: "„Mein Status“ nach vorne verschieben" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "„Benachrichtigungen“ nach hinten verschieben" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ nach hinten verschieben" }));

    expect(last()?.map((item) => item.id)).toEqual(["my_tasks", "my_status", "notifications"]);
    expect(tileOrder()).toEqual(["my_tasks", "my_status", "notifications"]);
    expect(screen.getByText("„Mein Status“ ist jetzt an Position 2 von 3.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "„Meine Aufgaben“ nach vorne verschieben" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "„Mein Status“ nach vorne verschieben" })).toBeEnabled();
  });

  it("reads „Nach vorne“ / „Nach hinten“ on tablet and desktop", () => {
    renderEditor({ device: "tablet" });
    expect(within(tile("Mein Status")).getByRole("button", { name: /nach vorne verschieben/ })).toHaveTextContent("Nach vorne");
    expect(within(tile("Mein Status")).getByRole("button", { name: /nach hinten verschieben/ })).toHaveTextContent("Nach hinten");
  });

  it("reads „Nach oben“ / „Nach unten“ on phones", () => {
    const { last } = renderEditor({ device: "mobile" });
    const down = screen.getByRole("button", { name: "„Mein Status“ nach unten verschieben" });
    expect(down).toHaveTextContent("Nach unten");
    expect(screen.getByRole("button", { name: "„Mein Status“ nach oben verschieben" })).toHaveTextContent("Nach oben");
    expect(screen.queryByRole("button", { name: /nach vorne verschieben/ })).toBeNull();
    fireEvent.click(down);
    expect(last()?.map((item) => item.id)).toEqual(["my_tasks", "my_status", "notifications"]);
  });

  it("gives every tile one drag handle with its German name", () => {
    renderEditor();
    for (const title of ["Mein Status", "Meine Aufgaben", "Benachrichtigungen"]) {
      expect(within(tile(title)).getAllByRole("button", { name: `„${title}“ verschieben` })).toHaveLength(1);
    }
  });
});

describe("DashboardEditor — size and removal", () => {
  it("the size radios change the span on the device's grid", () => {
    const { last } = renderEditor({ device: "desktop" });
    const status = tile("Mein Status");
    expect(status).toHaveAttribute("data-span", "2");
    expect(within(status).getByRole("radio", { name: "Mittel" })).toBeChecked();

    fireEvent.click(within(status).getByRole("radio", { name: "Groß" }));
    expect(last()?.[0]).toEqual({ id: "my_status", size: "large" });
    expect(tile("Mein Status")).toHaveAttribute("data-span", "3");

    fireEvent.click(within(tile("Mein Status")).getByRole("radio", { name: "Klein" }));
    expect(tile("Mein Status")).toHaveAttribute("data-span", "1");
  });

  it("labels the radiogroup „Größe“", () => {
    renderEditor();
    expect(within(tile("Mein Status")).getByRole("radiogroup", { name: "Größe" })).toBeInTheDocument();
  });

  it("shows the per-device size hint on phones and tablets only", () => {
    const phone = "Auf dem Handy sind alle Widgets gleich breit. Die Größe bestimmt, wie viel ein Widget zeigt.";
    const tablet = "Auf dem Tablet sind Mittel und Groß gleich breit; Groß zeigt mehr.";

    renderEditor({ device: "mobile" });
    expect(screen.getAllByText(phone)).toHaveLength(3);
    cleanup();

    renderEditor({ device: "tablet" });
    expect(screen.getAllByText(tablet)).toHaveLength(3);
    cleanup();

    renderEditor({ device: "desktop" });
    expect(screen.queryByText(phone)).toBeNull();
    expect(screen.queryByText(tablet)).toBeNull();
  });

  it("removes without a confirm and announces it", () => {
    const { last } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "„Meine Aufgaben“ entfernen" }));
    expect(last()?.map((item) => item.id)).toEqual(["my_status", "notifications"]);
    expect(screen.queryByRole("group", { name: "Meine Aufgaben" })).toBeNull();
    expect(screen.getByText("„Meine Aufgaben“ entfernt.")).toBeInTheDocument();
  });
});

describe("DashboardEditor — adding", () => {
  it("lists only available widgets not yet placed, under their group headings", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Widget hinzufügen" }));
    const dialog = screen.getByRole("dialog", { name: "Widget hinzufügen" });

    const offered = within(dialog)
      .getAllByRole("button", { name: /hinzufügen$/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(offered).toEqual(["„Schnellzugriff“ hinzufügen", "„Lager-Kennzahlen“ hinzufügen"]);

    const headings = within(dialog).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Schnellzugriff", "Werkstatt"]);
    // A widget the user may not see is never offered.
    expect(within(dialog).queryByText("Wer ist eingestempelt")).toBeNull();
  });

  it("adds at the end, at its default size, and announces it", () => {
    const { last } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Widget hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "„Schnellzugriff“ hinzufügen" }));

    expect(last()?.slice(-1)[0]).toEqual({ id: "shortcuts", size: "large" });
    expect(tileOrder()).toEqual(["my_status", "my_tasks", "notifications", "shortcuts"]);
    expect(screen.getByText("„Schnellzugriff“ hinzugefügt.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so when everything available is already placed", () => {
    renderEditor({ availableIds: ["my_status", "my_tasks", "notifications"] });
    fireEvent.click(screen.getByRole("button", { name: "Widget hinzufügen" }));
    expect(
      within(screen.getByRole("dialog")).getByText("Alle verfügbaren Widgets sind schon auf deiner Startseite."),
    ).toBeInTheDocument();
  });

  it("closes the dialog with Escape and with „Schließen“", () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Widget hinzufügen" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Widget hinzufügen" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("DashboardEditor — focus after a move", () => {
  // Without a drag the move buttons are the only way to reorder; a keyboard
  // user presses one again and again, so the focus must stay with the tile.
  it("stays on the pressed button when its own tile is moved", () => {
    // Browsers drop the focus of an element that is moved in the DOM, and
    // React 18 moves a keyed tile with insertBefore; jsdom keeps the focus,
    // so the browser's behaviour is put back here. (React itself focuses the
    // element again after the commit; this holds that in place.)
    const insertBefore = Node.prototype.insertBefore;
    vi.spyOn(Node.prototype, "insertBefore").mockImplementation(function <T extends Node>(this: Node, node: T, child: Node | null): T {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && node.contains(focused)) focused.blur();
      return insertBefore.call(this, node, child) as T;
    });
    renderEditor();
    const back = screen.getByRole("button", { name: "„Mein Status“ nach hinten verschieben" });
    back.focus();
    fireEvent.click(back);

    expect(tileOrder()).toEqual(["my_tasks", "my_status", "notifications"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "„Mein Status“ nach hinten verschieben" }));
  });

  it("goes to the tile's other move button when the pressed one is disabled at the end", () => {
    renderEditor();
    const back = screen.getByRole("button", { name: "„Meine Aufgaben“ nach hinten verschieben" });
    back.focus();
    fireEvent.click(back);
    expect(tileOrder()).toEqual(["my_status", "notifications", "my_tasks"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "„Meine Aufgaben“ nach vorne verschieben" }));

    const forward = screen.getByRole("button", { name: "„Benachrichtigungen“ nach vorne verschieben" });
    forward.focus();
    fireEvent.click(forward);
    expect(tileOrder()).toEqual(["notifications", "my_status", "my_tasks"]);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "„Benachrichtigungen“ nach hinten verschieben" }),
    );
  });
});

describe("DashboardEditor — role defaults", () => {
  it("marks tiles the role cannot see", () => {
    renderEditor({ hiddenIds: new Set<DashboardWidgetId>(["my_tasks"]) });
    expect(
      within(tile("Meine Aufgaben")).getByText("Für diese Rolle unsichtbar (fehlende Berechtigung)"),
    ).toBeInTheDocument();
    expect(within(tile("Mein Status")).queryByText(/Für diese Rolle unsichtbar/)).toBeNull();
  });

  it("offers no „Kacheln wählen“ while the shortcuts have no settings editor", () => {
    renderEditor({ widgets: [{ id: "shortcuts", size: "large" }] });
    expect(screen.queryByRole("button", { name: "Kacheln wählen" })).toBeNull();
  });
});

describe("DashboardEditor — „Kacheln wählen“", () => {
  it("opens the shortcuts' settings editor in the tile and stores what it picks", () => {
    const seen: (DashboardSettingsEditorProps["settings"])[] = [];
    registry.settingsEditor = function FakeTileChooser({ settings, onChange, device }: DashboardSettingsEditorProps) {
      seen.push(settings);
      return (
        <button type="button" onClick={() => onChange({ views: ["time", "wiki"] })}>
          {`Kacheln für ${device}`}
        </button>
      );
    };
    const { last } = renderEditor({
      widgets: [{ id: "shortcuts", size: "large", settings: { views: ["planning"] } }, { id: "my_tasks", size: "small" }],
    });

    expect(within(tile("Meine Aufgaben")).queryByRole("button", { name: "Kacheln wählen" })).toBeNull();
    const toggle = within(tile("Schnellzugriff")).getByRole("button", { name: "Kacheln wählen" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "Kacheln für desktop" }));
    expect(seen[0]).toEqual({ views: ["planning"] });
    expect(last()?.[0]).toEqual({ id: "shortcuts", size: "large", settings: { views: ["time", "wiki"] } });
    expect(last()?.[1]).toEqual({ id: "my_tasks", size: "small" });
  });

  it("keeps a failed download of the tile chooser inside the tile, with a retry", async () => {
    // React (dev) reports an error a boundary caught to the console and to
    // jsdom's window; both are expected here.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", swallow);
    registry.settingsEditor = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    renderEditor({ widgets: [{ id: "shortcuts", size: "large" }, { id: "my_tasks", size: "small" }] });

    fireEvent.click(within(tile("Schnellzugriff")).getByRole("button", { name: "Kacheln wählen" }));
    expect(await within(tile("Schnellzugriff")).findByText("Konnte nicht geladen werden.")).toBeInTheDocument();
    expect(tile("Meine Aufgaben")).toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalledWith("dashboard: a part failed to load", "settings:shortcuts", "Error");

    // The registry forgets a failed import, so the next ask is a new download.
    registry.settingsEditor = function TileChooser() {
      return <p>Kacheln-Auswahl</p>;
    };
    fireEvent.click(within(tile("Schnellzugriff")).getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Kacheln-Auswahl")).toBeInTheDocument();
    window.removeEventListener("error", swallow);
    errorSpy.mockRestore();
  });
});
