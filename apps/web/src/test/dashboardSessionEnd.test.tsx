/**
 * The start page forgets everything when the session ends, and nothing
 * brings it back (docs/DASHBOARD.md §8.2, §9.3, §13).
 *
 * The harness ends a session the way App does: `setToken(null)` — from a
 * click (sign-out) or from outside any React event (a 401, the expiry timer)
 * — with `useDashboardSessionEnd(token)` mounted, and the user cleared one
 * commit later by an effect on the token. Workshop tablets are shared: what
 * must not survive is one person's widget data, a request sent with their
 * dead token, or their unsaved editor draft reopening at the next sign-in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";

vi.mock("../components/dashboard/widgetRegistry", () => {
  const widgets: Record<string, (props: { size: string; device: string }) => JSX.Element> = {
    my_status: ({ size, device }) => <p>{`Status ${size} ${device}`}</p>,
    my_tasks: ({ size, device }) => <p>{`Tasks ${size} ${device}`}</p>,
  };
  return { getLazyWidget: (id: string) => widgets[id] ?? null, getLazySettingsEditor: () => null };
});

import { AppContext, type AppContextValue } from "../context/AppContext";
import { DashboardHost } from "../components/dashboard/DashboardHost";
import { useDashboardResource } from "../hooks/useDashboardResource";
import { useDashboardSessionEnd } from "../hooks/useDashboardSessionEnd";
import { DASHBOARD_WIDGET_IDS, type DashboardDevice, type DashboardWidgetItem } from "../types/dashboard";
import { takeDraft } from "../utils/dashboardDrafts";
import type { DashboardResourceLoader } from "../utils/dashboardResourceStore";
import { endDashboardSession } from "../utils/dashboardSession";
import { makeAppContextStub } from "./appContextStub";
import { stubWidth } from "./matchMediaStub";

// Invented data only: the repository is public.
const USER = { id: 1, email: "kim@example.com", role: "employee", display_name: "Kim Beispiel" };

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

function serveDashboard() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(STATE), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
}

function contextFor(token: string | null, user: typeof USER | null): AppContextValue {
  return makeAppContextStub({ overrides: { language: "de", token, user } }) as AppContextValue;
}

// ── The App's session handling, in miniature ──────────────────────────────

const session = { end: (): void => undefined };

function Session({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>("token-a");
  const [user, setUser] = useState<typeof USER | null>(USER);
  // As App's /auth/me effect: the user goes one commit after the token.
  useEffect(() => {
    if (!token) setUser(null);
  }, [token]);
  useDashboardSessionEnd(token);
  session.end = () => setToken(null);
  return (
    <>
      <button type="button" onClick={() => session.end()}>
        Abmelden
      </button>
      {user ? <AppContext.Provider value={contextFor(token, user)}>{children}</AppContext.Provider> : <p>Anmelden</p>}
    </>
  );
}

/** A 401 or the expiry timer: no React event around it. */
async function expireOutsideAnEvent() {
  await act(async () => {
    await Promise.resolve();
    session.end();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

const loader = vi.fn<DashboardResourceLoader<{ token: string | null }>>(async (token) => ({ token }));

function Probe() {
  const resource = useDashboardResource("time:current", loader, { pollMs: 30_000 });
  return <span data-testid="probe">{resource.data ? `data:${resource.data.token}` : "none"}</span>;
}

async function openEditorAndRemoveStatus() {
  const customise = await screen.findByRole("button", { name: "Startseite anpassen" });
  await waitFor(() => expect(customise).toBeEnabled());
  fireEvent.click(customise);
  await screen.findByRole("heading", { name: "Startseite anpassen · Desktop" });
  fireEvent.click(screen.getByRole("button", { name: "„Mein Status“ entfernen" }));
  expect(takeDraft(USER.id, "desktop")).not.toBeNull();
}

function remountAsTheSameUser() {
  cleanup();
  render(
    <AppContext.Provider value={contextFor("token-b", USER)}>
      <DashboardHost />
    </AppContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  endDashboardSession();
  loader.mockClear();
  try {
    localStorage.clear();
  } catch {
    // Nothing stored is fine.
  }
  vi.unstubAllGlobals();
});

describe("ending the session", () => {
  it("a 401 sends nothing more with the dead token, and the widget data is gone", async () => {
    render(
      <Session>
        <Probe />
      </Session>,
    );
    expect(await screen.findByText("data:token-a")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);

    await expireOutsideAnEvent();

    expect(screen.getByText("Anmelden")).toBeInTheDocument();
    expect(loader.mock.calls.map(([token]) => token)).toEqual(["token-a"]);

    cleanup();
    render(
      <AppContext.Provider value={contextFor("token-b", USER)}>
        <Probe />
      </AppContext.Provider>,
    );
    // The next sign-in on this device starts empty, not with the last answer.
    expect(screen.getByTestId("probe").textContent).toBe("none");
    expect(await screen.findByText("data:token-b")).toBeInTheDocument();
  });

  it("signing out with the editor open leaves no draft to reopen", async () => {
    stubWidth(1440);
    serveDashboard();
    render(
      <Session>
        <DashboardHost />
      </Session>,
    );
    await openEditorAndRemoveStatus();

    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    await screen.findByText("Anmelden");

    expect(takeDraft(USER.id, "desktop")).toBeNull();
    remountAsTheSameUser();
    expect(await screen.findByText("Tasks large desktop")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-host--editing")).toBeNull();
    expect(screen.queryByText("Deine nicht gespeicherten Änderungen sind wiederhergestellt.")).toBeNull();
  });

  it("an expired session with the editor open leaves no draft either", async () => {
    stubWidth(1440);
    serveDashboard();
    render(
      <Session>
        <DashboardHost />
      </Session>,
    );
    await openEditorAndRemoveStatus();

    await expireOutsideAnEvent();

    expect(screen.getByText("Anmelden")).toBeInTheDocument();
    expect(takeDraft(USER.id, "desktop")).toBeNull();
  });
});
