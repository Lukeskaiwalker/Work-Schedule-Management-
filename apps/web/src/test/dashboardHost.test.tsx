/**
 * The start page as a whole: which layout a width gets, edit mode, saving,
 * resetting, drafts, role changes, and what happens when parts fail
 * (docs/DASHBOARD.md §8, §9.1, §12 W1).
 *
 * `fetch` is a small fake of the /api/dashboard routes, and the widget
 * registry is mocked with a handful of fake widgets, so this file tests the
 * host and not the widgets (W3–W5 own those). A fake widget prints its id,
 * size and device, which is how the tests tell the layouts apart.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../components/dashboard/widgetRegistry", async () => {
  const { useDashboardResource } = await import("../hooks/useDashboardResource");
  const { ApiError } = await import("../api/client");
  type Props = { size: string; device: string };
  const forbiddenLoader = async () => {
    throw new ApiError("Forbidden", 403, "Forbidden");
  };
  const widgets: Record<string, (props: Props) => JSX.Element> = {
    my_status: ({ size, device }) => <p>{`Status ${size} ${device}`}</p>,
    my_tasks: ({ size, device }) => <p>{`Tasks ${size} ${device}`}</p>,
    notifications: () => {
      throw new Error("widget crashed");
    },
    my_vacation: function ForbiddenWidget() {
      const resource = useDashboardResource("test:forbidden", forbiddenLoader, { pollMs: null });
      return <p>{resource.forbidden ? "Keine Berechtigung." : "Urlaub lädt"}</p>;
    },
  };
  return {
    getLazyWidget: (id: string) => widgets[id] ?? null,
    getLazySettingsEditor: () => null,
  };
});

import { AppContext, type AppContextValue } from "../context/AppContext";
import { DashboardHost } from "../components/dashboard/DashboardHost";
import { DashboardGrid, DashboardGridItem } from "../components/dashboard/DashboardGrid";
import { takeDraft } from "../utils/dashboardDrafts";
import { endDashboardSession } from "../utils/dashboardSession";
import type { DashboardDevice, DashboardLayout, DashboardState, DashboardWidgetItem } from "../types/dashboard";
import { DASHBOARD_WIDGET_IDS } from "../types/dashboard";
import { makeAppContextStub } from "./appContextStub";
import { stubWidth } from "./matchMediaStub";

// ── Fake server ────────────────────────────────────────────────────────────

type Call = { method: string; url: string; body: unknown };

function layoutOf(device: DashboardDevice, widgets: DashboardWidgetItem[], extra: Partial<DashboardLayout> = {}): DashboardLayout {
  return { device, version: 1, source: "builtin", updated_at: null, role_changed: false, widgets, ...extra };
}

const BUILTIN: Record<DashboardDevice, DashboardWidgetItem[]> = {
  mobile: [{ id: "my_status", size: "medium" }],
  tablet: [
    { id: "my_status", size: "medium" },
    { id: "my_tasks", size: "small" },
  ],
  desktop: [
    { id: "my_tasks", size: "large" },
    { id: "my_status", size: "small" },
  ],
};

function dashboard(layouts: Partial<Record<DashboardDevice, DashboardLayout>> = {}): DashboardState {
  return {
    layouts: {
      mobile: layoutOf("mobile", BUILTIN.mobile),
      tablet: layoutOf("tablet", BUILTIN.tablet),
      desktop: layoutOf("desktop", BUILTIN.desktop),
      ...layouts,
    },
    available_widgets: ["shortcuts", "my_status", "my_tasks", "my_vacation", "notifications"],
    default_sizes: Object.fromEntries(DASHBOARD_WIDGET_IDS.map((id) => [id, "medium"])) as DashboardState["default_sizes"],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

type Override = (call: Call) => Response | Promise<Response>;

function createServer(initial: DashboardState = dashboard()) {
  const calls: Call[] = [];
  const overrides: Partial<Record<string, Override[]>> = {};
  let state = initial;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = {
        method: init.method ?? "GET",
        url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      const once = overrides[call.method]?.shift();
      if (once) return once(call);
      const device = /\/layouts\/(\w+)$/.exec(url)?.[1] as DashboardDevice | undefined;
      if (call.method === "GET" && url === "/api/dashboard") return json(state);
      if (call.method === "PUT" && device) {
        const saved = layoutOf(device, (call.body as { widgets: DashboardWidgetItem[] }).widgets, {
          source: "user",
          updated_at: "2026-10-21T18:40:12Z",
        });
        state = { ...state, layouts: { ...state.layouts, [device]: saved } };
        return json(saved);
      }
      if (call.method === "DELETE" && device) {
        const resolved = layoutOf(device, BUILTIN[device]);
        state = { ...state, layouts: { ...state.layouts, [device]: resolved } };
        return json(resolved);
      }
      return json({ detail: "Not Found" }, 404);
    }),
  );

  return {
    calls,
    /** The next `method` request answers with `respond` instead of the default. */
    once(method: string, respond: Override) {
      overrides[method] = [...(overrides[method] ?? []), respond];
    },
    setState(next: DashboardState) {
      state = next;
    },
    writes: () => calls.filter((call) => call.method !== "GET"),
    gets: () => calls.filter((call) => call.method === "GET" && call.url === "/api/dashboard"),
  };
}

