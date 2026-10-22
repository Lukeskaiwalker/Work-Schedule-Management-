/**
 * „Anpassen“ when the editor's chunk cannot be downloaded (docs/DASHBOARD.md
 * §9.1, §9.7).
 *
 * The edit mode is its own lazy chunk. A tablet that kept the app open across
 * a deploy asks for a hashed file that no longer exists, and a building-site
 * connection drops requests. Either way the failure must stay on the start
 * page — not replace the whole app with the app-wide error screen — and
 * „Erneut versuchen“ must download the chunk again (React.lazy remembers a
 * rejected import for good).
 *
 * The mocked edit-mode module fails as often as `editMode.failures` says,
 * then loads for real. Each test re-registers that mock and re-imports the
 * app modules, so neither a module loaded by an earlier test nor the host's
 * cached lazy editor carries over.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DASHBOARD_WIDGET_IDS, type DashboardDevice, type DashboardWidgetItem } from "../types/dashboard";
import { stubWidth } from "./matchMediaStub";

const editMode = { failures: 0 };

vi.mock("../components/dashboard/widgetRegistry", () => {
  const widgets: Record<string, (props: { size: string; device: string }) => JSX.Element> = {
    my_status: ({ size, device }) => <p>{`Status ${size} ${device}`}</p>,
    my_tasks: ({ size, device }) => <p>{`Tasks ${size} ${device}`}</p>,
  };
  return { getLazyWidget: (id: string) => widgets[id] ?? null, getLazySettingsEditor: () => null };
});

// Invented data only: the repository is public.
const USER = { id: 1, email: "lena@example.com", role: "employee", display_name: "Lena Beispiel" };

function layout(device: DashboardDevice, widgets: DashboardWidgetItem[]) {
  return { device, version: 1, source: "builtin", updated_at: null, role_changed: false, widgets };
}

const STATE = {
  layouts: {
    mobile: layout("mobile", [{ id: "my_status", size: "medium" }]),
    tablet: layout("tablet", [{ id: "my_status", size: "medium" }]),
    desktop: layout("desktop", [
      { id: "my_tasks", size: "large" },
      { id: "my_status", size: "small" },
    ]),
  },
  available_widgets: ["my_status", "my_tasks"],
  default_sizes: Object.fromEntries(DASHBOARD_WIDGET_IDS.map((id) => [id, "medium"])),
};

let endSession: () => void = () => undefined;

async function renderFreshHost() {
  vi.resetModules();
  vi.doMock("../components/dashboard/DashboardEditMode", async (importOriginal) => {
    if (editMode.failures > 0) {
      editMode.failures -= 1;
      throw new Error("Failed to fetch dynamically imported module");
    }
    return importOriginal();
  });
  const { AppContext } = await import("../context/AppContext");
  const { DashboardHost } = await import("../components/dashboard/DashboardHost");
  const drafts = await import("../utils/dashboardDrafts");
  const session = await import("../utils/dashboardSession");
  const { makeAppContextStub } = await import("./appContextStub");
  endSession = session.endDashboardSession;
  const context = makeAppContextStub({ overrides: { language: "de", token: "test-token", user: USER } });
  return {
    drafts,
    render: () =>
      render(
        <AppContext.Provider value={context as never}>
          <DashboardHost />
        </AppContext.Provider>,
      ),
  };
}

function silenceExpectedErrors() {
  // React (dev) reports an error a boundary caught to the console and to
  // jsdom's window; both are expected here and would only add noise.
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const swallow = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener("error", swallow);
  return {
    warnSpy,
    restore: () => {
      window.removeEventListener("error", swallow);
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

async function pressCustomise() {
  const customise = await screen.findByRole("button", { name: "Startseite anpassen" });
  await waitFor(() => expect(customise).toBeEnabled());
  fireEvent.click(customise);
}

afterEach(() => {
  cleanup();
  endSession();
  editMode.failures = 0;
  vi.unstubAllGlobals();
});

describe("DashboardHost — the editor's chunk fails to load", () => {
  it("says so on the page, and „Erneut versuchen“ downloads it again", async () => {
    const { warnSpy, restore } = silenceExpectedErrors();
    stubWidth(1440);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(STATE), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    editMode.failures = 1;
    const host = await renderFreshHost();
    host.render();

    await pressCustomise();

    expect(await screen.findByText("Editor konnte nicht geladen werden.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Startseite" })).toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalledWith("dashboard: a part failed to load", "edit-mode", "Error");

    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByRole("heading", { name: "Startseite anpassen · Desktop" })).toBeInTheDocument();
    restore();
  });

  it("„Schließen“ goes back to the page and keeps a restored draft for the next „Anpassen“", async () => {
    const { restore } = silenceExpectedErrors();
    stubWidth(1440);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(STATE), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    editMode.failures = 1;
    const host = await renderFreshHost();
    const draft: DashboardWidgetItem[] = [{ id: "my_tasks", size: "large" }];
    host.drafts.rememberDraft(USER.id, "desktop", draft);
    host.render();

    // The remembered draft reopens edit mode at once, and its chunk fails.
    expect(await screen.findByText("Editor konnte nicht geladen werden.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Schließen" }));

    expect(await screen.findByText("Status small desktop")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-host--editing")).toBeNull();
    expect(host.drafts.takeDraft(USER.id, "desktop")).toEqual(draft);

    await pressCustomise();
    expect(await screen.findByRole("heading", { name: "Startseite anpassen · Desktop" })).toBeInTheDocument();
    expect(screen.getByText("Deine nicht gespeicherten Änderungen sind wiederhergestellt.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Mein Status" })).toBeNull();
    restore();
  });
});
