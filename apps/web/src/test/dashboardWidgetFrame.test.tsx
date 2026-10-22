/**
 * The card every start-page widget sits in.
 *
 * The frame owns the states a widget must not get wrong on its own (docs/
 * DASHBOARD.md §8.4): a figure nobody fetched is never shown as „0“ — the
 * house rule from useWerkstattOverview — a failed load says so and offers a
 * retry, data from before a failed refresh is labelled „Nicht aktuell“, a 403
 * reads „Keine Berechtigung.“ instead of an error to retry forever, and a list
 * cut at its size limit links on with „+n weitere“.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";

import { AppContext, type AppContextValue } from "../context/AppContext";
import { DashboardWidgetFrame } from "../components/dashboard/DashboardWidgetFrame";
import { makeAppContextStub } from "./appContextStub";

function renderFrame(element: ReactElement, language: "de" | "en" = "de") {
  const context = makeAppContextStub({ overrides: { language } }) as AppContextValue;
  return render(<AppContext.Provider value={context}>{element}</AppContext.Provider>);
}

const LOADED = { loading: false, error: null };

describe("DashboardWidgetFrame", () => {
  it("names its region by the title and shows the body once loaded", () => {
    renderFrame(
      <DashboardWidgetFrame title="Meine Ausleihen" badge={2} state={LOADED}>
        <p>Bohrhammer</p>
      </DashboardWidgetFrame>,
    );

    const region = screen.getByRole("region", { name: "Meine Ausleihen" });
    expect(within(region).getByText("Bohrhammer")).toBeInTheDocument();
    expect(within(region).getByText("2")).toBeInTheDocument();
  });

  it("shows skeleton rows while loading, and never a „0“ — neither body nor badge", () => {
    const { container } = renderFrame(
      <DashboardWidgetFrame title="Lager-Kennzahlen" badge={0} state={{ loading: true, error: null }} more={{ count: 4, onClick: vi.fn() }}>
        <strong>0</strong>
      </DashboardWidgetFrame>,
    );

    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(container.querySelectorAll(".dashboard-widget__skeleton-row").length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/\d/);
    expect(screen.queryByRole("button", { name: /weitere/ })).toBeNull();
  });

  it("hides a badge of 0 once loaded, and any badge while loading", () => {
    const { rerender, container } = renderFrame(
      <DashboardWidgetFrame title="Ungelesene Chats" badge={0} state={LOADED}>
        <p>Keine</p>
      </DashboardWidgetFrame>,
    );
    expect(container.querySelector(".dashboard-widget__badge")).toBeNull();

    rerender(
      <AppContext.Provider value={makeAppContextStub() as AppContextValue}>
        <DashboardWidgetFrame title="Ungelesene Chats" badge={5} state={{ loading: true, error: null }} />
      </AppContext.Provider>,
    );
    expect(container.querySelector(".dashboard-widget__badge")).toBeNull();
  });

  it("says a load failed and retries on request, without the body", () => {
    const onRetry = vi.fn();
    renderFrame(
      <DashboardWidgetFrame title="Fällige Prüfungen" state={{ loading: false, error: "Bad Gateway", onRetry }}>
        <p>Inhalt</p>
      </DashboardWidgetFrame>,
    );

    expect(screen.getByText("Konnte nicht geladen werden.")).toBeInTheDocument();
    expect(screen.queryByText("Inhalt")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the body under a „Nicht aktuell“ badge when a refresh failed after a good load", () => {
    renderFrame(
      <DashboardWidgetFrame title="Wer ist eingestempelt" state={{ loading: false, error: null, stale: true }}>
        <p>Mara Beispiel</p>
      </DashboardWidgetFrame>,
    );

    expect(screen.getByText("Nicht aktuell")).toBeInTheDocument();
    expect(screen.getByText("Mara Beispiel")).toBeInTheDocument();
  });

  it("reads „Keine Berechtigung.“ on a 403, with nothing to retry and no body", () => {
    renderFrame(
      <DashboardWidgetFrame
        title="Offene Urlaubsanträge"
        badge={3}
        state={{ loading: false, error: "Forbidden", forbidden: true, onRetry: vi.fn() }}
        more={{ count: 2, onClick: vi.fn() }}
      >
        <p>Antrag</p>
      </DashboardWidgetFrame>,
    );

    expect(screen.getByText("Keine Berechtigung.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).toBeNull();
    expect(screen.queryByText("Antrag")).toBeNull();
    expect(screen.queryByText("3")).toBeNull();
    expect(screen.queryByRole("button", { name: /weitere/ })).toBeNull();
  });

  it("shows the empty copy instead of the body", () => {
    renderFrame(
      <DashboardWidgetFrame title="Meine Ausleihen" state={LOADED} isEmpty emptyText="Du hast nichts ausgeliehen.">
        <ul />
      </DashboardWidgetFrame>,
    );

    expect(screen.getByText("Du hast nichts ausgeliehen.")).toBeInTheDocument();
  });

  it("links on with „+n weitere“ when more rows exist, and not for zero", () => {
    const onMore = vi.fn();
    const { container, rerender } = renderFrame(
      <DashboardWidgetFrame title="Nachbestellen" state={LOADED} more={{ count: 4, onClick: onMore }}>
        <p>Kabel</p>
      </DashboardWidgetFrame>,
    );

    fireEvent.click(screen.getByRole("button", { name: "+4 weitere" }));
    expect(onMore).toHaveBeenCalledTimes(1);

    rerender(
      <AppContext.Provider value={makeAppContextStub() as AppContextValue}>
        <DashboardWidgetFrame title="Nachbestellen" state={LOADED} more={{ count: 0, onClick: onMore }}>
          <p>Kabel</p>
        </DashboardWidgetFrame>
      </AppContext.Provider>,
    );
    expect(container.textContent).not.toContain("weitere");
  });

  it("offers the header link to the full page", () => {
    const onClick = vi.fn();
    renderFrame(
      <DashboardWidgetFrame title="Neueste Berichte" action={{ label: "Alle anzeigen", onClick }} state={LOADED}>
        <p>Bericht #12</p>
      </DashboardWidgetFrame>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Alle anzeigen" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the body when no state is given (context-fed widgets)", () => {
    renderFrame(
      <DashboardWidgetFrame title="Meine Aufgaben">
        <p>Aufgabe 1</p>
      </DashboardWidgetFrame>,
    );

    expect(screen.getByText("Aufgabe 1")).toBeInTheDocument();
  });

  it("speaks English in the English UI", () => {
    renderFrame(
      <>
        <DashboardWidgetFrame title="A" state={{ loading: false, error: "x", onRetry: vi.fn() }} />
        <DashboardWidgetFrame title="B" state={{ loading: false, error: null, stale: true }} more={{ count: 2, onClick: vi.fn() }} />
        <DashboardWidgetFrame title="C" state={{ loading: false, error: null, forbidden: true }} />
      </>,
      "en",
    );

    expect(screen.getByText("Could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByText("Not up to date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+2 more" })).toBeInTheDocument();
    expect(screen.getByText("No permission.")).toBeInTheDocument();
  });
});