// ── Rendering ──────────────────────────────────────────────────────────────

function context(token: string | null = "test-token"): AppContextValue {
  return makeAppContextStub({
    overrides: {
      language: "de",
      token,
      user: { id: 1, email: "test@example.com", role: "employee", display_name: "Test" },
    },
  }) as AppContextValue;
}

function renderHost() {
  return render(
    <AppContext.Provider value={context()}>
      <DashboardHost />
    </AppContext.Provider>,
  );
}

const host = () => document.querySelector<HTMLElement>(".dashboard-host");

async function enterEditMode(device: string) {
  const customise = await screen.findByRole("button", { name: "Startseite anpassen" });
  await waitFor(() => expect(customise).toBeEnabled());
  fireEvent.click(customise);
  return screen.findByRole("heading", { name: `Startseite anpassen · ${device}` });
}

function silenceExpectedErrors() {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const swallow = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener("error", swallow);
  return () => {
    window.removeEventListener("error", swallow);
    errorSpy.mockRestore();
  };
}

afterEach(() => {
  cleanup();
  endDashboardSession();
  try {
    localStorage.clear();
  } catch {
    // A test may have made storage throw; restoreAllMocks below undoes it.
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("DashboardHost — which layout", () => {
  it("renders the phone layout at a phone width", async () => {
    stubWidth(390);
    createServer();
    renderHost();
    expect(await screen.findByText("Status medium mobile")).toBeInTheDocument();
    expect(screen.queryByText(/^Tasks/)).toBeNull();
    expect(host()?.querySelector(".dashboard-grid")).toHaveAttribute("data-device", "mobile");
  });

  it("renders the desktop layout at a desktop width", async () => {
    stubWidth(1440);
    createServer();
    renderHost();
    expect(await screen.findByText("Tasks large desktop")).toBeInTheDocument();
    expect(screen.getByText("Status small desktop")).toBeInTheDocument();
    expect(host()?.querySelector(".dashboard-grid")).toHaveAttribute("data-device", "desktop");
  });

  it("takes columns from the device it is given, not from the screen", () => {
    stubWidth(1440);
    render(
      <DashboardGrid device="mobile">
        <DashboardGridItem size="large" device="mobile">
          <p>Inhalt</p>
        </DashboardGridItem>
      </DashboardGrid>,
    );
    const grid = document.querySelector(".dashboard-grid");
    expect(grid).toHaveAttribute("data-device", "mobile");
    expect(grid?.querySelector(".dashboard-grid__item")).toHaveAttribute("data-span", "1");
  });

  it("skips an id this build has no widget for", async () => {
    stubWidth(1440);
    createServer(
      dashboard({ desktop: layoutOf("desktop", [{ id: "werkstatt_boxes", size: "small" }, { id: "my_status", size: "small" }]) }),
    );
    renderHost();
    expect(await screen.findByText("Status small desktop")).toBeInTheDocument();
    expect(host()?.querySelectorAll(".dashboard-grid__item")).toHaveLength(1);
  });

  it("says when the layout is empty", async () => {
    stubWidth(1440);
    createServer(dashboard({ desktop: layoutOf("desktop", [], { source: "user" }) }));
    renderHost();
    expect(
      await screen.findByText("Deine Startseite ist leer. Über „Anpassen“ fügst du Widgets hinzu."),
    ).toBeInTheDocument();
  });
});

describe("DashboardHost — failures", () => {
  it("shows the load error with a retry that loads the page", async () => {
    stubWidth(1440);
    const server = createServer();
    server.once("GET", () => json({ detail: "boom" }, 500));
    renderHost();
    expect(await screen.findByText("Startseite konnte nicht geladen werden.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Tasks large desktop")).toBeInTheDocument();
    expect(server.gets()).toHaveLength(2);
  });

  it("contains a crashing widget in its own frame; the others still render", async () => {
    const restore = silenceExpectedErrors();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubWidth(1440);
    createServer(
      dashboard({
        desktop: layoutOf("desktop", [{ id: "notifications", size: "small" }, { id: "my_status", size: "small" }]),
      }),
    );
    renderHost();
    expect(await screen.findByText("Status small desktop")).toBeInTheDocument();
    const crashed = screen.getByRole("region", { name: "Benachrichtigungen" });
    expect(within(crashed).getByText("Konnte nicht geladen werden.")).toBeInTheDocument();
    expect(within(crashed).getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
    // The id and the error's name only — never the message, which can carry widget data.
    expect(warn).toHaveBeenCalledWith("dashboard: a widget crashed", "notifications", "Error");
    expect(warn.mock.calls.flat()).not.toContain("widget crashed");
    restore();
  });

  it("refetches the layouts once when a widget's data answers 403", async () => {
    stubWidth(1440);
    const server = createServer(
      dashboard({ desktop: layoutOf("desktop", [{ id: "my_vacation", size: "small" }, { id: "my_status", size: "small" }]) }),
    );
    renderHost();
    expect(await screen.findByText("Keine Berechtigung.")).toBeInTheDocument();
    await waitFor(() => expect(server.gets()).toHaveLength(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(server.gets()).toHaveLength(2);
  });
});

describe("DashboardHost — cold start", () => {
  const SEED = {
    version: 1,
    layouts: {
      mobile: [{ id: "my_tasks", size: "small" }],
      tablet: [{ id: "my_tasks", size: "small" }],
      desktop: [{ id: "my_status", size: "large" }],
    },
  };

  it("renders the stored layout before the server answers, then the server's", async () => {
    stubWidth(1440);
    localStorage.setItem("smpl_dashboard_layouts:1", JSON.stringify(SEED));
    let answer: (response: Response) => void = () => undefined;
    const server = createServer();
    server.once("GET", () => new Promise<Response>((resolve) => (answer = resolve)));
    renderHost();

    expect(screen.getByText("Status large desktop")).toBeInTheDocument();
    // Editing waits for the server: the stored copy knows no source or permissions.
    expect(screen.getByRole("button", { name: "Startseite anpassen" })).toBeDisabled();

    await act(async () => answer(json(dashboard())));
    expect(await screen.findByText("Tasks large desktop")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Startseite anpassen" })).toBeEnabled();
  });

  it("stores ids, sizes and settings only, per user", async () => {
    stubWidth(1440);
    createServer(
      dashboard({
        desktop: layoutOf("desktop", [{ id: "shortcuts", size: "large", settings: { views: ["time", "wiki"] } }], {
          source: "user",
          updated_at: "2026-10-21T18:40:12Z",
        }),
      }),
    );
    renderHost();
    await waitFor(() => expect(localStorage.getItem("smpl_dashboard_layouts:1")).not.toBeNull());
    const stored = JSON.parse(localStorage.getItem("smpl_dashboard_layouts:1") ?? "null");
    expect(stored).toEqual({
      version: 1,
      layouts: {
        mobile: BUILTIN.mobile,
        tablet: BUILTIN.tablet,
        desktop: [{ id: "shortcuts", size: "large", settings: { views: ["time", "wiki"] } }],
      },
    });
  });

  it("works the same when storage throws on every access", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    stubWidth(1440);
    createServer();
    renderHost();
    expect(await screen.findByText("Tasks large desktop")).toBeInTheDocument();
  });
});

describe("DashboardHost — edit mode", () => {
  it("„Anpassen“, remove, „Fertig“ sends one PUT with the remaining widgets", async () => {
    stubWidth(1440);
    const server = createServer();
    renderHost();
    await enterEditMode("Desktop");
    expect(host()).toHaveClass("dashboard-host--editing");

    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toEqual({
      method: "PUT",
      url: "/api/dashboard/layouts/desktop",
      body: { version: 1, widgets: [{ id: "my_tasks", size: "large" }] },
    });
    await waitFor(() => expect(host()).not.toHaveClass("dashboard-host--editing"));
    expect(screen.getByText("Tasks large desktop")).toBeInTheDocument();
    expect(screen.queryByText("Status small desktop")).toBeNull();
  });

  it("keeps an edit made while „Fertig“ is saving, and the next „Fertig“ saves it", async () => {
    stubWidth(1440);
    const server = createServer();
    let release: () => void = () => undefined;
    server.once("PUT", (call) =>
      new Promise<Response>((resolve) => {
        const { widgets } = call.body as { widgets: DashboardWidgetItem[] };
        release = () => resolve(json(layoutOf("desktop", widgets, { source: "user", updated_at: "2026-10-21T18:40:12Z" })));
      }),
    );
    renderHost();
    await enterEditMode("Desktop");
    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));

    // A slow site connection: one more change while the PUT is on its way.
    fireEvent.click(screen.getByRole("button", { name: "Widget hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "„Urlaub“ hinzufügen" }));
    await act(async () => release());

    expect(await screen.findByText("Persönlich angepasst")).toBeInTheDocument();
    expect(host()).toHaveClass("dashboard-host--editing");
    expect(screen.getByRole("group", { name: "Urlaub" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
    await waitFor(() => expect(server.writes()).toHaveLength(2));
    expect(server.writes()[1].body).toEqual({
      version: 1,
      widgets: [
        { id: "my_tasks", size: "large" },
        { id: "my_vacation", size: "medium" },
      ],
    });
    await waitFor(() => expect(host()).not.toHaveClass("dashboard-host--editing"));
  });

  it("an unchanged „Fertig“ sends nothing and leaves edit mode", async () => {
    stubWidth(1440);
    const server = createServer();
    renderHost();
    await enterEditMode("Desktop");
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
    await waitFor(() => expect(host()).not.toHaveClass("dashboard-host--editing"));
    expect(server.writes()).toEqual([]);
  });

  it("„Abbrechen“ drops the changes", async () => {
    stubWidth(1440);
    const server = createServer();
    renderHost();
    await enterEditMode("Desktop");
    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(host()).not.toHaveClass("dashboard-host--editing"));
    expect(screen.getByText("Status small desktop")).toBeInTheDocument();
    expect(server.writes()).toEqual([]);
  });

  it("shows where the layout came from", async () => {
    stubWidth(1440);
    createServer(dashboard({ desktop: layoutOf("desktop", BUILTIN.desktop, { source: "user" }) }));
    renderHost();
    await enterEditMode("Desktop");
    expect(screen.getByText("Persönlich angepasst")).toBeInTheDocument();
  });

  it("freezes the device it started on: a resize mid-edit still saves the tablet layout", async () => {
    const width = stubWidth(1024);
    const server = createServer();
    renderHost();
    await enterEditMode("Tablet");

    await act(async () => {
      width.resize(1440);
      await new Promise((resolve) => setTimeout(resolve, 260));
    });
    expect(screen.getByRole("heading", { name: "Startseite anpassen · Tablet" })).toBeInTheDocument();
    expect(host()?.querySelector(".dashboard-grid")).toHaveAttribute("data-device", "tablet");

    fireEvent.click(screen.getByRole("button", { name: "„Meine Aufgaben“ entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0].url).toBe("/api/dashboard/layouts/tablet");
    expect(await screen.findByText("Für Tablet gespeichert.")).toBeInTheDocument();
    expect(host()?.querySelector(".dashboard-grid")).toHaveAttribute("data-device", "desktop");
    expect(screen.getByText("Tasks large desktop")).toBeInTheDocument();
  });
});

describe("DashboardHost — save errors", () => {
  it("a generic failure shows the save error and stays in edit mode", async () => {
    stubWidth(1440);
    const server = createServer();
    server.once("PUT", () => json({ detail: "boom" }, 500));
    renderHost();
    await enterEditMode("Desktop");
    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));

    expect(
      await screen.findByText("Startseite konnte nicht gespeichert werden. Bitte erneut versuchen."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Startseite anpassen · Desktop" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Mein Status" })).toBeNull();
  });

  it("another 422 with an object detail shows the server's message", async () => {
    stubWidth(1440);
    const server = createServer();
    server.once("PUT", () =>
      json({ detail: { code: "duplicate_widget", message: "Widget „my_tasks“ ist doppelt.", ids: ["my_tasks"] } }, 422),
    );
    renderHost();
    await enterEditMode("Desktop");
    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));
    expect(await screen.findByText("Widget „my_tasks“ ist doppelt.")).toBeInTheDocument();
  });

  it("422 unknown_widget refetches, prunes the draft and asks to check it", async () => {
    stubWidth(1440);
    const server = createServer();
    renderHost();
    await enterEditMode("Desktop");

    fireEvent.click(screen.getByRole("button", { name: "Widget hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "„Urlaub“ hinzufügen" }));
    expect(screen.getByRole("group", { name: "Urlaub" })).toBeInTheDocument();

    // The server no longer knows my_vacation (it was retired in between).
    const retired = dashboard();
    const { my_vacation: _gone, ...sizes } = retired.default_sizes;
    server.setState({
      ...retired,
      available_widgets: retired.available_widgets.filter((id) => id !== "my_vacation"),
      default_sizes: sizes as DashboardState["default_sizes"],
    });
    server.once("PUT", () =>
      json({ detail: { code: "unknown_widget", message: "Widget „my_vacation“ gibt es nicht.", ids: ["my_vacation"] } }, 422),
    );
    fireEvent.click(screen.getByRole("button", { name: "Fertig" }));

    expect(
      await screen.findByText(
        "Einige Widgets gibt es nicht mehr. Wir haben sie aus deinem Entwurf entfernt – bitte prüfe ihn und speichere erneut.",
      ),
    ).toBeInTheDocument();
    expect(server.gets()).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "Urlaub" })).toBeNull();
    expect(screen.getByRole("group", { name: "Meine Aufgaben" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Startseite anpassen · Desktop" })).toBeInTheDocument();
  });
});

describe("DashboardHost — reset", () => {
  it("is disabled while the layout is the role's or the built-in default", async () => {
    stubWidth(1440);
    createServer(dashboard({ desktop: layoutOf("desktop", BUILTIN.desktop, { source: "role" }) }));
    renderHost();
    await enterEditMode("Desktop");
    expect(screen.getByText("Standard deiner Rolle")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auf Standard zurücksetzen" })).toBeDisabled();
  });

  it("asks first, then sends the DELETE and leaves edit mode with the resolved layout", async () => {
    stubWidth(1440);
    const server = createServer(
      dashboard({ desktop: layoutOf("desktop", [{ id: "my_status", size: "large" }], { source: "user" }) }),
    );
    renderHost();
    await enterEditMode("Desktop");

    fireEvent.click(screen.getByRole("button", { name: "Auf Standard zurücksetzen" }));
    const confirm = screen.getByRole("alertdialog");
    expect(
      within(confirm).getByText(
        "Startseite für Desktop auf den Standard deiner Rolle zurücksetzen? Deine Anpassungen für diese Gerätegröße gehen verloren.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(server.writes()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Auf Standard zurücksetzen" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Zurücksetzen" }));

    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ method: "DELETE", url: "/api/dashboard/layouts/desktop" });
    await waitFor(() => expect(host()).not.toHaveClass("dashboard-host--editing"));
    expect(screen.getByText("Tasks large desktop")).toBeInTheDocument();
  });
});

describe("DashboardHost — drafts", () => {
  it("reopens a dirty draft after leaving the page, with the restored notice", async () => {
    stubWidth(1440);
    const server = createServer();
    const first = renderHost();
    await enterEditMode("Desktop");
    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));
    first.unmount();

    renderHost();
    expect(await screen.findByRole("heading", { name: "Startseite anpassen · Desktop" })).toBeInTheDocument();
    expect(screen.getByText("Deine nicht gespeicherten Änderungen sind wiederhergestellt.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Mein Status" })).toBeNull();
    expect(screen.getByRole("group", { name: "Meine Aufgaben" })).toBeInTheDocument();
    expect(server.writes()).toEqual([]);
  });

  it("writes no draft back after the session ended under an open editor", async () => {
    stubWidth(1440);
    createServer();
    const view = renderHost();
    await enterEditMode("Desktop");
    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));

    // A caller that clears the caches while the tree still holds the token:
    // the host renders once more with it (and a layouts entry re-seeded from
    // localStorage), then once without it, before it unmounts.
    act(() => endDashboardSession());
    view.rerender(
      <AppContext.Provider value={context(null)}>
        <DashboardHost />
      </AppContext.Provider>,
    );

    expect(takeDraft(1, "desktop")).toBeNull();
  });

  it("forgets the draft after „Abbrechen“", async () => {
    stubWidth(1440);
    createServer();
    const first = renderHost();
    await enterEditMode("Desktop");
    fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    first.unmount();

    renderHost();
    expect(await screen.findByText("Status small desktop")).toBeInTheDocument();
    expect(host()).not.toHaveClass("dashboard-host--editing");
  });
});

describe("DashboardHost — role change", () => {
  const changed = () =>
    dashboard({ desktop: layoutOf("desktop", [{ id: "my_status", size: "large" }], { source: "user", role_changed: true }) });
  const NOTICE = "Deine Rolle wurde geändert. Möchtest du die Startseite deiner neuen Rolle übernehmen?";

  it("„Übernehmen“ sends the DELETE", async () => {
    stubWidth(1440);
    const server = createServer(changed());
    renderHost();
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toMatchObject({ method: "DELETE", url: "/api/dashboard/layouts/desktop" });
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    expect(screen.getByText("Tasks large desktop")).toBeInTheDocument();
  });

  it("„Behalten“ re-saves the current widgets with a PUT", async () => {
    stubWidth(1440);
    const server = createServer(changed());
    renderHost();
    fireEvent.click(await screen.findByRole("button", { name: "Behalten" }));
    await waitFor(() => expect(server.writes()).toHaveLength(1));
    expect(server.writes()[0]).toEqual({
      method: "PUT",
      url: "/api/dashboard/layouts/desktop",
      body: { version: 1, widgets: [{ id: "my_status", size: "large" }] },
    });
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
  });

  it("is not shown on a device whose layout was saved under the current role", async () => {
    stubWidth(390);
    createServer(changed());
    renderHost();
    expect(await screen.findByText("Status medium mobile")).toBeInTheDocument();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
