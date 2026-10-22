/**
 * The hook a widget reads its data through.
 *
 * It is the store (dashboardResourceStore.test.ts) seen from React: the token
 * and user come from the app context, two widgets on one key share a request,
 * leaving „Start“ and coming back renders the cached answer in the first
 * paint, and a widget that is switched off asks for nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { AppContext, type AppContextValue } from "../context/AppContext";
import { useDashboardResource, type DashboardResourceOptions } from "../hooks/useDashboardResource";
import type { DashboardResourceLoader } from "../utils/dashboardResourceStore";
import { endDashboardSession } from "../utils/dashboardSession";
import { makeAppContextStub } from "./appContextStub";

type Payload = { label: string };

function Probe({ resourceKey, loader, options, name }: {
  resourceKey: string;
  loader: DashboardResourceLoader<Payload>;
  options: DashboardResourceOptions;
  name: string;
}) {
  const resource = useDashboardResource(resourceKey, loader, options);
  const state = resource.forbidden
    ? "forbidden"
    : resource.loading
      ? "loading"
      : resource.error
        ? "error"
        : resource.data
          ? `data:${resource.data.label}`
          : "idle";
  return (
    <div>
      <span data-testid={name}>{state}</span>
      <button type="button" onClick={resource.reload}>{`reload-${name}`}</button>
    </div>
  );
}

function contextFor(userId: number | null, token = "test-token"): AppContextValue {
  return makeAppContextStub({
    overrides: { token, user: userId === null ? null : { id: userId, email: "a@example.com", role: "employee" } },
  }) as AppContextValue;
}

afterEach(() => {
  endDashboardSession();
});

describe("useDashboardResource", () => {
  it("shows loading first, then the data, and passes the context token to the loader", async () => {
    const loader = vi.fn<DashboardResourceLoader<Payload>>(async () => ({ label: "Lager" }));

    render(
      <AppContext.Provider value={contextFor(1, "token-a")}>
        <Probe name="one" resourceKey="werkstatt:dashboard" loader={loader} options={{ pollMs: 120_000 }} />
      </AppContext.Provider>,
    );

    expect(screen.getByTestId("one").textContent).toBe("loading");
    expect(await screen.findByText("data:Lager")).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0][0]).toBe("token-a");
  });

  it("lets two widgets on one key share a single request", async () => {
    const loader = vi.fn<DashboardResourceLoader<Payload>>(async () => ({ label: "geteilt" }));

    render(
      <AppContext.Provider value={contextFor(1)}>
        <Probe name="one" resourceKey="time:current" loader={loader} options={{ pollMs: 30_000 }} />
        <Probe name="two" resourceKey="time:current" loader={loader} options={{ pollMs: 600_000 }} />
      </AppContext.Provider>,
    );

    expect(await screen.findAllByText("data:geteilt")).toHaveLength(2);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("renders the cached answer at once after leaving and coming back, without a request", async () => {
    const loader = vi.fn<DashboardResourceLoader<Payload>>(async () => ({ label: "Cache" }));
    const tree = (
      <AppContext.Provider value={contextFor(1)}>
        <Probe name="one" resourceKey="werkstatt:dashboard" loader={loader} options={{ pollMs: 120_000 }} />
      </AppContext.Provider>
    );

    const first = render(tree);
    await screen.findByText("data:Cache");
    first.unmount();

    render(tree);
    expect(screen.getByTestId("one").textContent).toBe("data:Cache");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("asks nothing and reads idle while switched off", async () => {
    const loader = vi.fn<DashboardResourceLoader<Payload>>(async () => ({ label: "nie" }));

    render(
      <AppContext.Provider value={contextFor(1)}>
        <Probe name="one" resourceKey="time:vacation-requests:own" loader={loader} options={{ pollMs: 600_000, enabled: false }} />
      </AppContext.Provider>,
    );
    await act(async () => undefined);

    expect(screen.getByTestId("one").textContent).toBe("idle");
    expect(loader).not.toHaveBeenCalled();
  });

  it("asks nothing without a signed-in user", async () => {
    const loader = vi.fn<DashboardResourceLoader<Payload>>(async () => ({ label: "nie" }));

    render(
      <AppContext.Provider value={contextFor(null)}>
        <Probe name="one" resourceKey="time:current" loader={loader} options={{ pollMs: 30_000 }} />
      </AppContext.Provider>,
    );
    await act(async () => undefined);

    expect(screen.getByTestId("one").textContent).toBe("idle");
    expect(loader).not.toHaveBeenCalled();
  });

  it("asks nothing without a token, so a sign-out render cannot refill a cache", async () => {
    const loader = vi.fn<DashboardResourceLoader<Payload>>(async () => ({ label: "nie" }));
    const context = makeAppContextStub({
      overrides: { token: null, user: { id: 1, email: "a@example.com", role: "employee" } },
    }) as AppContextValue;

    render(
      <AppContext.Provider value={context}>
        <Probe name="one" resourceKey="time:current" loader={loader} options={{ pollMs: 30_000 }} />
      </AppContext.Provider>,
    );
    await act(async () => undefined);

    expect(screen.getByTestId("one").textContent).toBe("idle");
    expect(loader).not.toHaveBeenCalled();
  });

  it("reload asks again", async () => {
    let count = 0;
    const loader = vi.fn<DashboardResourceLoader<Payload>>(async () => ({ label: `run-${++count}` }));

    render(
      <AppContext.Provider value={contextFor(1)}>
        <Probe name="one" resourceKey="reports:recent" loader={loader} options={{ pollMs: 60_000 }} />
      </AppContext.Provider>,
    );
    await screen.findByText("data:run-1");
    act(() => screen.getByText("reload-one").click());

    expect(await screen.findByText("data:run-2")).toBeInTheDocument();
  });

  it("keeps two users' caches apart", async () => {
    const loader = vi.fn<DashboardResourceLoader<Payload>>(async (token) => ({ label: String(token) }));

    const first = render(
      <AppContext.Provider value={contextFor(1, "token-one")}>
        <Probe name="one" resourceKey="time:current" loader={loader} options={{ pollMs: 30_000 }} />
      </AppContext.Provider>,
    );
    await screen.findByText("data:token-one");
    first.unmount();

    render(
      <AppContext.Provider value={contextFor(2, "token-two")}>
        <Probe name="two" resourceKey="time:current" loader={loader} options={{ pollMs: 30_000 }} />
      </AppContext.Provider>,
    );
    expect(screen.getByTestId("two").textContent).toBe("loading");
    expect(await screen.findByText("data:token-two")).toBeInTheDocument();
  });
});
